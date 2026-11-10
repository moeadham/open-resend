import { Buffer } from "node:buffer";
import {
  applyD1Migrations,
  env,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Resend } from "resend";
import { parseEmail } from "../src/parse-email";
import worker from "../src/index";
import { apiApp } from "../src/api";
import { adminApp } from "../src/admin";
import { sha256, nowIso } from "../src/lib";
import type { QueueBody } from "../src/types";

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    async resolve4() {
      return ["93.184.216.34"];
    }
    async resolve6() {
      return [];
    }
  },
}));
const key = "re_transactional_contract";
let captured: { url: string; headers: Headers; body: string }[] = [];
let resend: Resend;
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO api_keys(id,name,prefix,key_hash,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(
      "transactional-key",
      "Email client",
      "re_transactional",
      await sha256(key),
      nowIso(),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO domains(id,name,cloudflare_enabled,created_at) VALUES('transactional-domain','example.com',1,?)",
  )
    .bind(nowIso())
    .run();
  await env.DB.prepare(
    "INSERT INTO receiving_domains(name,zone_id,status,created_at) VALUES('example.com','zone','verified',?)",
  )
    .bind(nowIso())
    .run();
  captured = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "receiver.example.org") {
        captured.push({
          url: request.url,
          headers: request.headers,
          body: await request.text(),
        });
        return Response.json({ accepted: true });
      }
      return apiApp.fetch(request, env);
    },
  );
  resend = new Resend(key);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function incoming(
  extraHeaders = "",
  attachment = true,
  authenticationResults?: string,
): ForwardableEmailMessage {
  const source = [
    "From: Jane <jane@example.net>",
    "To: calendar@example.com",
    "Subject: Calendar invitation",
    "Message-ID: <calendar-contract@example.net>",
    "Date: Mon, 2 Nov 2026 12:00:00 +0900",
    extraHeaders,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="contract"',
    "",
    "--contract",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please add this event.",
    ...(attachment
      ? [
          "--contract",
          "Content-Type: text/calendar; charset=utf-8",
          'Content-Disposition: attachment; filename="invite.ics"',
          "Content-Transfer-Encoding: base64",
          "",
          "QkVHSU46VkNBTEVOREFSDQpFTkQ6VkNBTEVOREFSDQo=",
        ]
      : []),
    "--contract--",
    "",
  ]
    .filter((s, i) => s !== "" || i > 7)
    .join("\r\n");
  const bytes = new TextEncoder().encode(source);
  return {
    from: "bounce@example.net",
    to: "calendar@example.com",
    headers: new Headers({
      subject: "Calendar invitation",
      ...(authenticationResults
        ? { "authentication-results": authenticationResults }
        : {}),
    }),
    raw: new Response(bytes).body!,
    rawSize: bytes.length,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  };
}
async function dispatch(queue: string, body: QueueBody, bindings: Env = env) {
  const batch = createMessageBatch<QueueBody>(queue, [
    { id: "job", timestamp: new Date(), attempts: 1, body },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, bindings);
  return getQueueResult(batch, ctx);
}

describe("transactional Resend SDK contract", () => {
  it("shows the Resend email object instead of MIME source in the admin Raw tab", async () => {
    const sent = await resend.emails.send({
      from: "Calendar <calendar@example.com>",
      to: "jane@example.net",
      subject: "Admin raw JSON",
      html: "<p>Confirmed</p>",
      text: "Confirmed",
    });
    expect(sent.error).toBeNull();

    const response = await adminApp.fetch(
      new Request(`http://localhost/emails/${sent.data!.id}?view=raw`),
      env,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("&quot;object&quot;: &quot;email&quot;");
    expect(html).toContain(`&quot;id&quot;: &quot;${sent.data!.id}&quot;`);
    expect(html).toContain("&quot;subject&quot;: &quot;Admin raw JSON&quot;");
    expect(html).not.toContain("MIME-Version:");
  });

  it("creates a queued email idempotently and preserves MIME, CC, BCC, threading and binary attachments", async () => {
    const message = {
      from: "Calendar <calendar@example.com>",
      to: ["jane@example.net"],
      cc: ["copy@example.net"],
      bcc: ["private@example.net"],
      replyTo: ["one@example.net", "two@example.net"],
      subject: "Your event",
      html: "<p>Confirmed 日本語</p>",
      headers: { "In-Reply-To": "<thread@example.net>" },
      attachments: [
        {
          filename: "invite.ics",
          content: "QkVHSU46VkNBTEVOREFSDQo=",
          contentType: "text/calendar",
        },
        {
          filename: "binary.pdf",
          content: Buffer.from([255, 0, 1]),
          contentType: "application/pdf",
        },
      ],
    };
    const result = await resend.emails.send(message, {
      idempotencyKey: "calendar-once",
    });
    expect(result.error).toBeNull();
    expect(result.data?.id).toMatch(/^[0-9a-f-]{36}$/);
    const replay = await resend.emails.send(message, {
      idempotencyKey: "calendar-once",
    });
    expect(replay.data).toEqual(result.data);
    const changed = await resend.emails.send(
      { ...message, subject: "Changed" },
      { idempotencyKey: "calendar-once" },
    );
    expect(changed.error?.name).toBe("invalid_idempotent_request");
    const detail = await resend.emails.get(result.data!.id);
    expect(detail.data).toMatchObject({
      from: message.from,
      subject: message.subject,
      html: message.html,
      cc: message.cc,
      bcc: message.bcc,
      reply_to: message.replyTo,
      last_event: "queued",
    });
    const raw = await env.EMAIL_STORAGE.get(
      `emails/${result.data!.id}/raw.eml`,
    );
    const parsed = await parseEmail(new Uint8Array(await raw!.arrayBuffer()));
    expect(parsed.html).toBe(message.html);
    expect(parsed.headers.find((h) => h.key === "in-reply-to")?.value).toBe(
      "<thread@example.net>",
    );
    expect(parsed.bcc).toBeUndefined();
    expect(parsed.attachments[0]?.filename).toBe("invite.ics");
    expect(
      new TextDecoder().decode(parsed.attachments[0]!.content as ArrayBuffer),
    ).toBe("BEGIN:VCALENDAR\r\n");
    expect(
      new Uint8Array(parsed.attachments[1]!.content as ArrayBuffer),
    ).toEqual(new Uint8Array([255, 0, 1]));
    const send = vi.fn(async () => ({ messageId: "provider-contract" }));
    const sendingEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "EMAIL"
          ? { send }
          : Reflect.get(target, property, receiver);
      },
    });
    await dispatch(
      env.DELIVERY_QUEUE_NAME,
      { transactionalId: result.data!.id },
      sendingEnv,
    );
    expect(send).toHaveBeenCalledTimes(3);
    await dispatch(
      env.DELIVERY_QUEUE_NAME,
      { transactionalId: result.data!.id },
      sendingEnv,
    );
    expect(send).toHaveBeenCalledTimes(3);
    expect((await resend.emails.get(result.data!.id)).data?.last_event).toBe(
      "sent",
    );
  });
  it("rejects unauthenticated sends, unverified domains and unsupported scheduling", async () => {
    const response = await apiApp.request(
      "https://api.example.com/emails",
      { method: "POST", body: "{}" },
      env,
    );
    expect(response.status).toBe(401);
    const data = {
      from: "sender@elsewhere.example",
      to: "jane@example.net",
      subject: "Test",
      text: "Hello",
    };
    expect((await resend.emails.send(data)).error).toMatchObject({
      name: "validation_error",
    });
    expect(
      (
        await resend.emails.send({
          ...data,
          from: "calendar@example.com",
          scheduledAt: "in 1 hour",
        })
      ).error?.message,
    ).toContain("not supported");
  });
  it("persists inbound content before a verifiable callback and serves byte-exact attachments", async () => {
    const webhook = await resend.webhooks.create({
      endpoint: "https://receiver.example.org/webhook",
      events: ["email.received"],
    });
    expect(webhook.error).toBeNull();
    const secret = webhook.data!.signing_secret;
    await worker.email(
      incoming(
        [
          "Received: from sender.example by attacker.example",
          "Received: by sender.example with SMTP",
          "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
        ].join("\r\n"),
      ),
      env,
    );
    const event = await env.DB.prepare(
      "SELECT id,payload FROM webhook_events",
    ).first<{ id: string; payload: string }>();
    const payload = JSON.parse(event!.payload);
    const id = payload.data.email_id;
    const retrieved = await resend.emails.receiving.get(id);
    expect(retrieved.error).toBeNull();
    expect(retrieved.data).toMatchObject({
      object: "email",
      id,
      from: "jane@example.net",
      to: ["calendar@example.com"],
      cc: [],
      bcc: [],
      reply_to: [],
      subject: "Calendar invitation",
      message_id: "<calendar-contract@example.net>",
      html: null,
      text: "Please add this event.",
      html_format: "data_uri",
      received_for: [],
      authentication: {
        spf: "unknown",
        dkim: "unknown",
        dmarc: "unknown",
      },
      raw: {
        download_url: expect.any(String),
        expires_at: expect.any(String),
      },
      attachments: [
        {
          id: expect.any(String),
          filename: "invite.ics",
          content_type: "text/calendar",
          content_disposition: "attachment",
          content_id: null,
          size: 32,
        },
      ],
      created_at: expect.any(String),
      last_event: "received",
    });
    expect(retrieved.data?.headers?.["authentication-results"]).toBeUndefined();
    expect(JSON.parse(retrieved.data!.headers!.received!)).toEqual(
      [
        "from sender.example by attacker.example",
        "by sender.example with SMTP",
      ],
    );
    const attachment = await resend.emails.receiving.attachments.get({
      emailId: id,
      id: payload.data.attachments[0].id,
    });
    expect(attachment.error).toBeNull();
    expect(attachment.data).toMatchObject({
      object: "attachment",
      filename: "invite.ics",
      content_type: "text/calendar",
    });
    const download = await fetch(attachment.data!.download_url);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    const tampered = new URL(attachment.data!.download_url);
    tampered.searchParams.set("signature", "bad");
    expect((await fetch(tampered)).status).toBe(403);
    const delivery = await env.DB.prepare(
      "SELECT id FROM webhook_deliveries",
    ).first<{ id: string }>();
    await dispatch(env.WEBHOOK_QUEUE_NAME, { webhookDeliveryId: delivery!.id });
    expect(
      await env.DB.prepare(
        "SELECT http_status,response_body FROM webhook_attempts",
      ).first(),
    ).toEqual({ http_status: 200, response_body: '{"accepted":true}' });
    expect(captured).toHaveLength(1);
    const callback = captured[0]!;
    const verified = resend.webhooks.verify({
      payload: callback.body,
      headers: {
        id: callback.headers.get("svix-id")!,
        timestamp: callback.headers.get("svix-timestamp")!,
        signature: callback.headers.get("svix-signature")!,
      },
      webhookSecret: secret,
    });
    expect(verified).toMatchObject({
      type: "email.received",
      data: { email_id: id },
    });
    await dispatch(env.WEBHOOK_QUEUE_NAME, { webhookDeliveryId: delivery!.id });
    expect(captured).toHaveLength(1);
    const lists = await resend.emails.receiving.list();
    expect(lists.data?.data[0]?.id).toBe(id);
  });
  it("rejects unknown receiving domains", async () => {
    const rejected = incoming();
    Object.defineProperty(rejected, "to", {
      value: "calendar@unknown.example",
    });
    await worker.email(rejected, env);
    expect(rejected.setReject).toHaveBeenCalledWith(
      expect.stringContaining("not enabled"),
    );
  });
});

