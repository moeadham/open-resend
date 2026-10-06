import { Hono, type Context, type Next } from "hono";
import { requireApiKey } from "./auth";
import { enqueueBroadcast } from "./delivery";
import {
  AppError,
  appErrorResponse,
  assertIsoFuture,
  broadcastResponse,
  contactResponse,
  escapeHtml,
  isEmail,
  normalizeEmail,
  nowIso,
  optionalString,
  parseFrom,
  requiredString,
  safeJsonObject,
  sha256,
} from "./lib";
import type { BroadcastRow, ContactRow, SegmentRow, SenderRow, TopicRow } from "./types";

type Bindings = { Bindings: Env };
type JsonObject = Record<string, unknown>;

export const apiApp = new Hono<Bindings>();

apiApp.onError((error) => appErrorResponse(error));
apiApp.notFound(() => Response.json({ name: "not_found", message: "Route not found.", statusCode: 404 }, { status: 404 }));

apiApp.use("/unsubscribe/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
});

apiApp.get("/unsubscribe/:token", async (c) => {
  if (c.req.param("token") === "test") return c.html(unsubscribePage({
    title: "Do you want to unsubscribe from this mailing list?",
    description: "This is a preview of the unsubscribe page. Test emails do not change subscription preferences.",
    complete: true,
    state: "preview",
  }));
  const context = await findUnsubscribeContext(c.env.DB, c.req.param("token"));
  if (!context) return c.html(unsubscribePage({
    title: "This unsubscribe link is no longer available",
    description: "The link may be invalid or expired. No email preferences were changed.",
    complete: true,
    state: "error",
  }), 404);
  if (!context.topic_id) return c.html(unsubscribePage({
    title: "Unsubscribe from all emails?",
    description: `This will stop all broadcasts sent to ${context.email}.`,
    complete: false,
    state: "confirm",
    actions: '<form method="post"><input type="hidden" name="unsubscribe_all" value="1"><button type="submit">Unsubscribe from all</button></form>',
  }));
  const topics = await preferenceTopics(c.env.DB, context.contact_id, context.topic_id);
  return c.html(unsubscribePage({
    title: "Manage your email preferences",
    description: `Choose which emails ${context.email} should receive.`,
    complete: false,
    state: "confirm",
    actions: topicPreferenceForms(topics),
  }));
});

apiApp.post("/unsubscribe/:token", async (c) => {
  const context = await findUnsubscribeContext(c.env.DB, c.req.param("token"));
  if (!context) return c.html(unsubscribePage({
    title: "This unsubscribe link is no longer available",
    description: "The link may be invalid or expired. No email preferences were changed.",
    complete: true,
    state: "error",
  }), 404);
  const contentType = c.req.header("content-type") ?? "";
  const form = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")
    ? await c.req.raw.formData()
    : new FormData();
  const now = nowIso();
  if (context.topic_id && form.get("preference_form") === "1") {
    const visible = await preferenceTopics(c.env.DB, context.contact_id, context.topic_id);
    const selected = new Set(form.getAll("topic").map(String));
    await c.env.DB.batch(visible.map((topic) => c.env.DB.prepare(
      `INSERT INTO contact_topics (topic_id,contact_id,subscription,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(topic_id,contact_id) DO UPDATE SET subscription=excluded.subscription,updated_at=excluded.updated_at`,
    ).bind(topic.id, context.contact_id, selected.has(topic.id) ? "opt_in" : "opt_out", now)));
    return c.html(unsubscribePage({
      title: "Your preferences were updated",
      description: `Your email choices for ${context.email} have been saved.`,
      complete: true,
      state: "success",
    }));
  }
  if (context.topic_id && form.get("unsubscribe_all") !== "1") {
    await c.env.DB.prepare(
      `INSERT INTO contact_topics (topic_id,contact_id,subscription,updated_at) VALUES (?,?,'opt_out',?)
       ON CONFLICT(topic_id,contact_id) DO UPDATE SET subscription='opt_out',updated_at=excluded.updated_at`,
    ).bind(context.topic_id, context.contact_id, now).run();
    return c.html(unsubscribePage({
      title: `You’re unsubscribed from ${context.topic_name}`,
      description: `You will no longer receive this type of email at ${context.email}.`,
      complete: true,
      state: "success",
    }));
  }
  await c.env.DB.prepare("UPDATE contacts SET unsubscribed=1,updated_at=? WHERE id=?")
    .bind(now, context.contact_id).run();
  return c.html(unsubscribePage({
    title: "You’re unsubscribed from all emails",
    description: `No more broadcasts will be sent to ${context.email}.`,
    complete: true,
    state: "success",
  }));
});

apiApp.use("*", requireApiKey);
apiApp.use("*", idempotencyMiddleware);

