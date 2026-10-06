import { EmailMessage } from "cloudflare:email";
import { createMimeMessage, Mailbox } from "mimetext/browser";
import { AppError, escapeHtml, logError, nowIso, randomToken, sha256, stripHtml, unsubscribeBaseUrl } from "./lib";
import type { BroadcastRow, DeliveryDetail, DeliveryQueueMessage, EmailEventMessage } from "./types";

const TRANSIENT_EMAIL_CODES = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_DELIVERY_FAILED",
  "E_INTERNAL_SERVER_ERROR",
]);

export async function enqueueBroadcast(env: Env, broadcastId: string): Promise<number> {
  const broadcast = await env.DB.prepare("SELECT * FROM broadcasts WHERE id = ?")
    .bind(broadcastId).first<BroadcastRow>();
  if (!broadcast) throw new AppError(404, "not_found", "Broadcast not found.");
  if (["cancelled", "sent"].includes(broadcast.status)) return 0;
  await validateBroadcastReady(env, broadcastId);

  const now = nowIso();
  await env.DB.prepare(
    `UPDATE broadcasts SET status = 'queueing', updated_at = ?
     WHERE id = ? AND status IN ('draft', 'scheduled', 'queueing', 'queued')`,
  ).bind(now, broadcastId).run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO deliveries
       (id, broadcast_id, contact_id, recipient, status, attempts, created_at, updated_at)
     SELECT ? || ':' || c.id, ?, c.id, c.email, 'pending', 0, ?, ?
     FROM segment_contacts sc
     JOIN contacts c ON c.id = sc.contact_id
     WHERE sc.segment_id = ?
       AND sc.status = 'subscribed'
       AND c.unsubscribed = 0
       AND c.suppression_reason IS NULL
       AND (? IS NULL OR COALESCE(
         (SELECT ct.subscription FROM contact_topics ct WHERE ct.topic_id = ? AND ct.contact_id = c.id),
         (SELECT t.default_subscription FROM topics t WHERE t.id = ?)
       ) = 'opt_in')`,
  ).bind(broadcastId, broadcastId, now, now, broadcast.segment_id, broadcast.topic_id, broadcast.topic_id, broadcast.topic_id).run();

  const pending = await env.DB.prepare(
    "SELECT id FROM deliveries WHERE broadcast_id = ? AND status = 'pending' ORDER BY id",
  ).bind(broadcastId).all<{ id: string }>();

  for (let index = 0; index < pending.results.length; index += 100) {
    const chunk = pending.results.slice(index, index + 100);
    await env.DELIVERY_QUEUE.sendBatch(
      chunk.map(({ id }) => ({ body: { deliveryId: id } satisfies DeliveryQueueMessage })),
    );
    if (chunk.length > 0) {
      const placeholders = chunk.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE deliveries SET status = 'enqueued', updated_at = ? WHERE status = 'pending' AND id IN (${placeholders})`,
      ).bind(nowIso(), ...chunk.map(({ id }) => id)).run();
    }
  }

  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE broadcast_id = ?")
    .bind(broadcastId).first<{ count: number }>();
  const total = Number(count?.count ?? 0);
  await env.DB.prepare(
    `UPDATE broadcasts SET status = ?, sent_at = CASE WHEN ? = 0 THEN ? ELSE sent_at END, updated_at = ? WHERE id = ?`,
  ).bind(total === 0 ? "sent" : "queued", total, nowIso(), nowIso(), broadcastId).run();
  return total;
}