// These exercise failure/recovery contracts through the public SDK and Worker handlers.
describe("transactional recovery and retention", () => {
  it("retries failed callbacks, preserves event identity on replay, and stops disabled endpoints", async () => {
    const hook = await resend.webhooks.create({
      endpoint: "https://receiver.example.org/webhook",
      events: ["email.received"],
    });
    await worker.email(incoming(), env);
    const delivery = await env.DB.prepare(
      "SELECT id,event_id FROM webhook_deliveries",
    ).first<{ id: string; event_id: string }>();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "receiver.example.org")
          return new Response("temporarily unavailable", { status: 503 });
        return originalFetch(input, init);
      },
    );
    await dispatch(env.WEBHOOK_QUEUE_NAME, { webhookDeliveryId: delivery!.id });
    expect(
      await env.DB.prepare(
        "SELECT status,attempts FROM webhook_deliveries",
      ).first(),
    ).toEqual({ status: "pending", attempts: 1 });
    await resend.webhooks.update(hook.data!.id, { status: "disabled" });
    await env.DB.prepare("UPDATE webhook_deliveries SET next_attempt_at=?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    await dispatch(env.WEBHOOK_QUEUE_NAME, { webhookDeliveryId: delivery!.id });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_attempts").first(
        "n",
      ),
    ).toBe(1);
    await resend.webhooks.update(hook.data!.id, { status: "enabled" });
    vi.stubGlobal("fetch", originalFetch);
    await dispatch(env.WEBHOOK_QUEUE_NAME, { webhookDeliveryId: delivery!.id });
    expect(captured).toHaveLength(1);
    const before = captured[0]!;
    const replay = await worker.fetch(
      new Request(
        `http://localhost/webhooks/${hook.data!.id}/replay/${delivery!.event_id}`,
        { method: "POST", headers: { Origin: "http://localhost" } },
      ),
      env,
    );
    expect(replay.status).toBe(303);
    await dispatch(env.WEBHOOK_QUEUE_NAME, { webhookDeliveryId: delivery!.id });
    expect(captured).toHaveLength(2);
    expect(captured[1]!.body).toBe(before.body);
    expect(captured[1]!.headers.get("svix-id")).toBe(
      before.headers.get("svix-id"),
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_attempts").first(
        "n",
      ),
    ).toBe(3);
  });
  it("hides expired emails immediately and cleans their R2 objects and webhook payloads", async () => {
    await resend.webhooks.create({
      endpoint: "https://receiver.example.org/webhook",
      events: ["email.received"],
    });
    await worker.email(incoming(), env);
    const row = await env.DB.prepare(
      "SELECT id FROM transactional_emails",
    ).first<{ id: string }>();
    const detail = await resend.emails.receiving.get(row!.id);
    const rawUrl = detail.data!.raw!.download_url;
    await env.DB.prepare("UPDATE transactional_emails SET expires_at=?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await resend.emails.receiving.get(row!.id)).error?.name).toBe(
      "not_found",
    );
    expect((await fetch(rawUrl)).status).toBe(404);
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "* * * * *", noRetry() {} },
      env,
    );
    expect(
      (await env.EMAIL_STORAGE.list({ prefix: `emails/${row!.id}/` })).objects,
    ).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first(
        "n",
      ),
    ).toBe(0);
  });
  it("rejects private destinations, header injection, malformed JSON, and attachment redirects", async () => {
    for (const endpoint of [
      "http://receiver.example.org/webhook",
      "https://127.0.0.1/webhook",
      "https://[::1]/webhook",
      "https://user:secret@receiver.example.org/webhook",
    ]) {
      expect(
        (await resend.webhooks.create({ endpoint, events: ["email.received"] }))
          .error?.name,
      ).toBe("validation_error");
    }
    const message = {
      from: "calendar@example.com",
      to: "jane@example.net",
      subject: "Test",
      text: "Hello",
    };
    expect(
      (
        await resend.emails.send({
          ...message,
          headers: { "X-Test": "ok\r\nBcc: attacker@example.org" },
        })
      ).error?.name,
    ).toBe("validation_error");
    const invalid = await apiApp.request(
      "https://api.example.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: "{",
      },
      env,
    );
    expect(invalid.status).toBe(400);
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        ).hostname === "receiver.example.org"
          ? new Response(null, {
              status: 302,
              headers: { Location: "https://127.0.0.1/private" },
            })
          : originalFetch(input, init),
    );
    expect(
      (
        await resend.emails.send({
          ...message,
          attachments: [
            {
              filename: "redirect.pdf",
              path: "https://receiver.example.org/file",
            },
          ],
        })
      ).error?.message,
    ).toContain("Redirects");
  });
  it("records provider delivery events and does not send again on duplicate queue delivery", async () => {
    const sent = await resend.emails.send({
      from: "calendar@example.com",
      to: "jane@example.net",
      subject: "Status",
      text: "Hello",
    });
    const send = vi.fn(async () => ({ messageId: "unique-provider-id" }));
    const sendingEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "EMAIL"
          ? { send }
          : Reflect.get(target, property, receiver);
      },
    });
    await dispatch(
      env.DELIVERY_QUEUE_NAME,
      { transactionalId: sent.data!.id },
      sendingEnv,
    );
    await dispatch(env.EMAIL_EVENTS_QUEUE_NAME, {
      type: "message.delivered",
      payload: {
        eventId: "delivered-once",
        messageId: "unique-provider-id",
        recipient: "jane@example.net",
      },
    });
    expect((await resend.emails.get(sent.data!.id)).data?.last_event).toBe(
      "delivered",
    );
    await dispatch(env.EMAIL_EVENTS_QUEUE_NAME, {
      type: "message.delivered",
      payload: { eventId: "delivered-once", messageId: "unique-provider-id" },
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM transactional_events WHERE status='delivered'",
      ).first("n"),
    ).toBe(1);
  });
});