apiApp.post("/segments", async (c) => {
  const body = await jsonBody(c.req.raw);
  const name = requiredString(body.name, "name", 200);
  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await c.env.DB.prepare("INSERT INTO segments (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(id, name, now, now).run();
  } catch (error) {
    if (isUniqueError(error)) throw new AppError(409, "conflict", "A segment with this name already exists.");
    throw error;
  }
  return c.json({ object: "segment", id, name });
});

apiApp.get("/segments", async (c) => {
  const page = pagination(c.req.query());
  const rows = await listRows<SegmentRow>(c.env.DB, "segments", page);
  return c.json({ object: "list", data: rows.items.map(segmentResponse), has_more: rows.hasMore });
});

apiApp.get("/segments/:id", async (c) => {
  const row = await getSegment(c.env.DB, c.req.param("id"));
  return c.json({ object: "segment", ...segmentResponse(row) });
});

apiApp.patch("/segments/:id", async (c) => {
  await getSegment(c.env.DB, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const name = requiredString(body.name, "name", 200);
  try {
    await c.env.DB.prepare("UPDATE segments SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name, nowIso(), c.req.param("id")).run();
  } catch (error) {
    if (isUniqueError(error)) throw new AppError(409, "conflict", "A segment with this name already exists.");
    throw error;
  }
  return c.json({ object: "segment", id: c.req.param("id") });
});

apiApp.delete("/segments/:id", async (c) => {
  await getSegment(c.env.DB, c.req.param("id"));
  try {
    await c.env.DB.prepare("DELETE FROM segments WHERE id = ?").bind(c.req.param("id")).run();
  } catch (error) {
    if (String(error).includes("FOREIGN KEY")) throw new AppError(409, "conflict", "Segment is used by a broadcast.");
    throw error;
  }
  return c.json({ object: "segment", id: c.req.param("id"), deleted: true });
});

apiApp.post("/topics", async (c) => {
  const body = await jsonBody(c.req.raw);
  const name = requiredString(body.name, "name", 50);
  const description = optionalString(body.description, "description", 200);
  const defaultSubscription = subscriptionValue(body.default_subscription, "default_subscription");
  const visibility = visibilityValue(body.visibility ?? "private");
  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await c.env.DB.prepare(
      "INSERT INTO topics (id,name,description,default_subscription,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(id, name, description, defaultSubscription, visibility, now, now).run();
  } catch (error) {
    if (isUniqueError(error)) throw new AppError(409, "conflict", "A topic with this name already exists.");
    throw error;
  }
  return c.json({ id });
});

apiApp.get("/topics", async (c) => {
  const rows = await listRows<TopicRow>(c.env.DB, "topics", pagination(c.req.query()));
  return c.json({ object: "list", data: rows.items.map(topicResponse), has_more: rows.hasMore });
});

apiApp.get("/topics/:id", async (c) => c.json(topicResponse(await getTopic(c.env.DB, c.req.param("id")))));

apiApp.patch("/topics/:id", async (c) => {
  const topic = await getTopic(c.env.DB, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const name = body.name === undefined ? topic.name : requiredString(body.name, "name", 50);
  const description = body.description === undefined ? topic.description : optionalString(body.description, "description", 200);
  const visibility = body.visibility === undefined ? topic.visibility : visibilityValue(body.visibility);
  try {
    await c.env.DB.prepare("UPDATE topics SET name=?,description=?,visibility=?,updated_at=? WHERE id=?")
      .bind(name, description, visibility, nowIso(), topic.id).run();
  } catch (error) {
    if (isUniqueError(error)) throw new AppError(409, "conflict", "A topic with this name already exists.");
    throw error;
  }
  return c.json({ id: topic.id });
});

apiApp.delete("/topics/:id", async (c) => {
  const topic = await getTopic(c.env.DB, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM topics WHERE id=?").bind(topic.id).run();
  return c.json({ object: "topic", id: topic.id, deleted: true });
});

apiApp.post("/contacts", async (c) => {
  const body = await jsonBody(c.req.raw);
  const email = normalizeEmail(requiredString(body.email, "email", 320));
  if (!isEmail(email)) throw new AppError(422, "validation_error", "email is invalid.");
  const id = crypto.randomUUID();
  const now = nowIso();
  const properties = safeJsonObject(body.properties);
  const segments = Array.isArray(body.segments) ? body.segments : [];
  const topics = Array.isArray(body.topics) ? body.topics : [];
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO contacts (id, email, first_name, last_name, properties_json, unsubscribed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      email,
      nullableName(body.first_name),
      nullableName(body.last_name),
      JSON.stringify(properties),
      body.unsubscribed === true ? 1 : 0,
      now,
      now,
    ),
  ];
  for (const item of segments) {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") {
      throw new AppError(422, "validation_error", "segments must contain objects with an id.");
    }
    await getSegment(c.env.DB, item.id);
    statements.push(c.env.DB.prepare(
      `INSERT INTO segment_contacts (segment_id, contact_id, status, subscribed_at, updated_at)
       VALUES (?, ?, 'subscribed', ?, ?)`,
    ).bind(item.id, id, now, now));
  }
  for (const item of topics) {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !("subscription" in item)) {
      throw new AppError(422, "validation_error", "topics must contain an id and subscription.");
    }
    await getTopic(c.env.DB, item.id);
    statements.push(c.env.DB.prepare(
      "INSERT INTO contact_topics (topic_id,contact_id,subscription,updated_at) VALUES (?,?,?,?)",
    ).bind(item.id, id, subscriptionValue(item.subscription, "subscription"), now));
  }
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (isUniqueError(error)) throw new AppError(409, "conflict", "A contact with this email already exists.");
    throw error;
  }
  return c.json({ object: "contact", id });
});