export async function processDeliveryMessage(message: Message<DeliveryQueueMessage>, env: Env): Promise<void> {
  const deliveryId = message.body.deliveryId;
  const detail = await loadDelivery(env.DB, deliveryId);
  if (!detail) {
    message.ack();
    return;
  }
  if (["accepted", "delivered", "bounced", "rejected", "complained", "cancelled", "suppressed"].includes(detail.status)) {
    message.ack();
    return;
  }
  if (detail.broadcast_status === "cancelled") {
    await setDeliveryStatus(env.DB, deliveryId, "cancelled", null);
    message.ack();
    return;
  }
  if (!detail.sender_active) {
    await setDeliveryStatus(env.DB, deliveryId, "failed", "Sender is inactive.");
    message.ack();
    return;
  }

  if (!detail.contact_id) {
    await setDeliveryStatus(env.DB, deliveryId, "suppressed", "Contact was deleted.");
    message.ack();
    return;
  }

  const eligibility = await env.DB.prepare(
    `SELECT sc.status AS membership_status, c.unsubscribed, c.suppression_reason,
            CASE WHEN ? IS NULL THEN 'opt_in' ELSE COALESCE(ct.subscription, t.default_subscription, 'opt_out') END AS topic_subscription
     FROM segment_contacts sc JOIN contacts c ON c.id = sc.contact_id
     LEFT JOIN topics t ON t.id = ?
     LEFT JOIN contact_topics ct ON ct.topic_id = t.id AND ct.contact_id = c.id
     WHERE sc.segment_id = ? AND sc.contact_id = ?`,
  ).bind(detail.topic_id, detail.topic_id, detail.segment_id, detail.contact_id).first<{
    membership_status: string;
    unsubscribed: number;
    suppression_reason: string | null;
    topic_subscription: "opt_in" | "opt_out";
  }>();
  if (!eligibility || eligibility.membership_status !== "subscribed" || eligibility.unsubscribed || eligibility.suppression_reason || eligibility.topic_subscription !== "opt_in") {
    await setDeliveryStatus(env.DB, deliveryId, "suppressed", "Recipient is unsubscribed or suppressed.");
    message.ack();
    return;
  }

  let unsubscribeUrlBase: string;
  try {
    unsubscribeUrlBase = unsubscribeBaseUrl(env.UNSUBSCRIBE_HOSTNAMES, detail.sender_domain);
  } catch (error) {
    await setDeliveryStatus(env.DB, deliveryId, "failed", error instanceof Error ? error.message : "Invalid unsubscribe hostname configuration.");
    message.ack();
    return;
  }

  const claimed = await env.DB.prepare(
    `UPDATE deliveries SET status = 'sending', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'enqueued', 'deferred', 'failed')`,
  ).bind(nowIso(), deliveryId).run();
  if (!claimed.meta.changes) {
    message.ack();
    return;
  }

  const token = randomToken();
  const tokenHash = await sha256(token);
  await env.DB.prepare(
    "INSERT INTO unsubscribe_tokens (token_hash, contact_id, topic_id, created_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, detail.contact_id, detail.topic_id, nowIso()).run();
  const unsubscribeUrl = `${unsubscribeUrlBase}/unsubscribe/${token}`;

  try {
    const raw = buildCampaignMime(detail, unsubscribeUrl);
    const result = await env.EMAIL.send(new EmailMessage(detail.sender_email, detail.recipient, raw));
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE deliveries SET status = 'accepted', message_id = ?, last_error = NULL, updated_at = ? WHERE id = ?",
      ).bind(result.messageId, nowIso(), deliveryId),
      env.DB.prepare(
        "UPDATE broadcasts SET status = 'sending', updated_at = ? WHERE id = ? AND status IN ('queued', 'queueing')",
      ).bind(nowIso(), detail.broadcast_id),
    ]);
    await finishBroadcastIfComplete(env.DB, detail.broadcast_id);
    message.ack();
  } catch (error) {
    const code = emailErrorCode(error);
    const detailText = `${code ?? "EMAIL_ERROR"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
    if (code && TRANSIENT_EMAIL_CODES.has(code)) {
      await setDeliveryStatus(env.DB, deliveryId, "deferred", detailText);
      message.retry({ delaySeconds: Math.min(3600, 30 * 2 ** Math.min(message.attempts, 6)) });
      return;
    }
    await setDeliveryStatus(env.DB, deliveryId, code === "E_RECIPIENT_SUPPRESSED" ? "suppressed" : "failed", detailText);
    await finishBroadcastIfComplete(env.DB, detail.broadcast_id);
    message.ack();
  }
}

export function buildCampaignMime(detail: DeliveryDetail, unsubscribeUrl: string): string {
  rejectHeaderBreaks(detail.subject, "subject");
  rejectHeaderBreaks(detail.sender_name, "sender name");
  rejectHeaderBreaks(detail.sender_email, "sender email");
  const replyTo = broadcastReplyTo(detail.reply_to_json) ?? detail.sender_reply_to;
  if (replyTo) rejectHeaderBreaks(replyTo, "reply-to");

  const postal = escapeHtml(detail.postal_address).replaceAll("\n", "<br>");
  const htmlFooter = `<hr><p style="color:#666;font-size:12px">${postal}<br><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`;
  const textFooter = `\n\n---\n${detail.postal_address}\nUnsubscribe: ${unsubscribeUrl}`;
  const preview = detail.preview_text
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(detail.preview_text)}</div>`
    : "";
  const html = `${preview}${detail.html ?? `<p>${escapeHtml(detail.text ?? "")}</p>`}${htmlFooter}`;
  const text = `${detail.text ?? stripHtml(detail.html ?? "")}${textFooter}`;

  const mime = createMimeMessage();
  mime.setSender({ name: detail.sender_name, addr: detail.sender_email });
  mime.setRecipient(detail.recipient);
  mime.setSubject(detail.subject);
  if (replyTo) mime.setHeader("Reply-To", new Mailbox(replyTo));
  mime.setHeader("List-Unsubscribe", `<${unsubscribeUrl}>`);
  mime.setHeader("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  mime.setHeader("X-Campaign-ID", detail.broadcast_id);
  mime.addMessage({ contentType: "text/plain", data: text });
  mime.addMessage({ contentType: "text/html", data: html });
  return mime.asRaw();
}

function broadcastReplyTo(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null;
  } catch {
    return null;
  }
}