it("supports fwd2cal’s declared Resend 6.4.2 client without a custom adapter", async () => {
  const { Resend: LegacyResend } = await import("resend-legacy");
  const legacy = new LegacyResend(key);
  const sent = await legacy.emails.send({
    from: "calendar@example.com",
    to: "jane@example.net",
    subject: "Legacy client",
    text: "Hello",
  });
  expect(sent.error).toBeNull();
  expect((await legacy.emails.get(sent.data!.id)).data?.subject).toBe(
    "Legacy client",
  );
  const hook = await legacy.webhooks.create({
    endpoint: "https://receiver.example.org/webhook",
    events: ["email.received"],
  });
  expect(hook.data?.signing_secret).toMatch(/^whsec_/);
  await worker.email(
    incoming(
      "",
      true,
      "mx.cloudflare.net; spf=pass smtp.mailfrom=bounce@example.net; dkim=pass header.d=example.net; dmarc=pass header.from=example.net policy.dmarc=reject",
    ),
    env,
  );
  const event = await env.DB.prepare(
    "SELECT payload FROM webhook_events",
  ).first<{ payload: string }>();
  const payload = JSON.parse(event!.payload);
  const mail = await legacy.emails.receiving.get(payload.data.email_id);
  expect(mail.data?.headers?.["authentication-results"]).toBeDefined();
  const attachment = await legacy.emails.receiving.attachments.get({
    emailId: payload.data.email_id,
    id: payload.data.attachments[0].id,
  });
  expect(attachment.data?.download_url).toContain("/email-content/");
});

