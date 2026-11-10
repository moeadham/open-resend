import { parseEmail } from "./parse-email";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  boundedBytes,
  MAX_EMAIL_BYTES,
  randomSecret,
  RETENTION_MS,
} from "./email-security";
import { nowIso, sha256 } from "./lib";
import {
  objectKey,
  type Attachment,
  type StoredMail,
} from "./transactional-storage";
import { publishWebhookOutbox } from "./webhooks";

// Cloudflare's header-boundary behavior must be verified with a live spoof test before
// enabling INBOUND_AUTH_RESULTS_VERIFIED. A matching authserv-id alone is not proof.
function authentication(
  headers: { key: string; value: string }[],
  verified: boolean,
) {
  const unknown = { spf: "unknown", dkim: "unknown", dmarc: "unknown" };
  if (!verified)
    return {
      authentication: null,
      header: "open-resend; spf=none; dkim=none; dmarc=none",
    };
  const first = headers.find(
    (h) => h.key.toLowerCase() === "authentication-results",
  )?.value;
  if (!first || !/^mx\.cloudflare\.net\s*;/i.test(first))
    return {
      authentication: unknown,
      header: "open-resend; spf=none; dkim=none; dmarc=none",
    };
  // Comments and quoted property values may contain attacker-controlled text.
  // Remove them before splitting receiver-generated authentication methods.
  let clean = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of first) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && (depth || quoted)) {
      escaped = true;
      continue;
    }
    if (!quoted && character === "(") {
      depth++;
      clean += " ";
      continue;
    }
    if (depth) {
      if (character === ")") depth--;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      clean += " ";
      continue;
    }
    if (!quoted) clean += character;
  }
  const methods = clean.split(";").slice(1);
  const values = Object.fromEntries(
    ["spf", "dkim", "dmarc"].map((key) => {
      const results = methods.flatMap(method => {
        const match = method.match(new RegExp(`^\\s*${key}=(pass|fail|softfail|neutral|none|temperror|permerror)\\b`, "i"));
        return match ? [{ result: match[1]!.toLowerCase(), method }] : [];
      });
      // SPF for HELO is distinct from SPF for the envelope sender. Cloudflare
      // can emit both; fwd2cal needs the MAIL FROM result. Any passing DKIM
      // signature authenticates its signing domain; DMARC records alignment.
      const selected = key === "spf"
        ? results.find(result => /\bsmtp\.mailfrom\s*=/i.test(result.method)) ?? results[0]
        : key === "dkim"
          ? results.find(result => result.result === "pass") ?? results[0]
          : results[0];
      const raw = selected?.result;
      return [
        key,
        raw === "pass"
          ? "pass"
          : raw === "fail"
            ? "fail"
            : raw === "temperror" || raw === "permerror"
              ? "processing_failed"
              : raw
                ? "gray"
                : "unknown",
      ];
    }),
  ) as typeof unknown;
  // Build a canonical header: untrusted comments and additional headers cannot smuggle "spf=pass".
  return {
    authentication: values,
    header: `open-resend; spf=${values.spf}; dkim=${values.dkim}; dmarc=${values.dmarc}`,
  };
}
export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const domain = message.to.split("@").at(-1)?.toLowerCase();
  const configured = await env.DB.prepare(
    "SELECT name,addresses_json FROM receiving_domains WHERE name=? AND status='verified'",
  )
    .bind(domain ?? "")
    .first<{ name: string; addresses_json: string }>();
  const allowed = configured
    ? (JSON.parse(configured.addresses_json) as string[])
    : [];
  const recipient = message.to.toLowerCase();
  if (
    !configured ||
    (allowed.length &&
      !allowed.includes(recipient) &&
      !allowed.includes(recipient.replace(/\+[^@]*@/, "@")))
  ) {
    message.setReject("Receiving is not enabled for this domain.");
    return;
  }
  if (message.rawSize > MAX_EMAIL_BYTES) {
    message.setReject("Email exceeds 25 MiB.");
    return;
  }
  const raw = await boundedBytes(message.raw, MAX_EMAIL_BYTES);
  const ingestKey = await sha256(
    `${message.to.toLowerCase()}\n${createHash("sha256").update(raw).digest("hex")}`,
  );
  const existing = await env.DB.prepare(
    "SELECT id FROM transactional_emails WHERE ingest_key=?",
  )
    .bind(ingestKey)
    .first();
  if (existing) {
    await publishWebhookOutbox(env);
    return;
  }
  const parsed = await parseEmail(raw);
  if (parsed.attachments.length > 100) {
    message.setReject("At most 100 attachments are supported.");
    return;
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
  const auth = authentication(
    parsed.headers,
    String(env.INBOUND_AUTH_RESULTS_VERIFIED) === "true",
  );
  const headers: Record<string, string> = {};
  for (const header of parsed.headers)
    if (header.key.toLowerCase() !== "authentication-results")
      headers[header.key.toLowerCase()] = header.value;
  headers["authentication-results"] = auth.header;
  const addresses = (list: typeof parsed.to) =>
    list?.flatMap((a) =>
      "address" in a && a.address
        ? [a.address]
        : "group" in a
          ? (a.group ?? [])
              .map((b) => b.address)
              .filter((v): v is string => Boolean(v))
          : [],
    ) ?? [];
  const attachments: Attachment[] = [];
  const writes: string[] = [];
  const put = async (
    part: string,
    value: Uint8Array | string,
    type: string,
    filename?: string,
  ) => {
    const key = objectKey(id, part);
    writes.push(key);
    await env.EMAIL_STORAGE.put(key, value, {
      customMetadata: { expires_at: expiresAt },
      httpMetadata: {
        contentType: type,
        contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename ?? part)}`,
      },
    });
  };
  try {
    await put("raw.eml", raw, "message/rfc822", "email.eml");
    for (const attachment of parsed.attachments) {
      const attachmentId = crypto.randomUUID();
      const bytes =
        typeof attachment.content === "string"
          ? Buffer.from(attachment.content, "base64")
          : new Uint8Array(attachment.content);
      attachments.push({
        id: attachmentId,
        filename: attachment.filename ?? null,
        size: bytes.byteLength,
        content_type: attachment.mimeType,
        content_disposition: attachment.disposition ?? null,
        content_id: attachment.contentId?.replace(/^<|>$/g, "") ?? null,
      });
      await put(
        `attachment-${attachmentId}`,
        bytes,
        attachment.mimeType,
        attachment.filename ?? "attachment",
      );
    }
    const mail: StoredMail = {
      from: parsed.from?.address ?? message.from,
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      bcc: addresses(parsed.bcc),
      reply_to: addresses(parsed.replyTo),
      subject: parsed.subject ?? "",
      html: parsed.html ?? null,
      text: parsed.text ?? null,
      headers,
      message_id: parsed.messageId ?? null,
      attachments,
      authentication: auth.authentication,
      received_for: parsed.headers
        .filter((h) => h.key === "received")
        .flatMap((h) =>
          [...h.value.matchAll(/\bfor\s+<?([^\s;<>]+@[^\s;<>]+)>?/gi)].map(
            (m) => m[1]!,
          ),
        ),
    };
    // Envelope recipient is only used as a fallback; preserve visible recipient headers.
    if (!mail.to.length) mail.to = [message.to];
    await put("content.json", JSON.stringify(mail), "application/json");
    const eventId = `msg_${crypto.randomUUID()}`;
    const payload = JSON.stringify({
      type: "email.received",
      created_at: now,
      data: {
        email_id: id,
        created_at: now,
        from: mail.from,
        to: mail.to,
        cc: mail.cc,
        bcc: mail.bcc,
        received_for: mail.received_for,
        message_id: mail.message_id,
        subject: mail.subject,
        attachments: attachments.map(({ size, ...a }) => a),
      },
    });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO transactional_emails(id,direction,from_value,to_json,subject,status,created_at,expires_at,download_secret,ingest_key) VALUES(?,'receiving',?,?,?,'received',?,?,?,?)",
      ).bind(
        id,
        mail.from,
        JSON.stringify(mail.to),
        mail.subject,
        now,
        expiresAt,
        randomSecret(),
        ingestKey,
      ),
      env.DB.prepare(
        "INSERT INTO webhook_events(id,email_id,payload,created_at) VALUES(?,?,?,?)",
      ).bind(eventId, id, payload, now),
      env.DB.prepare(
        "INSERT INTO webhook_deliveries(id,webhook_id,event_id,next_attempt_at) SELECT lower(hex(randomblob(16))),id,?,? FROM webhooks WHERE status='enabled'",
      ).bind(eventId, now),
    ]);
  } catch (error) {
    await env.EMAIL_STORAGE.delete(writes);
    throw error;
  }
  // A queue outage does not lose the persisted event; the scheduled outbox will recover it.
  try {
    await publishWebhookOutbox(env);
  } catch (error) {
    console.error(
      "Webhook outbox publishing deferred",
      error instanceof Error ? error.message : "queue unavailable",
    );
  }
}