apiApp.get("/contacts", async (c) => {
  const rows = await listRows<ContactRow>(c.env.DB, "contacts", pagination(c.req.query()));
  return c.json({ object: "list", data: rows.items.map(contactResponse), has_more: rows.hasMore });
});

apiApp.get("/segments/:segmentId/contacts", async (c) => {
  await getSegment(c.env.DB, c.req.param("segmentId"));
  const page = pagination(c.req.query());
  const cursorFilter = await contactCursorFilter(c.env.DB, page);
  const direction = page.before ? "ASC" : "DESC";
  const result = await c.env.DB.prepare(
    `SELECT c.* FROM contacts c
     JOIN segment_contacts sc ON sc.contact_id = c.id
     WHERE sc.segment_id = ? AND sc.status = 'subscribed' ${cursorFilter.sql}
     ORDER BY c.created_at ${direction}, c.id ${direction} LIMIT ?`,
  ).bind(c.req.param("segmentId"), ...cursorFilter.bindings, page.limit + 1).all<ContactRow>();
  const items = result.results.slice(0, page.limit);
  if (page.before) items.reverse();
  return c.json({ object: "list", data: items.map(contactResponse), has_more: result.results.length > page.limit });
});

apiApp.get("/contacts/:identifier", async (c) => {
  const contact = await getContact(c.env.DB, c.req.param("identifier"));
  const raw = JSON.parse(contact.properties_json) as Record<string, string | number | boolean | null>;
  const properties = Object.fromEntries(Object.entries(raw)
    .filter((entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number")
    .map(([key, value]) => [key, { type: typeof value, value }]));
  return c.json({ object: "contact", ...contactResponse(contact), properties });
});

apiApp.patch("/contacts/:identifier", async (c) => {
  const contact = await getContact(c.env.DB, c.req.param("identifier"));
  const body = await jsonBody(c.req.raw);
  const properties = body.properties === undefined
    ? contact.properties_json
    : JSON.stringify({ ...JSON.parse(contact.properties_json) as JsonObject, ...safeJsonObject(body.properties) });
  await c.env.DB.prepare(
    `UPDATE contacts SET first_name = ?, last_name = ?, properties_json = ?, unsubscribed = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    body.first_name === undefined ? contact.first_name : nullableName(body.first_name),
    body.last_name === undefined ? contact.last_name : nullableName(body.last_name),
    properties,
    body.unsubscribed === undefined ? contact.unsubscribed : body.unsubscribed === true ? 1 : 0,
    nowIso(),
    contact.id,
  ).run();
  return c.json({ object: "contact", id: contact.id });
});

apiApp.delete("/contacts/:identifier", async (c) => {
  const contact = await getContact(c.env.DB, c.req.param("identifier"));
  await c.env.DB.prepare("DELETE FROM contacts WHERE id = ?").bind(contact.id).run();
  return c.json({ object: "contact", contact: contact.id, deleted: true });
});

apiApp.get("/contacts/:identifier/segments", async (c) => {
  const contact = await getContact(c.env.DB, c.req.param("identifier"));
  const result = await c.env.DB.prepare(
    `SELECT s.* FROM segments s JOIN segment_contacts sc ON sc.segment_id = s.id
     WHERE sc.contact_id = ? AND sc.status = 'subscribed' ORDER BY s.created_at DESC`,
  ).bind(contact.id).all<SegmentRow>();
  return c.json({ object: "list", data: result.results.map(segmentResponse), has_more: false });
});

apiApp.post("/contacts/:identifier/segments/:segmentId", async (c) => {
  const [contact] = await Promise.all([
    getContact(c.env.DB, c.req.param("identifier")),
    getSegment(c.env.DB, c.req.param("segmentId")),
  ]);
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO segment_contacts (segment_id, contact_id, status, subscribed_at, unsubscribed_at, updated_at)
     VALUES (?, ?, 'subscribed', ?, NULL, ?)
     ON CONFLICT(segment_id, contact_id) DO UPDATE SET status = 'subscribed', subscribed_at = excluded.subscribed_at,
       unsubscribed_at = NULL, updated_at = excluded.updated_at`,
  ).bind(c.req.param("segmentId"), contact.id, now, now).run();
  return c.json({ id: c.req.param("segmentId") });
});

apiApp.delete("/contacts/:identifier/segments/:segmentId", async (c) => {
  const contact = await getContact(c.env.DB, c.req.param("identifier"));
  await getSegment(c.env.DB, c.req.param("segmentId"));
  await c.env.DB.prepare(
    "UPDATE segment_contacts SET status = 'removed', updated_at = ? WHERE segment_id = ? AND contact_id = ?",
  ).bind(nowIso(), c.req.param("segmentId"), contact.id).run();
  return c.json({ id: contact.id, audienceId: c.req.param("segmentId"), deleted: true });
});

apiApp.get("/contacts/:identifier/topics", async (c) => {
  const contact = await getContact(c.env.DB, c.req.param("identifier"));
  const result = await c.env.DB.prepare(
    `SELECT t.id,t.name,t.description,COALESCE(ct.subscription,t.default_subscription) AS subscription
     FROM topics t LEFT JOIN contact_topics ct ON ct.topic_id=t.id AND ct.contact_id=?
     ORDER BY t.created_at DESC,t.id DESC`,
  ).bind(contact.id).all<{ id: string; name: string; description: string | null; subscription: "opt_in" | "opt_out" }>();
  return c.json({ object: "list", data: result.results, has_more: false });
});

apiApp.patch("/contacts/:identifier/topics", async (c) => {
  const contact = await getContact(c.env.DB, c.req.param("identifier"));
  const body = await c.req.raw.json<unknown>();
  if (!Array.isArray(body)) throw new AppError(422, "validation_error", "Request body must be an array of topic preferences.");
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !("subscription" in item)) {
      throw new AppError(422, "validation_error", "Each topic preference requires an id and subscription.");
    }
    await getTopic(c.env.DB, item.id);
    statements.push(c.env.DB.prepare(
      `INSERT INTO contact_topics (topic_id,contact_id,subscription,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(topic_id,contact_id) DO UPDATE SET subscription=excluded.subscription,updated_at=excluded.updated_at`,
    ).bind(item.id, contact.id, subscriptionValue(item.subscription, "subscription"), now));
  }
  if (statements.length) await c.env.DB.batch(statements);
  return c.json({ id: contact.id });
});