it.each([
  { header: "spf=fail (attacker says spf=pass) smtp.mailfrom=sender@example.net; dkim=fail header.d=example.net", expected: { spf: "fail", dkim: "fail", dmarc: "unknown" } },
  { header: "dkim=pass header.d=example.net; dmarc=pass header.from=example.net policy.dmarc=reject; spf=none smtp.helo=mail.example.net; spf=pass smtp.mailfrom=bounce@example.net", expected: { spf: "pass", dkim: "pass", dmarc: "pass" } },
  { header: 'spf=none (untrusted; spf=pass smtp.mailfrom=attacker); spf=fail smtp.mailfrom=sender@example.net; dkim=fail header.d=example.net reason="untrusted; dkim=pass"', expected: { spf: "fail", dkim: "fail", dmarc: "unknown" } },
  { header: "dkim=pass header.d=example.net; dmarc=pass header.from=example.net policy.dmarc=none; spf=none smtp.helo=mail.example.net; spf=pass smtp.mailfrom=bounce@example.net", expected: { spf: "pass", dkim: "pass", dmarc: "gray" } },
  { header: "dkim=pass header.d=mailer.other.example; dmarc=fail header.from=example.net; spf=softfail smtp.mailfrom=bounce@example.net", expected: { spf: "gray", dkim: "gray", dmarc: "fail" } },
])("canonicalizes the trusted receiver result: $header", async ({header, expected}) => {
  const trustedHeader = `mx.cloudflare.net; ${header}`;
  await worker.email(
    incoming(
      "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
      true,
      trustedHeader,
    ),
    env,
  );
  const received = await resend.emails.receiving.list();
  const detail = await resend.emails.receiving.get(received.data!.data[0]!.id);
  expect(detail.data).toMatchObject({
    authentication: expected,
    headers: {
      "authentication-results": trustedHeader,
    },
  });
});

