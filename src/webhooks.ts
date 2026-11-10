import { Hono } from "hono";
import { AppError, nowIso } from "./lib";
import {
  jsonObject,
  hmac,
  publicUrl,
  publicFetch,
  randomSecret,
} from "./email-security";

export type WebhookRow = {
  id: string;
  endpoint: string;
  status: "enabled" | "disabled";
  signing_secret: string;
  created_at: string;
};
export type WebhookDelivery = {
  id: string;
  webhook_id: string;
  event_id: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  lease_until: string | null;
};
const RETRY_SECONDS = [5, 300, 1800, 7200, 18000, 36000, 36000];
export async function getWebhook(env: Env, id: string): Promise<WebhookRow> {
  const row = await env.DB.prepare("SELECT * FROM webhooks WHERE id=?")
    .bind(id)
    .first<WebhookRow>();
  if (!row) throw new AppError(404, "not_found", "Webhook not found.");
  return row;
}
export function webhookResponse(row: WebhookRow, secret = false) {
  return {
    object: "webhook",
    id: row.id,
    endpoint: row.endpoint,
    events: ["email.received"],
    status: row.status,
    created_at: row.created_at,
    ...(secret ? { signing_secret: row.signing_secret } : {}),
  };
}
function events(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0] !== "email.received"
  )
    throw new AppError(
      422,
      "validation_error",
      "Supported events: email.received.",
    );
}
export async function createWebhook(env: Env, body: Record<string, unknown>) {
  events(body.events);
  const endpoint = publicUrl(body.endpoint).href;
  const row: WebhookRow = {
    id: crypto.randomUUID(),
    endpoint,
    status: "enabled",
    signing_secret: `whsec_${randomSecret()}`,
    created_at: nowIso(),
  };
  await env.DB.prepare(
    "INSERT INTO webhooks(id,endpoint,status,signing_secret,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(row.id, row.endpoint, row.status, row.signing_secret, row.created_at)
    .run();
  return row;
}
export async function updateWebhook(
  env: Env,
  id: string,
  body: Record<string, unknown>,
) {
  const row = await getWebhook(env, id);
  if (body.events !== undefined) events(body.events);
  const status = body.status ?? row.status;
  if (status !== "enabled" && status !== "disabled")
    throw new AppError(
      422,
      "validation_error",
      "status must be enabled or disabled.",
    );
  await env.DB.prepare("UPDATE webhooks SET endpoint=?,status=? WHERE id=?")
    .bind(
      body.endpoint === undefined
        ? row.endpoint
        : publicUrl(body.endpoint).href,
      status,
      id,
    )
    .run();
  return getWebhook(env, id);
}
export const webhooksApi = new Hono<{ Bindings: Env }>();
webhooksApi.post("/", async (c) => {
  const row = await createWebhook(c.env, await jsonObject(c.req.raw, 65536));
  return c.json({
    object: "webhook",
    id: row.id,
    signing_secret: row.signing_secret,
  });
});
webhooksApi.get("/", async (c) => {
  const query = c.req.query();
  const limit = Number(query.limit ?? 20);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (query.after && query.before)
  )
    throw new AppError(
      422,
      "validation_error",
      "Invalid pagination parameters.",
    );
  const bindings: (string | number)[] = [];
  let where = "";
  if (query.after || query.before) {
    const cursor = await getWebhook(c.env, (query.after ?? query.before)!);
    const op = query.before ? ">" : "<";
    where = `WHERE (created_at ${op} ? OR (created_at=? AND id ${op} ?))`;
    bindings.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  const order = query.before ? "ASC" : "DESC";
  const rows = await c.env.DB.prepare(
    `SELECT * FROM webhooks ${where} ORDER BY created_at ${order},id ${order} LIMIT ?`,
  )
    .bind(...bindings, limit + 1)
    .all<WebhookRow>();
  const selected = rows.results.slice(0, limit);
  if (query.before) selected.reverse();
  return c.json({
    object: "list",
    data: selected.map((r) => webhookResponse(r)),
    has_more: rows.results.length > limit,
  });
});
webhooksApi.get("/:id", async (c) =>
  c.json(webhookResponse(await getWebhook(c.env, c.req.param("id")), true)),
);
webhooksApi.patch("/:id", async (c) => {
  const row = await updateWebhook(
    c.env,
    c.req.param("id"),
    await jsonObject(c.req.raw, 65536),
  );
  return c.json({ object: "webhook", id: row.id });
});
webhooksApi.delete("/:id", async (c) => {
  const row = await getWebhook(c.env, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM webhooks WHERE id=?").bind(row.id).run();
  return c.json({ object: "webhook", id: row.id, deleted: true });
});

export async function publishWebhookOutbox(env: Env): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT d.id FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id JOIN webhook_events e ON e.id=d.event_id JOIN transactional_emails m ON m.id=e.email_id
 WHERE w.status='enabled' AND m.expires_at>? AND ((d.status='pending' AND d.next_attempt_at<=?) OR (d.status='sending' AND d.lease_until<=?)) LIMIT 50`,
  )
    .bind(nowIso(), nowIso(), nowIso())
    .all<{ id: string }>();
  if (due.results.length)
    await env.WEBHOOK_QUEUE.sendBatch(
      due.results.map((r) => ({ body: { webhookDeliveryId: r.id } })),
    );
}
export async function deliverWebhook(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT d.*,w.endpoint,w.signing_secret,w.status AS endpoint_status,e.payload,m.expires_at
 FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id JOIN webhook_events e ON e.id=d.event_id JOIN transactional_emails m ON m.id=e.email_id WHERE d.id=?`,
  )
    .bind(id)
    .first<
      WebhookDelivery & {
        endpoint: string;
        signing_secret: string;
        endpoint_status: string;
        payload: string;
        expires_at: string;
      }
    >();
  if (
    !row ||
    row.endpoint_status !== "enabled" ||
    row.expires_at <= nowIso() ||
    row.status === "succeeded" ||
    row.status === "failed" ||
    row.next_attempt_at > nowIso()
  )
    return;
  const lease = new Date(Date.now() + 60_000).toISOString();
  const claim = await env.DB.prepare(
    `UPDATE webhook_deliveries SET status='sending',lease_until=? WHERE id=? AND ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?))`,
  )
    .bind(lease, id, nowIso(), nowIso())
    .run();
  if (!claim.meta.changes) return;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmac(
    row.signing_secret.slice(6),
    `${row.event_id}.${timestamp}.${row.payload}`,
  );
  let status: number | null = null;
  let responseBody = "";
  let success = false;
  try {
    const response = await publicFetch(row.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": row.event_id,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
      body: row.payload,
    });
    status = response.status;
    success = response.ok;
    // Retain a bounded response excerpt, without failing delivery for a large response.
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (size < 16384) {
          const r = await reader.read();
          if (r.done) break;
          const value = r.value.slice(0, 16384 - size);
          chunks.push(value);
          size += value.length;
        }
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
      const b = new Uint8Array(size);
      let o = 0;
      for (const chunk of chunks) {
        b.set(chunk, o);
        o += chunk.length;
      }
      responseBody = new TextDecoder().decode(b);
    }
  } catch (error) {
    responseBody =
      error instanceof Error ? error.message : "Webhook request failed.";
  }
  const delay = RETRY_SECONDS[row.attempts];
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO webhook_attempts(id,delivery_id,created_at,http_status,response_body,success) VALUES(?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      id,
      nowIso(),
      status,
      responseBody,
      success ? 1 : 0,
    ),
    env.DB.prepare(
      "UPDATE webhook_deliveries SET attempts=attempts+1,status=?,next_attempt_at=?,lease_until=NULL WHERE id=? AND lease_until=?",
    ).bind(
      success ? "succeeded" : delay === undefined ? "failed" : "pending",
      new Date(Date.now() + (delay ?? 0) * 1000).toISOString(),
      id,
      lease,
    ),
  ]);
  // Queue delay is capped at 12 hours; every retry in this schedule fits.
  if (!success && delay !== undefined)
    await env.WEBHOOK_QUEUE.send(
      { webhookDeliveryId: id },
      { delaySeconds: delay },
    );
}
export async function replayWebhook(
  env: Env,
  webhookId: string,
  eventId: string,
) {
  await getWebhook(env, webhookId);
  const delivery = await env.DB.prepare(
    `SELECT d.id,d.status FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN transactional_emails m ON m.id=e.email_id WHERE d.webhook_id=? AND d.event_id=? AND m.expires_at>?`,
  )
    .bind(webhookId, eventId, nowIso())
    .first<{ id: string; status: string }>();
  if (!delivery)
    throw new AppError(404, "not_found", "Webhook event not found.");
  if (delivery.status === "sending")
    throw new AppError(409, "conflict", "A delivery is in progress.");
  await env.DB.prepare(
    "UPDATE webhook_deliveries SET status='pending',attempts=0,next_attempt_at=?,lease_until=NULL WHERE id=?",
  )
    .bind(nowIso(), delivery.id)
    .run();
  await env.WEBHOOK_QUEUE.send({ webhookDeliveryId: delivery.id });
}