apiApp.post("/broadcasts", async (c) => {
  const body = await jsonBody(c.req.raw);
  const prepared = await prepareBroadcast(c.env.DB, body);
  const id = crypto.randomUUID();
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO broadcasts
       (id, name, segment_id, topic_id, sender_id, from_value, subject, reply_to_json, preview_text, html, text, status, scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, prepared.name, prepared.segmentId, prepared.topicId, prepared.sender.id, prepared.fromValue, prepared.subject,
    prepared.replyTo, prepared.previewText, prepared.html, prepared.text,
    prepared.scheduledAt ? "scheduled" : "draft", prepared.scheduledAt, now, now,
  ).run();

  if (body.send === true) {
    if (prepared.scheduledAt) await c.env.BROADCAST_SCHEDULE.getByName(id).schedule(id, prepared.scheduledAt);
    else await enqueueBroadcast(c.env, id);
  }
  return c.json({ id });
});

apiApp.get("/broadcasts", async (c) => {
  const rows = await listRows<BroadcastRow>(c.env.DB, "broadcasts", pagination(c.req.query()));
  return c.json({
    object: "list",
    has_more: rows.hasMore,
    data: rows.items.map((row) => {
      const full = broadcastResponse(row);
      return Object.fromEntries(Object.entries(full).filter(([key]) =>
        ["id", "name", "audience_id", "segment_id", "topic_id", "status", "created_at", "scheduled_at", "sent_at"].includes(key),
      ));
    }),
  });
});

apiApp.get("/broadcasts/:id", async (c) => c.json(broadcastResponse(await getBroadcast(c.env.DB, c.req.param("id")))));