it("recovers provider events that arrive before the send result and ignores a late deferral after delivery", async () => {
  const sent = await resend.emails.send({
    from: "calendar@example.com",
    to: "jane@example.net",
    subject: "Early event",
    text: "Hello",
  });
  await dispatch(env.EMAIL_EVENTS_QUEUE_NAME, {
    type: "message.delivered",
    payload: {
      eventId: "early-delivery",
      messageId: "early-provider",
      recipient: "jane@example.net",
    },
  });
  const send = vi.fn(async () => ({ messageId: "early-provider" }));
  const sendingEnv = new Proxy(env, {
    get(target, property, receiver) {
      return property === "EMAIL"
        ? { send }
        : Reflect.get(target, property, receiver);
    },
  });
  await dispatch(
    env.DELIVERY_QUEUE_NAME,
    { transactionalId: sent.data!.id },
    sendingEnv,
  );
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: "* * * * *", noRetry() {} },
    env,
  );
  expect((await resend.emails.get(sent.data!.id)).data?.last_event).toBe(
    "delivered",
  );
  await dispatch(env.EMAIL_EVENTS_QUEUE_NAME, {
    type: "message.deferred",
    payload: {
      eventId: "late-deferral",
      messageId: "early-provider",
      recipient: "jane@example.net",
    },
  });
  expect((await resend.emails.get(sent.data!.id)).data?.last_event).toBe(
    "delivered",
  );
});