export async function validateBroadcastReady(env: Env, broadcastId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT b.id, b.subject, b.html, b.text, s.active, s.postal_address, d.name AS sender_domain
     FROM broadcasts b JOIN senders s ON s.id = b.sender_id JOIN domains d ON d.id = s.domain_id WHERE b.id = ?`,
  ).bind(broadcastId).first<{ id: string; subject: string; html: string | null; text: string | null; active: number; postal_address: string; sender_domain: string }>();
  if (!row) throw new AppError(404, "not_found", "Broadcast not found.");
  if (!row.active) throw new AppError(422, "validation_error", "The selected sender is inactive.");
  if (!row.postal_address.trim()) throw new AppError(422, "validation_error", "The selected sender requires a postal address.");
  if (!row.subject.trim() || (!row.html && !row.text)) throw new AppError(422, "validation_error", "The broadcast is incomplete.");
  unsubscribeBaseUrl(env.UNSUBSCRIBE_HOSTNAMES, row.sender_domain);
}

function rejectHeaderBreaks(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new AppError(422, "validation_error", `${field} contains invalid characters.`);
}

function emailErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return null;
}

async function loadDelivery(db: D1Database, id: string): Promise<DeliveryDetail | null> {
  return db.prepare(
    `SELECT d.*, b.subject, b.html, b.text, b.preview_text, b.reply_to_json,
            b.status AS broadcast_status, b.segment_id, b.topic_id,
            s.email AS sender_email, s.name AS sender_name, s.reply_to AS sender_reply_to,
            dom.name AS sender_domain, s.postal_address, s.active AS sender_active
     FROM deliveries d
     JOIN broadcasts b ON b.id = d.broadcast_id
     JOIN senders s ON s.id = b.sender_id
     JOIN domains dom ON dom.id = s.domain_id
     WHERE d.id = ?`,
  ).bind(id).first<DeliveryDetail>();
}

async function setDeliveryStatus(db: D1Database, id: string, status: string, error: string | null): Promise<void> {
  await db.prepare("UPDATE deliveries SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
    .bind(status, error, nowIso(), id).run();
}

async function finishBroadcastIfComplete(db: D1Database, broadcastId: string): Promise<void> {
  const unfinished = await db.prepare(
    "SELECT COUNT(*) AS count FROM deliveries WHERE broadcast_id = ? AND status IN ('pending', 'enqueued', 'sending', 'deferred')",
  ).bind(broadcastId).first<{ count: number }>();
  if (Number(unfinished?.count ?? 0) === 0) {
    await db.prepare(
      "UPDATE broadcasts SET status = 'sent', sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ? AND status != 'cancelled'",
    ).bind(nowIso(), nowIso(), broadcastId).run();
  }
}

export async function processEmailEvent(message: Message<EmailEventMessage>, env: Env): Promise<void> {
  const event = message.body;
  const eventId = event.payload?.eventId;
  if (!eventId) {
    message.ack();
    return;
  }
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO email_events (event_id, message_id, event_type, received_at) VALUES (?, ?, ?, ?)",
  ).bind(eventId, event.payload.messageId ?? null, event.type, nowIso()).run();
  if (!inserted.meta.changes) {
    message.ack();
    return;
  }

  const status = event.type.split(".").at(-1) ?? event.payload.delivery?.status;
  const messageId = event.payload.messageId;
  if (messageId && ["delivered", "deferred", "bounced", "failed", "rejected", "complained"].includes(status ?? "")) {
    const reason = event.payload.bounce?.reason ?? event.payload.failure?.reason ?? event.payload.rejection?.detail ?? null;
    await env.DB.prepare(
      "UPDATE deliveries SET status = ?, last_error = ?, updated_at = ? WHERE message_id = ?",
    ).bind(status, reason, nowIso(), messageId).run();

    if (status === "complained" || (status === "bounced" && event.payload.bounce?.type === "hard")) {
      await env.DB.prepare(
        `UPDATE contacts SET suppression_reason = ?, updated_at = ?
         WHERE id = (SELECT contact_id FROM deliveries WHERE message_id = ?)`,
      ).bind(status, nowIso(), messageId).run();
    }
  }
  message.ack();
}

export async function processDeadLetter(batch: MessageBatch<DeliveryQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await env.DB.prepare(
        "UPDATE deliveries SET status = 'failed', last_error = 'Queue retries exhausted', updated_at = ? WHERE id = ? AND status NOT IN ('accepted', 'delivered')",
      ).bind(nowIso(), message.body.deliveryId).run();
      message.ack();
    } catch (error) {
      logError("dead-letter update failed", error, { deliveryId: message.body.deliveryId });
      message.retry();
    }
  }
}

export async function sendTestEmail(
  env: Env,
  input: { to: string; sender: { email: string; name: string; reply_to: string | null; postal_address: string; domain: string }; subject: string; html: string; text?: string | null },
): Promise<string> {
  const unsubscribeUrl = `${unsubscribeBaseUrl(env.UNSUBSCRIBE_HOSTNAMES, input.sender.domain)}/unsubscribe/test`;
  const mime = createMimeMessage();
  mime.setSender({ name: input.sender.name, addr: input.sender.email });
  mime.setRecipient(input.to);
  mime.setSubject(`[TEST] ${input.subject}`);
  if (input.sender.reply_to) mime.setHeader("Reply-To", new Mailbox(input.sender.reply_to));
  mime.setHeader("X-Campaign-Test", "true");
  mime.addMessage({
    contentType: "text/plain",
    data: `${input.text ?? stripHtml(input.html)}\n\n---\n${input.sender.postal_address}\nUnsubscribe preview: ${unsubscribeUrl}`,
  });
  mime.addMessage({
    contentType: "text/html",
    data: `${input.html}<hr><p style="color:#666;font-size:12px">${escapeHtml(input.sender.postal_address).replaceAll("\n", "<br>")}<br><a href="${unsubscribeUrl}">Unsubscribe preview</a></p>`,
  });
  const result = await env.EMAIL.send(new EmailMessage(input.sender.email, input.to, mime.asRaw()));
  return result.messageId;
}

export async function retryFailedDeliveries(env: Env, broadcastId: string): Promise<number> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE deliveries SET status = 'pending', last_error = NULL, updated_at = ? WHERE broadcast_id = ? AND status = 'failed'",
  ).bind(now, broadcastId).run();
  const rows = await env.DB.prepare("SELECT id FROM deliveries WHERE broadcast_id = ? AND status = 'pending'")
    .bind(broadcastId).all<{ id: string }>();
  for (let index = 0; index < rows.results.length; index += 100) {
    const chunk = rows.results.slice(index, index + 100);
    await env.DELIVERY_QUEUE.sendBatch(chunk.map(({ id }) => ({ body: { deliveryId: id } })));
    if (chunk.length) {
      const placeholders = chunk.map(() => "?").join(",");
      await env.DB.prepare(`UPDATE deliveries SET status = 'enqueued', updated_at = ? WHERE id IN (${placeholders})`)
        .bind(nowIso(), ...chunk.map(({ id }) => id)).run();
    }
  }
  if (rows.results.length) {
    await env.DB.prepare("UPDATE broadcasts SET status = 'queued', sent_at = NULL, updated_at = ? WHERE id = ?")
      .bind(nowIso(), broadcastId).run();
  }
  return rows.results.length;
}
