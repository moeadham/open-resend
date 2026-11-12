import { parseEmail } from "./parse-email";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  boundedBytes,
  MAX_EMAIL_BYTES,
  randomSecret,
} from "./email-security";
import { emailExpiry, getEmailRetentionDays } from "./settings";
import { nowIso, sha256 } from "./lib";
import {
  objectKey,
  type Attachment,
  type StoredMail,
} from "./transactional-storage";
import { publishWebhookOutbox } from "./webhooks";

type AuthenticationStatus =
  | "pass"
  | "fail"
  | "gray"
  | "processing_failed"
  | "unknown";

type Authentication = Record<"spf" | "dkim" | "dmarc", AuthenticationStatus>;

/** Cloudflare prepends this value to message.headers after it performs its own
 * checks. Raw MIME headers are sender-controlled and must never be trusted. */
function authentication(first: string | null, from: string): Authentication {
  const unknown: Authentication = {
    spf: "unknown",
    dkim: "unknown",
    dmarc: "unknown",
  };
  if (!first || !/^mx\.cloudflare\.net\s*;/i.test(first))
    return unknown;
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
  const results = (key: "spf" | "dkim" | "dmarc") =>
    methods.flatMap((method) => {
      const match = method.match(
        new RegExp(
          `^\\s*${key}=(pass|fail|softfail|neutral|none|temperror|permerror)\\b`,
          "i",
        ),
      );
      return match
        ? [{ result: match[1]!.toLowerCase(), method }]
        : [];
    });
  const normalized = (result?: string): AuthenticationStatus =>
    result === "pass"
      ? "pass"
      : result === "fail"
        ? "fail"
        : result === "temperror" || result === "permerror"
          ? "processing_failed"
          : result
            ? "gray"
            : "unknown";

  // Cloudflare may report SPF for both HELO and MAIL FROM. Resend exposes the
  // envelope-sender result.
  const spfResults = results("spf");
  const spf = normalized(
    (spfResults.find(({ method }) => /\bsmtp\.mailfrom\s*=/i.test(method)) ??
      spfResults[0])?.result,
  );

  // A valid signature from an unrelated domain is not DKIM authentication for
  // the visible sender. Resend reports that state as gray.
  const fromDomain = from.split("@").at(-1)?.toLowerCase();
  const dkimResults = results("dkim").map((result) => ({
    ...result,
    domain: result.method
      .match(/\bheader\.d\s*=\s*([^\s;]+)/i)?.[1]
      ?.toLowerCase(),
  }));
  const aligned = (domain?: string) => Boolean(domain && fromDomain === domain);
  const dkimResult =
    dkimResults.find(({ result, domain }) => result === "pass" && aligned(domain)) ??
    dkimResults.find(({ domain }) => aligned(domain)) ??
    dkimResults.find(({ result }) => result === "pass") ??
    dkimResults[0];
  const dkim =
    dkimResult?.domain && !aligned(dkimResult.domain)
      ? "gray"
      : normalized(dkimResult?.result);

  const dmarcResult = results("dmarc")[0];
  const dmarc =
    dmarcResult?.result === "pass" &&
    /\b(?:policy\.dmarc|p)\s*=\s*none\b/i.test(dmarcResult.method)
      ? "gray"
      : normalized(dmarcResult?.result);

  return { spf, dkim, dmarc };
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
  const expiresAt = emailExpiry(
    Date.parse(now),
    await getEmailRetentionDays(env.DB),
  );
  const trustedAuthenticationHeader = message.headers.get(
    "authentication-results",
  );
  const auth = authentication(
    trustedAuthenticationHeader,
    parsed.from?.address ?? message.from,
  );
  const headerValues = new Map<string, string[]>();
  for (const header of parsed.headers) {
    const key = header.key.toLowerCase();
    if (key === "authentication-results") continue;
    headerValues.set(key, [...(headerValues.get(key) ?? []), header.value]);
  }
  if (trustedAuthenticationHeader)
    headerValues.set("authentication-results", [trustedAuthenticationHeader]);
  const headers = Object.fromEntries(
    [...headerValues].map(([key, values]) => [
      key,
      values.length === 1 ? values[0]! : JSON.stringify(values),
    ]),
  );
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
      authentication: auth,
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