it("preserves binary attachments, Unicode filenames, CID images and original raw MIME", async () => {
  const source = [
    "From: Jane <jane@example.net>",
    "To: calendar@example.com",
    "Subject: Binary attachments",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="binary"',
    "",
    "--binary",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Invoice</p><img src="cid:logo">',
    "--binary",
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "/wAB",
    "--binary",
    "Content-Type: image/png",
    'Content-Disposition: inline; filename="logo.png"',
    "Content-ID: <logo>",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
    "--binary--",
    "",
  ].join("\r\n");
  const raw = new TextEncoder().encode(source);
  await worker.email(
    { ...incoming(), raw: new Response(raw).body!, rawSize: raw.length },
    env,
  );
  const list = await resend.emails.receiving.list();
  const id = list.data!.data[0]!.id;
  const detail = await resend.emails.receiving.get(id);
  expect(detail.data?.html).toContain("data:image/png;base64,AQID");
  const cid = await apiApp.request(
    `https://api.example.com/emails/receiving/${id}?html_format=cid`,
    { headers: { Authorization: `Bearer ${key}` } },
    env,
  );
  expect(await cid.json()).toMatchObject({
    html_format: "cid",
    html: '<p>Invoice</p><img src="cid:logo">',
  });
  const attachments = await resend.emails.receiving.attachments.list({
    emailId: id,
  });
  const pdf = attachments.data!.data.find((a) => a.filename === "résumé.pdf")!;
  expect(
    new Uint8Array(await (await fetch(pdf.download_url)).arrayBuffer()),
  ).toEqual(new Uint8Array([255, 0, 1]));
  const rawResponse = await fetch(detail.data!.raw!.download_url);
  expect(await rawResponse.text()).toBe(source);
});
