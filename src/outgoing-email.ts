import type { EmailEventMessage } from "./types";
import { Buffer } from "node:buffer";
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage, Mailbox } from "mimetext/browser";
import {
  AppError,
  isEmail,
  nowIso,
  parseFrom,
  requiredString,
  stripHtml,
} from "./lib";
import {
  boundedBytes,
  MAX_EMAIL_BYTES,
  publicFetch,
  randomSecret,
  RETENTION_MS,
} from "./email-security";
import {
  objectKey,
  mailRow,
  type Attachment,
  type StoredMail,
} from "./transactional-storage";

function address(value: unknown, field: string): string {
  const text = requiredString(value, field, 500);
  if (/[\r\n\x00]/.test(text))
    throw new AppError(
      422,
      "validation_error",
      `${field} contains invalid characters.`,
    );
  const parsed = parseFrom(text);
  if (!isEmail(parsed.email))
    throw new AppError(
      422,
      "validation_error",
      `${field} must be an email address.`,
    );
  return text;
}
function addresses(value: unknown, field: string, required = false): string[] {
  if (value === undefined && !required) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!list.length && required)
    throw new AppError(422, "missing_required_field", `${field} is required.`);
  return list.map((v) => address(v, field));
}
export async function createOutgoingEmail(
  env: Env,
  body: Record<string, unknown>,
  apiKeyId: string,
): Promise<string> {
  for (const field of ["scheduled_at", "template", "topic_id"])
    if (body[field] !== undefined)
      throw new AppError(
        422,
        "validation_error",
        `${field} is not supported in this release.`,
      );
  const from = address(body.from, "from");
  const sender = parseFrom(from);
  const domain = await env.DB.prepare(
    "SELECT id FROM domains WHERE name=? AND cloudflare_enabled=1",
  )
    .bind(sender.email.split("@")[1]!.toLowerCase())
    .first();
  if (!domain)
    throw new AppError(
      403,
      "validation_error",
      "The from domain is not enabled for sending.",
    );
  const to = addresses(body.to, "to", true),
    cc = addresses(body.cc, "cc"),
    bcc = addresses(body.bcc, "bcc"),
    replyTo = addresses(body.reply_to, "reply_to");
  if (to.length + cc.length + bcc.length > 50)
    throw new AppError(
      422,
      "validation_error",
      "A maximum of 50 recipients is supported.",
    );
  const subject = requiredString(body.subject, "subject", 998);
  if (/[\r\n\x00]/.test(subject))
    throw new AppError(
      422,
      "validation_error",
      "subject contains invalid characters.",
    );
  if (
    (body.html !== undefined && typeof body.html !== "string") ||
    (body.text !== undefined && typeof body.text !== "string")
  )
    throw new AppError(
      422,
      "validation_error",
      "html and text must be strings.",
    );
  const html = body.html === undefined ? null : (body.html as string);
  const text =
    body.text === undefined
      ? html
        ? stripHtml(html)
        : null
      : typeof body.text === "string"
        ? body.text
        : null;
  if (!html && !text)
    throw new AppError(
      422,
      "missing_required_field",
      "html or text is required.",
    );
  const headers: Record<string, string> = {};
  if (body.headers !== undefined) {
    if (
      !body.headers ||
      typeof body.headers !== "object" ||
      Array.isArray(body.headers)
    )
      throw new AppError(422, "validation_error", "headers must be an object.");
    for (const [key, value] of Object.entries(body.headers)) {
      if (
        !/^[A-Za-z0-9-]+$/.test(key) ||
        typeof value !== "string" ||
        /[\r\n\x00]/.test(value)
      )
        throw new AppError(422, "validation_error", "Invalid custom header.");
      if (
        /^(from|to|cc|bcc|subject|reply-to|return-path|received|authentication-results|dkim-signature|content-.*|mime-version)$/i.test(
          key,
        )
      )
        throw new AppError(
          422,
          "validation_error",
          `Header ${key} cannot be overridden.`,
        );
      headers[key] = value;
    }
  }
  const tags: { name: string; value: string }[] = [];
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 20)
      throw new AppError(
        422,
        "validation_error",
        "tags must be an array of at most 20 entries.",
      );
    for (const tag of body.tags) {
      if (
        !tag ||
        typeof tag.name !== "string" ||
        typeof tag.value !== "string" ||
        ![tag.name, tag.value].every((v) => /^[a-zA-Z0-9_-]{1,256}$/.test(v))
      )
        throw new AppError(
          422,
          "validation_error",
          "Invalid tag name or value.",
        );
      tags.push({ name: tag.name, value: tag.value });
    }
  }
  if (
    body.attachments !== undefined &&
    (!Array.isArray(body.attachments) || body.attachments.length > 100)
  )
    throw new AppError(
      422,
      "validation_error",
      "attachments must be an array of at most 100 entries.",
    );
  const id = crypto.randomUUID(),
    now = nowIso(),
    expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
  const attachments: Attachment[] = [];
  const contents: { meta: Attachment; bytes: Uint8Array }[] = [];
  let size = Buffer.byteLength(html ?? "") + Buffer.byteLength(text ?? "");
  for (const item of (body.attachments ?? []) as Record<string, unknown>[]) {
    if (!item || typeof item !== "object")
      throw new AppError(422, "validation_error", "Invalid attachment.");
    const filename = requiredString(item.filename, "filename", 255);
    if (/[\r\n\x00]/.test(filename))
      throw new AppError(
        422,
        "validation_error",
        "Invalid attachment filename.",
      );
    if ((item.content === undefined) === (item.path === undefined))
      throw new AppError(
        422,
        "validation_error",
        "Provide attachment content or path.",
      );
    let bytes: Uint8Array;
    if (item.path !== undefined) {
      const response = await publicFetch(String(item.path));
      if (!response.ok)
        throw new AppError(
          422,
          "validation_error",
          "Attachment URL could not be downloaded.",
        );
      bytes = await boundedBytes(response.body, MAX_EMAIL_BYTES - size);
    } else if (typeof item.content === "string") {
      if (
        item.content.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(item.content)
      )
        throw new AppError(
          422,
          "validation_error",
          "Attachment content must be base64.",
        );
      bytes = Buffer.from(item.content, "base64");
    } else {
      // The official Node SDK serializes Buffer attachments using Buffer.toJSON().
      const content = item.content as { type?: unknown; data?: unknown } | null;
      if (
        !content ||
        content.type !== "Buffer" ||
        !Array.isArray(content.data) ||
        !content.data.every(
          (value) => Number.isInteger(value) && value >= 0 && value <= 255,
        )
      )
        throw new AppError(
          422,
          "validation_error",
          "Attachment content must be base64 or a serialized Buffer.",
        );
      bytes = Buffer.from(content.data);
    }
    size += Math.ceil(bytes.byteLength / 3) * 4;
    if (size > MAX_EMAIL_BYTES - 65536)
      throw new AppError(
        413,
        "validation_error",
        "The encoded email exceeds the Cloudflare 25 MiB limit.",
      );
    const contentType =
      typeof item.content_type === "string"
        ? item.content_type
        : filename.endsWith(".ics")
          ? "text/calendar"
          : filename.endsWith(".pdf")
            ? "application/pdf"
            : "application/octet-stream";
    if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType))
      throw new AppError(
        422,
        "validation_error",
        "Invalid attachment content_type.",
      );
    const cid =
      item.content_id === undefined
        ? null
        : requiredString(item.content_id, "content_id", 200);
    if (cid && /[\s<>\x00-\x1f]/.test(cid))
      throw new AppError(422, "validation_error", "Invalid content_id.");
    const meta: Attachment = {
      id: crypto.randomUUID(),
      filename,
      size: bytes.byteLength,
      content_type: contentType,
      content_disposition: cid ? "inline" : "attachment",
      content_id: cid,
    };
    attachments.push(meta);
    contents.push({ meta, bytes });
  }
  const messageId = `<${id}@${sender.email.split("@")[1]}>`;
  const mail: StoredMail = {
    from,
    to,
    cc,
    bcc,
    reply_to: replyTo,
    subject,
    html,
    text,
    headers,
    message_id: messageId,
    attachments,
    tags,
  };
  let raw: string;
  try {
    const mime = createMimeMessage();
    mime.setSender(from);
    mime.setTo(to);
    if (cc.length) mime.setCc(cc);
    if (replyTo.length) mime.setHeader("Reply-To", new Mailbox(replyTo[0]!));
    mime.setSubject(subject);
    for (const [key, value] of Object.entries(headers))
      mime.setHeader(key, value);
    mime.setHeader("Message-ID", messageId);
    for (const [type, content] of [
      ["text/plain", text],
      ["text/html", html],
    ])
      if (content !== null && content !== undefined) {
        mime.addMessage({
          contentType: type!,
          encoding: "base64",
          data:
            Buffer.from(content)
              .toString("base64")
              .match(/.{1,76}/g)
              ?.join("\r\n") ?? "",
        });
      }
    for (const { meta, bytes } of contents)
      mime.addAttachment({
        filename: meta.filename!,
        contentType: meta.content_type,
        encoding: "base64",
        data: Buffer.from(bytes).toString("base64"),
        ...(meta.content_id
          ? { inline: true, headers: { "Content-ID": `<${meta.content_id}>` } }
          : {}),
      });
    raw = mime
      .asRaw()
      .replace(
        /^Reply-To:[^\r\n]*/im,
        () =>
          `Reply-To: ${replyTo.map((a) => new Mailbox(a).dump()).join(", ")}`,
      )
      .replace(/\r?\n/g, "\r\n");
  } catch {
    throw new AppError(
      422,
      "validation_error",
      "The email contains invalid MIME fields or headers.",
    );
  }
  if (Buffer.byteLength(raw) > MAX_EMAIL_BYTES)
    throw new AppError(
      413,
      "validation_error",
      "The encoded email exceeds 25 MiB.",
    );
  const writes = [
    objectKey(id, "content.json"),
    objectKey(id, "raw.eml"),
    ...attachments.map((a) => objectKey(id, `attachment-${a.id}`)),
  ];
  try {
    for (const [key, value, type] of [
      [writes[0]!, JSON.stringify(mail), "application/json"],
      [writes[1]!, raw, "message/rfc822"],
    ] as const)
      await env.EMAIL_STORAGE.put(key, value, {
        customMetadata: { expires_at: expiresAt },
        httpMetadata: { contentType: type },
      });
    for (const { meta, bytes } of contents)
      await env.EMAIL_STORAGE.put(
        objectKey(id, `attachment-${meta.id}`),
        bytes,
        {
          customMetadata: { expires_at: expiresAt },
          httpMetadata: {
            contentType: meta.content_type,
            contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename!)}`,
          },
        },
      );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO transactional_emails(id,direction,from_value,to_json,subject,api_key_id,status,created_at,expires_at,download_secret) VALUES(?,'sending',?,?,?,?,'queued',?,?,?)",
      ).bind(
        id,
        from,
        JSON.stringify(to),
        subject,
        apiKeyId,
        now,
        expiresAt,
        randomSecret(),
      ),
      ...[
        ...new Set(
          [...to, ...cc, ...bcc].map((a) => parseFrom(a).email.toLowerCase()),
        ),
      ].map((recipient) =>
        env.DB.prepare(
          "INSERT INTO transactional_recipients(email_id,recipient,updated_at) VALUES(?,?,?)",
        ).bind(id, recipient, now),
      ),
    ]);
  } catch (error) {
    await env.EMAIL_STORAGE.delete(writes);
    throw error;
  }
  try {
    await env.DELIVERY_QUEUE.send({ transactionalId: id });
  } catch (error) {
    console.error(
      "Transactional send queued for scheduled recovery",
      error instanceof Error ? error.message : "queue unavailable",
    );
  }
  return id;
}
export async function sendTransactionalEmail(
  env: Env,
  id: string,
): Promise<void> {
  let row;
  try {
    row = await mailRow(env, id, "sending");
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return;
    throw error;
  }
  const recipients = await env.DB.prepare(
    "SELECT recipient FROM transactional_recipients WHERE email_id=? AND status='pending' LIMIT 50",
  )
    .bind(id)
    .all<{ recipient: string }>();
  if (!recipients.results.length) return;
  // MIME is bounded to 25 MiB at acceptance; avoid loading the JSON body again.
  const raw = await env.EMAIL_STORAGE.get(objectKey(id, "raw.eml"));
  if (!raw) throw new Error("Outgoing MIME is missing.");
  const mime = await raw.text();
  for (const { recipient } of recipients.results) {
    const claim = await env.DB.prepare(
      "UPDATE transactional_recipients SET status='sending',updated_at=? WHERE email_id=? AND recipient=? AND status='pending'",
    )
      .bind(nowIso(), id, recipient)
      .run();
    if (!claim.meta.changes) continue;
    let status = "sent",
      providerId: string | null = null,
      error: string | null = null;
    try {
      const result = await env.EMAIL.send(
        new EmailMessage(parseFrom(row.from_value).email, recipient, mime),
      );
      providerId = result.messageId;
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : "Send failed.";
    }
    // Never automatically resend an ambiguous transport outcome. An operator can inspect it.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE transactional_recipients SET status=?,provider_id=?,error=?,updated_at=? WHERE email_id=? AND recipient=?",
      ).bind(status, providerId, error, nowIso(), id, recipient),
      env.DB.prepare(
        "INSERT INTO transactional_events(id,email_id,status,recipient,created_at) VALUES(?,?,?,?,?)",
      ).bind(crypto.randomUUID(), id, status, recipient, nowIso()),
    ]);
  }
  await updateTransactionalStatus(env, id);
}
export async function updateTransactionalStatus(env: Env, id: string) {
  await env.DB.prepare(
    `UPDATE transactional_emails SET status=CASE
 WHEN EXISTS(SELECT 1 FROM transactional_recipients WHERE email_id=?1 AND status IN ('pending','sending')) THEN 'queued'
 WHEN EXISTS(SELECT 1 FROM transactional_recipients WHERE email_id=?1 AND status='complained') THEN 'complained'
 WHEN EXISTS(SELECT 1 FROM transactional_recipients WHERE email_id=?1 AND status='bounced') THEN 'bounced'
 WHEN EXISTS(SELECT 1 FROM transactional_recipients WHERE email_id=?1 AND status IN ('failed','rejected')) THEN 'failed'
 WHEN EXISTS(SELECT 1 FROM transactional_recipients WHERE email_id=?1 AND status='deferred') THEN 'delivery_delayed'
 WHEN NOT EXISTS(SELECT 1 FROM transactional_recipients WHERE email_id=?1 AND status!='delivered') THEN 'delivered'
 ELSE 'sent' END WHERE id=?1`,
  )
    .bind(id)
    .run();
}

// Provider events can arrive before send() returns its provider ID. The durable
// inbox is reconciled again by the scheduled handler once that mapping exists.
export async function applyTransactionalProviderEvent(
  env: Env,
  event: EmailEventMessage,
): Promise<void> {
  const providerId = event.payload.messageId;
  const status = event.type.split(".").at(-1) ?? event.payload.delivery?.status;
  if (
    !providerId ||
    ![
      "delivered",
      "deferred",
      "bounced",
      "failed",
      "rejected",
      "complained",
    ].includes(status ?? "")
  )
    return;
  const recipient = event.payload.recipient?.toLowerCase() ?? null;
  const row = await env.DB.prepare(
    "SELECT email_id FROM transactional_recipients WHERE provider_id=?",
  )
    .bind(providerId)
    .first<{ email_id: string }>();
  if (!row) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE transactional_recipients SET status=?,updated_at=? WHERE provider_id=? AND (? IS NULL OR recipient=?) AND (status NOT IN ('delivered','bounced','failed','rejected','complained') OR ? IN ('bounced','failed','rejected','complained'))`,
    ).bind(status, nowIso(), providerId, recipient, recipient, status),
    env.DB.prepare(
      "INSERT OR IGNORE INTO transactional_events(id,email_id,status,recipient,created_at) VALUES(?,?,?,?,?)",
    ).bind(event.payload.eventId, row.email_id, status, recipient, nowIso()),
  ]);
  await updateTransactionalStatus(env, row.email_id);
  await env.DB.prepare(
    "UPDATE email_events SET transactional_processed=1 WHERE event_id=?",
  )
    .bind(event.payload.eventId)
    .run();
}