apiApp.patch("/broadcasts/:id", async (c) => {
  const existing = await getBroadcast(c.env.DB, c.req.param("id"));
  if (existing.status !== "draft") throw new AppError(409, "conflict", "Only draft broadcasts can be updated.");
  const body = await jsonBody(c.req.raw);
  const merged: JsonObject = {
    name: body.name ?? existing.name,
    segment_id: body.segment_id ?? existing.segment_id,
    topic_id: body.topic_id === undefined ? existing.topic_id : body.topic_id,
    from: body.from ?? existing.from_value,
    subject: body.subject ?? existing.subject,
    reply_to: body.reply_to ?? (existing.reply_to_json ? JSON.parse(existing.reply_to_json) : undefined),
    preview_text: body.preview_text ?? existing.preview_text,
    html: body.html ?? existing.html,
    text: body.text ?? existing.text,
  };
  const prepared = await prepareBroadcast(c.env.DB, merged);
  await c.env.DB.prepare(
    `UPDATE broadcasts SET name = ?, segment_id = ?, topic_id = ?, sender_id = ?, from_value = ?, subject = ?, reply_to_json = ?,
      preview_text = ?, html = ?, text = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    prepared.name, prepared.segmentId, prepared.topicId, prepared.sender.id, prepared.fromValue, prepared.subject, prepared.replyTo,
    prepared.previewText, prepared.html, prepared.text, nowIso(), existing.id,
  ).run();
  return c.json({ id: existing.id });
});

apiApp.post("/broadcasts/:id/send", async (c) => {
  const broadcast = await getBroadcast(c.env.DB, c.req.param("id"));
  if (broadcast.status !== "draft") throw new AppError(409, "conflict", "Broadcast has already been sent or scheduled.");
  const body = await optionalJsonBody(c.req.raw);
  const scheduledAt = body.scheduled_at ? assertIsoFuture(requiredString(body.scheduled_at, "scheduled_at")) : null;
  if (scheduledAt) {
    await c.env.DB.prepare("UPDATE broadcasts SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?")
      .bind(scheduledAt, nowIso(), broadcast.id).run();
    await c.env.BROADCAST_SCHEDULE.getByName(broadcast.id).schedule(broadcast.id, scheduledAt);
  } else {
    await enqueueBroadcast(c.env, broadcast.id);
  }
  return c.json({ id: broadcast.id });
});

apiApp.post("/broadcasts/:id/cancel", async (c) => {
  const broadcast = await getBroadcast(c.env.DB, c.req.param("id"));
  if (["sent", "cancelled"].includes(broadcast.status)) {
    throw new AppError(409, "conflict", "Broadcast cannot be cancelled.");
  }
  await c.env.BROADCAST_SCHEDULE.getByName(broadcast.id).cancel();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE broadcasts SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(nowIso(), broadcast.id),
    c.env.DB.prepare("UPDATE deliveries SET status = 'cancelled', updated_at = ? WHERE broadcast_id = ? AND status IN ('pending', 'enqueued', 'deferred')").bind(nowIso(), broadcast.id),
  ]);
  return c.json({ object: "broadcast", id: broadcast.id });
});

apiApp.delete("/broadcasts/:id", async (c) => {
  const broadcast = await getBroadcast(c.env.DB, c.req.param("id"));
  if (["queued", "queueing", "sending", "scheduled"].includes(broadcast.status)) {
    await c.env.BROADCAST_SCHEDULE.getByName(broadcast.id).cancel();
  }
  await c.env.DB.prepare("DELETE FROM broadcasts WHERE id = ?").bind(broadcast.id).run();
  return c.json({ object: "broadcast", id: broadcast.id, deleted: true });
});

async function prepareBroadcast(db: D1Database, body: JsonObject): Promise<{
  name: string;
  segmentId: string;
  topicId: string | null;
  sender: SenderRow;
  fromValue: string;
  subject: string;
  replyTo: string | null;
  previewText: string | null;
  html: string | null;
  text: string | null;
  scheduledAt: string | null;
}> {
  const segmentId = requiredString(body.segment_id, "segment_id", 100);
  await getSegment(db, segmentId);
  const topicId = body.topic_id === undefined || body.topic_id === null || body.topic_id === ""
    ? null
    : requiredString(body.topic_id, "topic_id", 100);
  if (topicId) await getTopic(db, topicId);
  const fromValue = requiredString(body.from, "from", 500);
  const from = parseFrom(fromValue);
  if (!isEmail(from.email)) throw new AppError(422, "validation_error", "from is invalid.");
  const sender = await db.prepare("SELECT * FROM senders WHERE email = ? COLLATE NOCASE AND active = 1")
    .bind(from.email).first<SenderRow>();
  if (!sender) throw new AppError(422, "validation_error", "from must match an active registered sender.");
  const html = optionalString(body.html, "html", 1_000_000);
  const text = optionalString(body.text, "text", 1_000_000);
  if (!html && !text) throw new AppError(422, "missing_required_field", "Either html or text is required.");
  let replyTo: string | null = null;
  if (body.reply_to !== undefined && body.reply_to !== null) {
    const values = Array.isArray(body.reply_to) ? body.reply_to : [body.reply_to];
    if (values.length !== 1 || !values.every((value) => typeof value === "string" && isEmail(normalizeEmail(value)))) {
      throw new AppError(422, "validation_error", "reply_to must contain exactly one valid email address.");
    }
    replyTo = JSON.stringify(values);
  }
  const scheduledAt = body.scheduled_at ? assertIsoFuture(requiredString(body.scheduled_at, "scheduled_at")) : null;
  if (scheduledAt && body.send !== true) {
    throw new AppError(422, "invalid_parameter", "scheduled_at requires send to be true.");
  }
  return {
    name: optionalString(body.name, "name", 200) ?? requiredString(body.subject, "subject", 998),
    segmentId,
    topicId,
    sender,
    fromValue,
    subject: requiredString(body.subject, "subject", 998),
    replyTo,
    previewText: optionalString(body.preview_text, "preview_text", 500),
    html,
    text,
    scheduledAt,
  };
}

async function getSegment(db: D1Database, id: string): Promise<SegmentRow> {
  const row = await db.prepare("SELECT * FROM segments WHERE id = ?").bind(id).first<SegmentRow>();
  if (!row) throw new AppError(404, "not_found", "Segment not found.");
  return row;
}

async function getTopic(db: D1Database, id: string): Promise<TopicRow> {
  const row = await db.prepare("SELECT * FROM topics WHERE id = ?").bind(id).first<TopicRow>();
  if (!row) throw new AppError(404, "not_found", "Topic not found.");
  return row;
}

async function getContact(db: D1Database, identifier: string): Promise<ContactRow> {
  const normalized = normalizeEmail(identifier);
  const row = await db.prepare("SELECT * FROM contacts WHERE id = ? OR email = ? COLLATE NOCASE")
    .bind(identifier, normalized).first<ContactRow>();
  if (!row) throw new AppError(404, "not_found", "Contact not found.");
  return row;
}

async function getBroadcast(db: D1Database, id: string): Promise<BroadcastRow> {
  const row = await db.prepare("SELECT * FROM broadcasts WHERE id = ?").bind(id).first<BroadcastRow>();
  if (!row) throw new AppError(404, "not_found", "Broadcast not found.");
  return row;
}

function segmentResponse(row: SegmentRow): Record<string, unknown> {
  return { id: row.id, name: row.name, created_at: row.created_at };
}

function topicResponse(row: TopicRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    default_subscription: row.default_subscription,
    created_at: row.created_at,
  };
}

function subscriptionValue(value: unknown, field: string): "opt_in" | "opt_out" {
  if (value !== "opt_in" && value !== "opt_out") {
    throw new AppError(422, "validation_error", `${field} must be opt_in or opt_out.`);
  }
  return value;
}

function visibilityValue(value: unknown): "public" | "private" {
  if (value !== "public" && value !== "private") {
    throw new AppError(422, "validation_error", "visibility must be public or private.");
  }
  return value;
}

type Page = { limit: number; after?: string; before?: string };

function pagination(query: Record<string, string>): Page {
  const rawLimit = query.limit ? Number(query.limit) : 20;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    throw new AppError(422, "invalid_parameter", "limit must be between 1 and 100.");
  }
  if (query.after && query.before) throw new AppError(422, "invalid_parameter", "after and before cannot be used together.");
  return { limit: rawLimit, ...(query.after ? { after: query.after } : {}), ...(query.before ? { before: query.before } : {}) };
}

async function listRows<T extends { id: string; created_at: string }>(db: D1Database, table: "segments" | "topics" | "contacts" | "broadcasts", page: Page): Promise<{ items: T[]; hasMore: boolean }> {
  const cursor = page.after ?? page.before;
  let cursorRow: { id: string; created_at: string } | null = null;
  if (cursor) {
    cursorRow = await db.prepare(`SELECT id, created_at FROM ${table} WHERE id = ?`).bind(cursor).first<{ id: string; created_at: string }>();
    if (!cursorRow) throw new AppError(422, "invalid_parameter", "Invalid pagination cursor.");
  }
  const before = Boolean(page.before);
  const operator = before ? ">" : "<";
  const direction = before ? "ASC" : "DESC";
  const filter = cursorRow ? `WHERE (created_at ${operator} ? OR (created_at = ? AND id ${operator} ?))` : "";
  const bindings: unknown[] = cursorRow ? [cursorRow.created_at, cursorRow.created_at, cursorRow.id] : [];
  const result = await db.prepare(
    `SELECT * FROM ${table} ${filter} ORDER BY created_at ${direction}, id ${direction} LIMIT ?`,
  ).bind(...bindings, page.limit + 1).all<T>();
  const items = result.results.slice(0, page.limit);
  if (before) items.reverse();
  return { items, hasMore: result.results.length > page.limit };
}

async function contactCursorFilter(db: D1Database, page: Page): Promise<{ sql: string; bindings: unknown[] }> {
  const cursor = page.after ?? page.before;
  if (!cursor) return { sql: "", bindings: [] };
  const row = await db.prepare("SELECT id, created_at FROM contacts WHERE id = ?").bind(cursor)
    .first<{ id: string; created_at: string }>();
  if (!row) throw new AppError(422, "invalid_parameter", "Invalid pagination cursor.");
  const operator = page.before ? ">" : "<";
  return {
    sql: `AND (c.created_at ${operator} ? OR (c.created_at = ? AND c.id ${operator} ?))`,
    bindings: [row.created_at, row.created_at, row.id],
  };
}

async function jsonBody(request: Request): Promise<JsonObject> {
  const value = await optionalJsonBody(request);
  if (!Object.keys(value).length) throw new AppError(422, "missing_required_field", "A JSON request body is required.");
  return value;
}

async function optionalJsonBody(request: Request): Promise<JsonObject> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 2_000_000) throw new AppError(413, "validation_error", "Request body is too large.");
  const text = await request.text();
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as JsonObject;
  } catch {
    throw new AppError(400, "validation_error", "Request body must be a JSON object.");
  }
}

function nullableName(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, "name", 200);
}

function isUniqueError(error: unknown): boolean {
  return String(error).includes("UNIQUE constraint failed");
}

async function idempotencyMiddleware(c: Context<Bindings>, next: Next): Promise<Response | void> {
  if (!["POST", "PATCH", "DELETE"].includes(c.req.method) || !c.req.path.startsWith("/broadcasts")) {
    await next();
    return;
  }
  const key = c.req.header("Idempotency-Key");
  if (!key) {
    await next();
    return;
  }
  if (key.length > 256) throw new AppError(422, "invalid_parameter", "Idempotency-Key is too long.");
  const bodyText = await c.req.raw.clone().text();
  const requestHash = await sha256(`${c.req.method}\n${c.req.path}\n${bodyText}`);
  await c.env.DB.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").bind(nowIso()).run();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const reservation = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO idempotency_keys (key, request_hash, response_status, response_json, created_at, expires_at) VALUES (?, ?, NULL, NULL, ?, ?)",
  ).bind(key, requestHash, createdAt, expiresAt).run();
  const existing = await c.env.DB.prepare("SELECT * FROM idempotency_keys WHERE key = ?").bind(key).first<{
    request_hash: string;
    response_status: number | null;
    response_json: string | null;
  }>();
  if (!existing) throw new AppError(500, "application_error", "Could not reserve idempotency key.");
  if (existing.request_hash !== requestHash) {
    throw new AppError(409, "invalid_idempotent_request", "Idempotency-Key was already used for a different request.");
  }
  if (!reservation.meta.changes) {
    if (existing.response_json === null || existing.response_status === null) {
      throw new AppError(409, "concurrent_idempotent_requests", "A request with this Idempotency-Key is already in progress.");
    }
    return new Response(existing.response_json, { status: existing.response_status, headers: { "Content-Type": "application/json" } });
  }
  await next();
  if (c.res.status >= 200 && c.res.status < 300) {
    const responseJson = await c.res.clone().text();
    await c.env.DB.prepare(
      "UPDATE idempotency_keys SET response_status = ?, response_json = ? WHERE key = ? AND request_hash = ?",
    ).bind(c.res.status, responseJson, key, requestHash).run();
  } else {
    await c.env.DB.prepare("DELETE FROM idempotency_keys WHERE key = ? AND request_hash = ?")
      .bind(key, requestHash).run();
  }
}

async function findUnsubscribeContext(db: D1Database, token: string): Promise<{
  contact_id: string;
  email: string;
  topic_id: string | null;
  topic_name: string | null;
} | null> {
  const hash = await sha256(token);
  return db.prepare(
    `SELECT ut.contact_id, ut.topic_id, c.email, t.name AS topic_name
     FROM unsubscribe_tokens ut
     JOIN contacts c ON c.id = ut.contact_id
     LEFT JOIN topics t ON t.id = ut.topic_id
     WHERE ut.token_hash = ?`,
  ).bind(hash).first();
}

type PreferenceTopic = { id: string; name: string; description: string | null; subscription: "opt_in" | "opt_out" };

async function preferenceTopics(db: D1Database, contactId: string, currentTopicId: string): Promise<PreferenceTopic[]> {
  const result = await db.prepare(
    `SELECT t.id,t.name,t.description,COALESCE(ct.subscription,t.default_subscription) AS subscription
     FROM topics t
     LEFT JOIN contact_topics ct ON ct.topic_id=t.id AND ct.contact_id=?
     WHERE t.visibility='public' OR ct.subscription='opt_in' OR t.id=?
     ORDER BY t.name`,
  ).bind(contactId, currentTopicId).all<PreferenceTopic>();
  return result.results;
}

function topicPreferenceForms(topics: PreferenceTopic[]): string {
  const choices = topics.map((topic) => `<label class="topic-choice">
    <span><strong>${escapeHtml(topic.name)}</strong>${topic.description ? `<small>${escapeHtml(topic.description)}</small>` : ""}</span>
    <input type="checkbox" name="topic" value="${escapeHtml(topic.id)}" ${topic.subscription === "opt_in" ? "checked" : ""}>
  </label>`).join("");
  return `<form method="post" class="preferences"><input type="hidden" name="preference_form" value="1">${choices}<button type="submit">Save preferences</button></form>
    <form method="post" class="unsubscribe-all"><input type="hidden" name="unsubscribe_all" value="1"><button type="submit">Unsubscribe from all emails</button></form>`;
}

function unsubscribePage(input: { title: string; description: string; complete: boolean; state: "confirm" | "success" | "error" | "preview"; actions?: string }): string {
  const icon = input.state === "success" ? "✓" : input.state === "error" ? "!" : "↓";
  const label = input.state === "preview" ? "Preview" : input.state === "error" ? "Link unavailable" : input.state === "success" ? "Preferences updated" : "Email preferences";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Manage email preferences</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f4f5f7;background:#050609;color-scheme:dark}
    *{box-sizing:border-box}
    body{min-height:100vh;min-height:100dvh;margin:0;padding:24px;display:grid;place-items:center;background:radial-gradient(circle at 50% 15%,#111520 0,#07090e 34%,#050609 72%);color:#f4f5f7}
    .shell{width:min(760px,100%)}
    .card{overflow:hidden;border:1px solid #272b33;border-radius:24px;background:#0b0d12;box-shadow:0 28px 90px #0009}
    .content{padding:58px 64px 50px;text-align:center}
    .icon{display:grid;place-items:center;width:88px;height:88px;margin:0 auto 30px;border:1px solid #dce0e8;border-radius:50%;background:#f5f6f8;color:#20242c;font-size:34px;font-weight:650;box-shadow:0 12px 30px #0005}
    .error .icon{border-color:#5e2929;background:#2b1416;color:#ff9d9d}
    .eyebrow{margin:0 0 14px;color:#858b96;font-size:12px;font-weight:650;letter-spacing:.11em;text-transform:uppercase}
    h1{max-width:650px;margin:0 auto;color:#f5f6f8;font-size:clamp(28px,5vw,40px);line-height:1.13;letter-spacing:-.035em}
    .description{max-width:560px;margin:16px auto 0;color:#9399a5;font-size:17px;line-height:1.6}
    form{max-width:520px;margin:34px auto 0}
    .preferences{overflow:hidden;border:1px solid #292e37;border-radius:14px;text-align:left}
    .topic-choice{min-height:74px;padding:16px 18px;display:flex;align-items:center;gap:18px;border-bottom:1px solid #292e37;cursor:pointer}
    .topic-choice span{display:grid;gap:5px;flex:1}.topic-choice strong{font-size:15px}.topic-choice small{color:#9299a5;font-size:13px;line-height:1.4}
    .topic-choice input{width:20px;height:20px;accent-color:#fff}
    .preferences button{border:0;border-radius:0}.unsubscribe-all{margin-top:14px}.unsubscribe-all button{border-color:#4d292d;background:#241417;color:#ffb7bc}
    .unsubscribe-all button:hover{border-color:#744047;background:#331b20}
    button{width:100%;min-height:50px;border:1px solid #555c68;border-radius:11px;background:#3b414c;color:#fff;font:inherit;font-weight:650;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .15s ease}
    button:hover{border-color:#737b88;background:#4a515d}
    button:active{transform:translateY(1px)}
    button:focus-visible{outline:2px solid #8ab4ff;outline-offset:3px}
    @media(max-width:560px){body{padding:16px}.card{border-radius:19px}.content{padding:40px 22px 36px}.icon{width:72px;height:72px;margin-bottom:24px;font-size:28px}.eyebrow{margin-bottom:11px}h1{font-size:28px}.description{font-size:15px}form{margin-top:27px}}
  </style>
</head>
<body>
  <main class="shell">
    <section class="card ${input.state}">
      <div class="content">
        <div class="icon" aria-hidden="true">${icon}</div>
        <p class="eyebrow">${label}</p>
        <h1>${escapeHtml(input.title)}</h1>
        <p class="description">${escapeHtml(input.description)}</p>
        ${input.actions ?? ""}
      </div>
    </section>
  </main>
</body>
</html>`;
}
