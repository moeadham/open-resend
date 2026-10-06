import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { requireAccess, requireSameOrigin } from "./auth";
import { enqueueBroadcast, retryFailedDeliveries, sendTestEmail, validateBroadcastReady } from "./delivery";
import { AppError, appErrorResponse, assertIsoFuture, escapeHtml, isEmail, normalizeEmail, nowIso, parseSendingDomains, parseUnsubscribeHostnames, randomToken, sha256, stripHtml } from "./lib";
import type { BroadcastRow, ContactRow, SegmentRow, SenderRow, TopicRow } from "./types";

type Bindings = { Bindings: Env };
type AdminContext = Context<Bindings>;
type ContactListRow = { id: string; email: string; first_name: string | null; last_name: string | null; unsubscribed: number; suppression_reason: string | null; memberships: string | null; created_at: string };
type DomainRow = { id: string; name: string };

export const adminApp = new Hono<Bindings>();

adminApp.onError((error, c) => {
  const response = appErrorResponse(error);
  return c.html(<Layout title="Error"><div class="panel error"><h1>Request failed</h1><p>{error instanceof Error ? error.message : "Unknown error"}</p></div></Layout>, response.status as 400);
});
adminApp.use("*", requireAccess);
adminApp.use("*", requireSameOrigin);
adminApp.get("/assets/*", (c) => c.env.ASSETS.fetch(c.req.raw));

adminApp.get("/", (c) => c.redirect("/broadcasts", 302));

adminApp.get("/contacts", (c) => c.redirect("/audience", 302));
adminApp.get("/segments", (c) => c.redirect("/audience/segments", 302));
adminApp.get("/topics", (c) => c.redirect("/audience/topics", 302));

adminApp.get("/audience", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  const status = c.req.query("status") ?? "";
  const segmentId = c.req.query("segment") ?? "";
  const rawPage = Number(c.req.query("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (search) { conditions.push("c.email LIKE ?"); bindings.push(`%${search}%`); }
  if (status === "unsubscribed") conditions.push("c.unsubscribed = 1");
  if (status === "active") conditions.push("c.unsubscribed = 0 AND c.suppression_reason IS NULL");
  if (status === "suppressed") conditions.push("c.suppression_reason IS NOT NULL");
  if (segmentId) { conditions.push("EXISTS (SELECT 1 FROM segment_contacts x WHERE x.contact_id = c.id AND x.segment_id = ? AND x.status != 'removed')"); bindings.push(segmentId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const pageSize = 40;
  const [rows, filtered, metrics, segments] = await Promise.all([
    c.env.DB.prepare(`SELECT c.*, GROUP_CONCAT(CASE WHEN sc.status != 'removed' THEN s.name END) AS memberships
      FROM contacts c LEFT JOIN segment_contacts sc ON sc.contact_id = c.id LEFT JOIN segments s ON s.id = sc.segment_id
      ${where} GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, pageSize, (page - 1) * pageSize).all<ContactListRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM contacts c ${where}`).bind(...bindings).first<{ count: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN unsubscribed = 0 AND suppression_reason IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN unsubscribed = 1 OR suppression_reason IS NOT NULL THEN 1 ELSE 0 END) AS inactive FROM contacts`)
      .first<{ total: number; active: number; inactive: number }>(),
    c.env.DB.prepare("SELECT * FROM segments ORDER BY name").all<SegmentRow>(),
  ]);
  const total = Number(filtered?.count ?? 0);
  const queryFor = (targetPage: number) => `?${new URLSearchParams({ ...(search ? { search } : {}), ...(status ? { status } : {}), ...(segmentId ? { segment: segmentId } : {}), page: String(targetPage) })}`;
  return c.html(<Layout title="Audience"><PageHead title="Audience"><><ModalTrigger target="add-contacts">＋ Add contacts</ModalTrigger><Modal id="add-contacts" title="Add contacts"><form method="post" action="/contacts"><label>Email addresses</label><textarea name="emails" required placeholder="foo@gmail.com, bar@gmail.com"></textarea><p class="field-help">Use commas or line breaks to separate multiple email addresses.</p><label>Segment <span class="info-dot">i</span></label><select name="segment_id"><option value="">Optionally add to an existing segment…</option>{segments.results.map((segment) => <option value={segment.id}>{segment.name}</option>)}</select><ModalActions submitLabel="Add"/></form></Modal></></PageHead>
    <AudienceTabs active="contacts"/><div class="metric-strip"><Metric label="All contacts" value={metrics?.total ?? 0}/><Metric label="Globally subscribed" value={metrics?.active ?? 0}/><Metric label="Globally unsubscribed / suppressed" value={metrics?.inactive ?? 0}/></div>
    <form method="get" class="toolbar"><div class="search-field"><input name="search" value={search} placeholder="Search…" aria-label="Search contacts"/></div><select name="status" aria-label="Subscription status"><option value="">All global subscriptions</option><option value="active" selected={status === "active"}>Globally subscribed</option><option value="unsubscribed" selected={status === "unsubscribed"}>Globally unsubscribed</option><option value="suppressed" selected={status === "suppressed"}>Suppressed</option></select><select name="segment" aria-label="Segment"><option value="">All segments</option>{segments.results.map((segment) => <option value={segment.id} selected={segmentId === segment.id}>{segment.name}</option>)}</select><button>Filter</button></form>
    <div class="table-shell responsive-table"><table><thead><tr><th class="check-cell mobile-hide"><span class="fake-check"></span></th><th>Email</th><th class="mobile-hide">Segments</th><th class="narrow-hide">Status</th><th class="mobile-hide">Added</th><th></th></tr></thead><tbody>{rows.results.map((row) => { const rowStatus = row.suppression_reason ? "Suppressed" : row.unsubscribed ? "Unsubscribed" : "Subscribed"; return <tr class="clickable-row" data-row-href={`/contacts/${row.id}`} tabindex={0}><td class="mobile-hide"><span class="fake-check"></span></td><td><a class="row-title" href={`/contacts/${row.id}`}><span class="row-icon">@</span><span>{row.email}{(row.first_name || row.last_name) && <small>{[row.first_name, row.last_name].filter(Boolean).join(" ")}</small>}<small class="narrow-detail">{rowStatus}</small></span></a></td><td class="mobile-hide">{row.memberships ?? <span class="muted">—</span>}</td><td class="narrow-hide"><span class={`badge ${rowStatus === "Subscribed" ? "good" : "bad"}`}>{rowStatus}</span></td><td class="mobile-hide">{relativeDate(row.created_at)}</td><td class="row-action"><a class="button small-button" href={`/contacts/${row.id}`}>Open</a></td></tr>; })}</tbody></table>{!rows.results.length && <div class="empty">No contacts match these filters.</div>}</div>
    <div class="table-foot"><span>Page {page} · {total} contacts · 40 items</span><div class="push pagination">{page > 1 && <a class="button small-button" href={queryFor(page - 1)}>Newer</a>}{page * pageSize < total && <a class="button small-button" href={queryFor(page + 1)}>Older</a>}</div></div></Layout>);
});

adminApp.get("/audience/segments", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  const rows = await c.env.DB.prepare(`SELECT s.*,
      SUM(CASE WHEN sc.status != 'removed' THEN 1 ELSE 0 END) AS members
    FROM segments s LEFT JOIN segment_contacts sc ON sc.segment_id = s.id
    ${search ? "WHERE s.name LIKE ?" : ""} GROUP BY s.id ORDER BY s.created_at DESC`)
    .bind(...(search ? [`%${search}%`] : [])).all<SegmentRow & { members: number }>();
  return c.html(<Layout title="Audience segments"><PageHead title="Audience"><><ModalTrigger target="create-segment">＋ Create segment</ModalTrigger><Modal id="create-segment" title="Create segment"><form method="post" action="/segments"><label>Name</label><input name="name" required maxlength={200} placeholder="Product updates"/><ModalActions submitLabel="Create"/></form></Modal></></PageHead><AudienceTabs active="segments"/>
    <p class="muted">Segments are internal recipient groups used to target broadcasts. Recipients manage Topics, not segments.</p>
    <form method="get" class="toolbar" style="grid-template-columns:1fr auto"><div class="search-field"><input name="search" value={search} placeholder="Search…" aria-label="Search segments"/></div><button>Search</button></form>
    <div class="table-shell responsive-table"><table><thead><tr><th class="check-cell mobile-hide"><span class="fake-check"></span></th><th>Name</th><th class="mobile-hide">Contacts</th><th class="mobile-hide">Created</th><th></th></tr></thead><tbody>{rows.results.map((row) => <tr><td class="mobile-hide"><span class="fake-check"></span></td><td><div class="row-title"><span class="row-icon">♧</span><form method="post" action={`/segments/${row.id}`} class="inline-form"><input name="name" value={row.name} required maxlength={200}/><button class="small-button">Save</button></form></div></td><td class="mobile-hide">{row.members ?? 0}</td><td class="mobile-hide">{relativeDate(row.created_at)}</td><td class="row-action"><form method="post" action={`/segments/${row.id}/delete`} data-confirm="Delete this segment?"><button class="danger small-button">Delete</button></form></td></tr>)}</tbody></table>{!rows.results.length && <div class="empty">No segments yet.</div>}</div><div class="table-foot">{rows.results.length} segments</div></Layout>);
});

adminApp.post("/segments", async (c) => {
  const form = await c.req.parseBody(); const now = nowIso();
  await c.env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), textField(form.name, "name", 200), now, now).run();
  return c.redirect("/audience/segments", 303);
});
adminApp.post("/segments/:id", async (c) => {
  const form = await c.req.parseBody();
  const result = await c.env.DB.prepare("UPDATE segments SET name=?,updated_at=? WHERE id=?")
    .bind(textField(form.name, "name", 200), nowIso(), c.req.param("id")).run();
  if (!result.meta.changes) throw new AppError(404, "not_found", "Segment not found.");
  return c.redirect("/audience/segments", 303);
});
adminApp.post("/segments/:id/delete", async (c) => {
  await c.env.DB.prepare("DELETE FROM segments WHERE id=?").bind(c.req.param("id")).run();
  return c.redirect("/audience/segments", 303);
});

adminApp.get("/audience/topics", async (c) => {
  const topics = await c.env.DB.prepare("SELECT * FROM topics ORDER BY created_at DESC").all<TopicRow>();
  return c.html(<Layout title="Audience topics"><PageHead title="Audience"><><ModalTrigger target="create-topic">＋ Create topic</ModalTrigger><Modal id="create-topic" title="Create topic"><form method="post" action="/topics"><label>Name</label><input name="name" required maxlength={50} placeholder="Product updates"/><label>Description</label><textarea name="description" maxlength={200} placeholder="News about product improvements"></textarea><label>Default subscription</label><select name="default_subscription" required><option value="opt_in">Opted in</option><option value="opt_out">Opted out</option></select><label>Visibility</label><select name="visibility" required><option value="public">Public — shown on preference pages</option><option value="private">Private — shown only when explicitly subscribed</option></select><ModalActions submitLabel="Create"/></form></Modal></></PageHead><AudienceTabs active="topics"/>
    <p class="muted">Topics are recipient-facing email preferences. Tag a broadcast with a Topic to let recipients opt out of that category without leaving every broadcast.</p>
    <div class="table-shell responsive-table"><table><thead><tr><th>Name</th><th class="mobile-hide">Default</th><th class="mobile-hide">Visibility</th><th></th></tr></thead><tbody>{topics.results.map((topic) => <tr><td><form method="post" action={`/topics/${topic.id}`} class="inline-form topic-edit"><span class="row-icon">☷</span><input name="name" value={topic.name} required maxlength={50}/><input name="description" value={topic.description ?? ""} maxlength={200} placeholder="Description"/><select name="visibility"><option value="public" selected={topic.visibility === "public"}>Public</option><option value="private" selected={topic.visibility === "private"}>Private</option></select><button class="small-button">Save</button></form></td><td class="mobile-hide">{topic.default_subscription === "opt_in" ? "Opted in" : "Opted out"}</td><td class="mobile-hide">{capitalize(topic.visibility)}</td><td class="row-action"><form method="post" action={`/topics/${topic.id}/delete`} data-confirm="Delete this topic? Existing broadcasts will become untagged."><button class="danger small-button">Delete</button></form></td></tr>)}</tbody></table>{!topics.results.length && <div class="empty">No topics yet. Untagged broadcasts use global unsubscribe.</div>}</div></Layout>);
});

adminApp.post("/topics", async (c) => {
  const form = await c.req.parseBody(); const now = nowIso();
  const defaultSubscription = String(form.default_subscription ?? "");
  const visibility = String(form.visibility ?? "");
  if (!['opt_in','opt_out'].includes(defaultSubscription) || !['public','private'].includes(visibility)) throw new AppError(422, "validation_error", "Topic settings are invalid.");
  await c.env.DB.prepare("INSERT INTO topics (id,name,description,default_subscription,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), textField(form.name, "name", 50), optionalFormText(form.description, 200), defaultSubscription, visibility, now, now).run();
  return c.redirect("/audience/topics", 303);
});

adminApp.post("/topics/:id", async (c) => {
  const form = await c.req.parseBody(); const visibility = String(form.visibility ?? "");
  if (!['public','private'].includes(visibility)) throw new AppError(422, "validation_error", "Topic visibility is invalid.");
  const result = await c.env.DB.prepare("UPDATE topics SET name=?,description=?,visibility=?,updated_at=? WHERE id=?")
    .bind(textField(form.name, "name", 50), optionalFormText(form.description, 200), visibility, nowIso(), c.req.param("id")).run();
  if (!result.meta.changes) throw new AppError(404, "not_found", "Topic not found.");
  return c.redirect("/audience/topics", 303);
});

adminApp.post("/topics/:id/delete", async (c) => {
  await c.env.DB.prepare("DELETE FROM topics WHERE id=?").bind(c.req.param("id")).run();
  return c.redirect("/audience/topics", 303);
});

adminApp.post("/contacts", async (c) => {
  const form = await c.req.parseBody();
  const emails = textField(form.emails, "emails", 100_000).split(/[\s,;]+/).map(normalizeEmail).filter(Boolean);
  const segmentId = String(form.segment_id ?? "").trim();
  if (!emails.length || emails.some((email) => !isEmail(email))) throw new AppError(422, "validation_error", "One or more email addresses are invalid.");
  if (segmentId && !await c.env.DB.prepare("SELECT id FROM segments WHERE id=?").bind(segmentId).first()) throw new AppError(404, "not_found", "Segment not found.");
  for (const email of [...new Set(emails)]) {
    const now = nowIso();
    await c.env.DB.prepare(`INSERT INTO contacts (id,email,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET updated_at=excluded.updated_at`)
      .bind(crypto.randomUUID(), email, now, now).run();
    const contact = await c.env.DB.prepare("SELECT id FROM contacts WHERE email=?").bind(email).first<{ id: string }>();
    if (contact && segmentId) await c.env.DB.prepare(`INSERT INTO segment_contacts (segment_id,contact_id,status,subscribed_at,updated_at) VALUES (?,?,'subscribed',?,?)
      ON CONFLICT(segment_id,contact_id) DO UPDATE SET status='subscribed',subscribed_at=excluded.subscribed_at,unsubscribed_at=NULL,updated_at=excluded.updated_at`)
      .bind(segmentId, contact.id, now, now).run();
  }
  return c.redirect("/audience", 303);
});

adminApp.get("/contacts/:id", async (c) => {
  const contactId = c.req.param("id");
  const [contact, memberships, segments, topics] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM contacts WHERE id=?").bind(contactId).first<ContactRow>(),
    c.env.DB.prepare(`SELECT s.id,s.name,sc.status,sc.subscribed_at,sc.unsubscribed_at
      FROM segment_contacts sc JOIN segments s ON s.id=sc.segment_id
      WHERE sc.contact_id=? AND sc.status != 'removed' ORDER BY s.name`).bind(contactId).all<{ id: string; name: string; status: string; subscribed_at: string; unsubscribed_at: string | null }>(),
    c.env.DB.prepare("SELECT id,name FROM segments ORDER BY name").all<Pick<SegmentRow, "id" | "name">>(),
    c.env.DB.prepare(`SELECT t.id,t.name,t.description,COALESCE(ct.subscription,t.default_subscription) AS subscription
      FROM topics t LEFT JOIN contact_topics ct ON ct.topic_id=t.id AND ct.contact_id=? ORDER BY t.name`)
      .bind(contactId).all<{ id: string; name: string; description: string | null; subscription: "opt_in" | "opt_out" }>(),
  ]);
  if (!contact) throw new AppError(404, "not_found", "Contact not found.");
  const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
  const status = contact.suppression_reason ? "Suppressed" : contact.unsubscribed ? "Globally unsubscribed" : "Globally subscribed";
  return c.html(<Layout title="Audience contact"><div class="detail-head"><div><a class="crumb" href="/audience">← Audience</a><h1>{displayName || contact.email}</h1><p class="muted">{displayName ? contact.email : "Contact details and email preferences"}</p></div><span class={`badge ${status === "Globally subscribed" ? "good" : "bad"}`}>{status}</span></div>
    {contact.suppression_reason && <div class="panel error"><strong>Globally suppressed</strong><p>{contact.suppression_reason}</p></div>}
    <div class="detail-grid"><section class="panel"><h2 class="section-title">Contact details</h2><form method="post" action={`/contacts/${contact.id}`}><label>Email</label><input name="email" type="email" value={contact.email} required/><div class="form-grid"><div><label>First name</label><input name="first_name" value={contact.first_name ?? ""}/></div><div><label>Last name</label><input name="last_name" value={contact.last_name ?? ""}/></div></div><div class="actions form-actions"><button class="primary">Save contact</button></div></form></section>
      <section class="panel"><h2 class="section-title">Global subscription</h2><p class="muted">This setting applies across every segment. Hard bounces and complaints remain suppressed.</p><form method="post" action={`/contacts/${contact.id}/subscription`}><input type="hidden" name="subscribed" value={contact.unsubscribed ? "true" : "false"}/><button class={contact.unsubscribed ? "primary" : "danger"}>{contact.unsubscribed ? "Globally resubscribe" : "Globally unsubscribe"}</button></form></section></div>
    <section class="panel"><div class="section-head"><div><h2 class="section-title">Segments</h2><p class="muted">Segments are internal recipient groups. Membership determines which broadcasts target this contact.</p></div>{segments.results.length > 0 && <form method="post" action={`/contacts/${contact.id}/segments`} class="inline-form segment-add"><select name="segment_id" required><option value="">Select segment…</option>{segments.results.map((segment) => <option value={segment.id}>{segment.name}</option>)}</select><button class="primary">Add</button></form>}</div>
      <div class="table-shell responsive-table"><table><thead><tr><th>Segment</th><th class="mobile-hide">Added</th><th></th></tr></thead><tbody>{memberships.results.map((membership) => <tr><td>{membership.name}</td><td class="mobile-hide">{relativeDate(membership.subscribed_at)}</td><td><form method="post" action={`/contacts/${contact.id}/segments/${membership.id}`}><input type="hidden" name="status" value="removed"/><button class="danger small-button">Remove</button></form></td></tr>)}</tbody></table>{!memberships.results.length && <div class="empty">This contact is not in a segment yet.</div>}</div></section>
    <section class="panel"><div class="section-head"><div><h2 class="section-title">Topics</h2><p class="muted">Topics are recipient-facing preferences and apply across segments.</p></div></div><div class="table-shell responsive-table"><table><thead><tr><th>Topic</th><th>Preference</th><th></th></tr></thead><tbody>{topics.results.map((topic) => <tr><td><strong>{topic.name}</strong>{topic.description && <small class="mobile-detail">{topic.description}</small>}</td><td><span class={`badge ${topic.subscription === "opt_in" ? "good" : "bad"}`}>{topic.subscription === "opt_in" ? "Opted in" : "Opted out"}</span></td><td><form method="post" action={`/contacts/${contact.id}/topics/${topic.id}`}><input type="hidden" name="subscription" value={topic.subscription === "opt_in" ? "opt_out" : "opt_in"}/><button class="small-button">{topic.subscription === "opt_in" ? "Opt out" : "Opt in"}</button></form></td></tr>)}</tbody></table>{!topics.results.length && <div class="empty">No Topics have been created.</div>}</div></section>
    <section class="panel danger-zone"><h2 class="section-title">Delete contact</h2><p class="muted">This permanently removes the contact and all segment memberships.</p><form method="post" action={`/contacts/${contact.id}/delete`} data-confirm="Delete this contact permanently?"><button class="danger">Delete contact</button></form></section></Layout>);
});

adminApp.post("/contacts/:id", async (c) => {
  const form = await c.req.parseBody();
  const email = normalizeEmail(textField(form.email, "email", 320));
  if (!isEmail(email)) throw new AppError(422, "validation_error", "Email is invalid.");
  const firstName = optionalFormText(form.first_name, 200);
  const lastName = optionalFormText(form.last_name, 200);
  const result = await c.env.DB.prepare("UPDATE contacts SET email=?,first_name=?,last_name=?,updated_at=? WHERE id=?")
    .bind(email, firstName, lastName, nowIso(), c.req.param("id")).run();
  if (!result.meta.changes) throw new AppError(404, "not_found", "Contact not found.");
  return c.redirect(`/contacts/${c.req.param("id")}`, 303);
});

adminApp.post("/contacts/:id/subscription", async (c) => {
  const form = await c.req.parseBody();
  const subscribed = String(form.subscribed ?? "") === "true";
  const result = await c.env.DB.prepare("UPDATE contacts SET unsubscribed=?,updated_at=? WHERE id=?")
    .bind(subscribed ? 0 : 1, nowIso(), c.req.param("id")).run();
  if (!result.meta.changes) throw new AppError(404, "not_found", "Contact not found.");
  return c.redirect(`/contacts/${c.req.param("id")}`, 303);
});

adminApp.post("/contacts/:id/segments", async (c) => {
  const form = await c.req.parseBody();
  const segmentId = textField(form.segment_id, "segment_id", 100);
  const [contact, segment] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM contacts WHERE id=?").bind(c.req.param("id")).first(),
    c.env.DB.prepare("SELECT id FROM segments WHERE id=?").bind(segmentId).first(),
  ]);
  if (!contact || !segment) throw new AppError(404, "not_found", "Contact or segment not found.");
  const now = nowIso();
  await c.env.DB.prepare(`INSERT INTO segment_contacts (segment_id,contact_id,status,subscribed_at,unsubscribed_at,updated_at)
    VALUES (?,?,'subscribed',?,NULL,?) ON CONFLICT(segment_id,contact_id) DO UPDATE SET status='subscribed',subscribed_at=excluded.subscribed_at,unsubscribed_at=NULL,updated_at=excluded.updated_at`)
    .bind(segmentId, c.req.param("id"), now, now).run();
  return c.redirect(`/contacts/${c.req.param("id")}`, 303);
});

adminApp.post("/contacts/:id/segments/:segmentId", async (c) => {
  const form = await c.req.parseBody();
  const status = String(form.status ?? "");
  if (!['subscribed','removed'].includes(status)) throw new AppError(422, "validation_error", "Membership status is invalid.");
  const now = nowIso();
  const result = status === "subscribed"
    ? await c.env.DB.prepare("UPDATE segment_contacts SET status='subscribed',subscribed_at=?,unsubscribed_at=NULL,updated_at=? WHERE contact_id=? AND segment_id=?").bind(now, now, c.req.param("id"), c.req.param("segmentId")).run()
    : await c.env.DB.prepare("UPDATE segment_contacts SET status='removed',updated_at=? WHERE contact_id=? AND segment_id=?").bind(now, c.req.param("id"), c.req.param("segmentId")).run();
  if (!result.meta.changes) throw new AppError(404, "not_found", "Segment membership not found.");
  return c.redirect(`/contacts/${c.req.param("id")}`, 303);
});

adminApp.post("/contacts/:id/topics/:topicId", async (c) => {
  const form = await c.req.parseBody(); const subscription = String(form.subscription ?? "");
  if (!['opt_in','opt_out'].includes(subscription)) throw new AppError(422, "validation_error", "Topic preference is invalid.");
  const [contact, topic] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM contacts WHERE id=?").bind(c.req.param("id")).first(),
    c.env.DB.prepare("SELECT id FROM topics WHERE id=?").bind(c.req.param("topicId")).first(),
  ]);
  if (!contact || !topic) throw new AppError(404, "not_found", "Contact or topic not found.");
  await c.env.DB.prepare(`INSERT INTO contact_topics (topic_id,contact_id,subscription,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(topic_id,contact_id) DO UPDATE SET subscription=excluded.subscription,updated_at=excluded.updated_at`)
    .bind(c.req.param("topicId"), c.req.param("id"), subscription, nowIso()).run();
  return c.redirect(`/contacts/${c.req.param("id")}`, 303);
});

adminApp.post("/contacts/:id/delete", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(c.req.param("id")).run();
  if (!result.meta.changes) throw new AppError(404, "not_found", "Contact not found.");
  return c.redirect("/audience", 303);
});

adminApp.get("/broadcasts", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  const status = c.req.query("status") ?? "";
  const segmentId = c.req.query("segment") ?? "";
  const rawPage = Number(c.req.query("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = 40;
  const conditions: string[] = []; const bindings: unknown[] = [];
  if (search) { conditions.push("(b.name LIKE ? OR b.subject LIKE ?)"); bindings.push(`%${search}%`, `%${search}%`); }
  if (status) { conditions.push("b.status = ?"); bindings.push(status); }
  if (segmentId) { conditions.push("b.segment_id = ?"); bindings.push(segmentId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [broadcasts, filtered, segments] = await Promise.all([
    c.env.DB.prepare(`SELECT b.*,s.name AS segment_name FROM broadcasts b JOIN segments s ON s.id=b.segment_id ${where} ORDER BY b.updated_at DESC,b.id DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, pageSize, (page - 1) * pageSize).all<BroadcastRow & { segment_name: string }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM broadcasts b ${where}`).bind(...bindings).first<{ count: number }>(),
    c.env.DB.prepare("SELECT * FROM segments ORDER BY name").all<SegmentRow>(),
  ]);
  const total = Number(filtered?.count ?? 0);
  const queryFor = (targetPage: number) => `?${new URLSearchParams({ ...(search ? { search } : {}), ...(status ? { status } : {}), ...(segmentId ? { segment: segmentId } : {}), page: String(targetPage) })}`;
  return c.html(<Layout title="Broadcasts"><PageHead title="Broadcasts"><a class="button primary" href="/broadcasts/new">＋ Create broadcast</a></PageHead>
    <form method="get" class="toolbar"><div class="search-field"><input name="search" value={search} placeholder="Search…" aria-label="Search broadcasts"/></div><select name="status"><option value="">All statuses</option>{["draft","scheduled","queued","sending","sent","cancelled"].map((item) => <option value={item} selected={status === item}>{capitalize(item)}</option>)}</select><select name="segment"><option value="">All audiences</option>{segments.results.map((segment) => <option value={segment.id} selected={segmentId === segment.id}>{segment.name}</option>)}</select><button>Filter</button></form>
    <div class="table-shell responsive-table"><table><thead><tr><th class="check-cell mobile-hide"><span class="fake-check"></span></th><th>Name</th><th class="narrow-hide">Status</th><th class="mobile-hide">Audience</th><th class="mobile-hide">Updated</th><th></th></tr></thead><tbody>{broadcasts.results.map((broadcast) => <tr class="clickable-row" data-row-href={`/broadcasts/${broadcast.id}`} tabindex={0}><td class="mobile-hide"><span class="fake-check"></span></td><td><a class="row-title" href={`/broadcasts/${broadcast.id}`}><span class="row-icon">◉</span><span>{broadcast.name}<small>{broadcast.subject}</small><small class="narrow-detail">{capitalize(broadcast.status)}</small></span></a></td><td class="narrow-hide"><span class={`badge ${broadcast.status}`}>{broadcast.status}</span></td><td class="mobile-hide">{broadcast.segment_name}</td><td class="mobile-hide">{relativeDate(broadcast.updated_at)}</td><td class="row-action"><a class={`button small-button ${broadcast.status === "draft" ? "primary" : ""}`} href={`/broadcasts/${broadcast.id}`}>{broadcast.status === "draft" ? "Review & send" : "Open"}</a></td></tr>)}</tbody></table>{!broadcasts.results.length && <div class="empty">No broadcasts match these filters.</div>}</div><div class="table-foot"><span>Page {page} · {total} broadcasts · 40 items</span><div class="push pagination">{page > 1 && <a class="button small-button" href={queryFor(page - 1)}>Newer</a>}{page * pageSize < total && <a class="button small-button" href={queryFor(page + 1)}>Older</a>}</div></div></Layout>);
});

adminApp.get("/broadcasts/new", async (c) => {
  const [segments, senders, domains, topics] = await broadcastOptions(c);
  return c.html(<Layout title="New broadcast"><BroadcastEditor segments={segments.results} senders={senders.results} domains={domains} topics={topics.results}/></Layout>);
});

adminApp.post("/broadcasts", async (c) => {
  const form = await c.req.parseBody();
  const prepared = await adminBroadcastFields(c, form);
  const id = crypto.randomUUID(); const now = nowIso();
  await c.env.DB.prepare(`INSERT INTO broadcasts (id,name,segment_id,topic_id,sender_id,from_value,subject,preview_text,html,text,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?)`).bind(id, prepared.name, prepared.segmentId, prepared.topicId, prepared.sender.id, `${prepared.sender.name} <${prepared.sender.email}>`, prepared.subject, prepared.previewText, prepared.html, stripHtml(prepared.html), now, now).run();
  return c.redirect(`/broadcasts/${id}`, 303);
});

adminApp.get("/broadcasts/:id/editor", async (c) => {
  const [segments, senders, domains, topics] = await broadcastOptions(c);
  const broadcast = await c.env.DB.prepare("SELECT * FROM broadcasts WHERE id=?").bind(c.req.param("id")).first<BroadcastRow>();
  if (!broadcast) throw new AppError(404, "not_found", "Broadcast not found.");
  if (broadcast.status !== "draft") return c.redirect(`/broadcasts/${broadcast.id}`, 302);
  return c.html(<Layout title={`${broadcast.name} editor`}><BroadcastEditor broadcast={broadcast} segments={segments.results} senders={senders.results} domains={domains} topics={topics.results}/></Layout>);
});

adminApp.post("/broadcasts/:id/editor", async (c) => {
  const existing = await c.env.DB.prepare("SELECT status FROM broadcasts WHERE id=?").bind(c.req.param("id")).first<{ status: string }>();
  if (!existing) throw new AppError(404, "not_found", "Broadcast not found.");
  if (existing.status !== "draft") throw new AppError(409, "conflict", "Only draft broadcasts can be edited.");
  const prepared = await adminBroadcastFields(c, await c.req.parseBody());
  await c.env.DB.prepare(`UPDATE broadcasts SET name=?,segment_id=?,topic_id=?,sender_id=?,from_value=?,subject=?,preview_text=?,html=?,text=?,updated_at=? WHERE id=?`)
    .bind(prepared.name, prepared.segmentId, prepared.topicId, prepared.sender.id, `${prepared.sender.name} <${prepared.sender.email}>`, prepared.subject, prepared.previewText, prepared.html, stripHtml(prepared.html), nowIso(), c.req.param("id")).run();
  return c.redirect(`/broadcasts/${c.req.param("id")}`, 303);
});

adminApp.get("/broadcasts/:id", async (c) => {
  const broadcast = await c.env.DB.prepare(`SELECT b.*,s.email AS sender_email,s.name AS sender_name,sg.name AS segment_name,t.name AS topic_name FROM broadcasts b JOIN senders s ON s.id=b.sender_id JOIN segments sg ON sg.id=b.segment_id LEFT JOIN topics t ON t.id=b.topic_id WHERE b.id=?`)
    .bind(c.req.param("id")).first<BroadcastRow & { sender_email: string; sender_name: string; segment_name: string; topic_name: string | null }>();
  if (!broadcast) throw new AppError(404, "not_found", "Broadcast not found.");
  const [counts, deliveries] = await Promise.all([
    c.env.DB.prepare("SELECT status,COUNT(*) AS count FROM deliveries WHERE broadcast_id=? GROUP BY status").bind(broadcast.id).all<{ status: string; count: number }>(),
    c.env.DB.prepare("SELECT recipient,status,attempts,message_id,last_error,updated_at FROM deliveries WHERE broadcast_id=? ORDER BY updated_at DESC LIMIT 100").bind(broadcast.id).all<{ recipient: string; status: string; attempts: number; message_id: string | null; last_error: string | null; updated_at: string }>(),
  ]);
  return c.html(<Layout title={broadcast.name}><div class="editor-head"><a class="crumb" href="/broadcasts">← Broadcasts</a><strong>/</strong><strong>{broadcast.name}</strong><span class={`badge ${broadcast.status}`}>{broadcast.status}</span><div class="push actions">{broadcast.status === "draft" && <><a class="button" href={`/broadcasts/${broadcast.id}/editor`}>Edit</a><form method="post" action={`/broadcasts/${broadcast.id}/send`} data-confirm="Send this broadcast now?"><button class="primary">Send now</button></form></>}{!['sent','cancelled','draft'].includes(broadcast.status) && <form method="post" action={`/broadcasts/${broadcast.id}/cancel`} data-confirm="Cancel unsent deliveries?"><button class="danger">Cancel</button></form>}</div></div>
    <div class="grid"><Stat label="Audience" value={broadcast.segment_name}/><Stat label="Topic" value={broadcast.topic_name ?? "None · global unsubscribe"}/><Stat label="Sender" value={broadcast.sender_name}/>{counts.results.map((row) => <Stat label={capitalize(row.status)} value={row.count}/>)}</div>
    <div class="panel"><h2 class="section-title">{broadcast.subject}</h2><iframe title="Campaign preview" sandbox="" class="preview-frame" srcdoc={broadcast.html ?? `<pre>${escapeHtml(broadcast.text)}</pre>`}></iframe></div>
    <div class="panel actions">{broadcast.status === "draft" && <form method="post" action={`/broadcasts/${broadcast.id}/schedule`} data-schedule-form><input type="datetime-local" data-schedule-local required/><input type="hidden" name="scheduled_at"/><button>Schedule</button></form>}<form method="post" action={`/broadcasts/${broadcast.id}/test`}><input name="email" type="email" placeholder="Test recipient" required/><button>Send test</button></form>{broadcast.status !== "cancelled" && counts.results.some((row) => row.status === "failed" && row.count > 0) && <form method="post" action={`/broadcasts/${broadcast.id}/retry`}><button>Retry failures</button></form>}</div>
    {deliveries.results.length > 0 && <div class="table-shell responsive-table"><table><thead><tr><th>Recipient</th><th>Status</th><th class="mobile-hide">Attempts</th><th class="mobile-hide">Message ID / error</th><th class="mobile-hide">Updated</th></tr></thead><tbody>{deliveries.results.map((delivery) => <tr><td>{delivery.recipient}</td><td><span class={`badge ${delivery.status}`}>{delivery.status}</span></td><td class="mobile-hide">{delivery.attempts}</td><td class="muted mobile-hide">{delivery.last_error ?? delivery.message_id ?? "—"}</td><td class="mobile-hide">{relativeDate(delivery.updated_at)}</td></tr>)}</tbody></table></div>}</Layout>);
});

adminApp.post("/broadcasts/:id/send", async (c) => { await enqueueBroadcast(c.env, c.req.param("id")); return c.redirect(`/broadcasts/${c.req.param("id")}`, 303); });
adminApp.post("/broadcasts/:id/schedule", async (c) => {
  const form = await c.req.parseBody(); const scheduledAt = assertIsoFuture(textField(form.scheduled_at, "scheduled_at", 100));
  await validateBroadcastReady(c.env, c.req.param("id"));
  const broadcast = await c.env.DB.prepare("SELECT status FROM broadcasts WHERE id=?").bind(c.req.param("id")).first<{ status: string }>();
  if (!broadcast || broadcast.status !== "draft") throw new AppError(409, "conflict", "Only draft broadcasts can be scheduled.");
  await c.env.DB.prepare("UPDATE broadcasts SET status='scheduled',scheduled_at=?,updated_at=? WHERE id=?").bind(scheduledAt, nowIso(), c.req.param("id")).run();
  await c.env.BROADCAST_SCHEDULE.getByName(c.req.param("id")).schedule(c.req.param("id"), scheduledAt);
  return c.redirect(`/broadcasts/${c.req.param("id")}`, 303);
});
adminApp.post("/broadcasts/:id/cancel", async (c) => {
  await c.env.BROADCAST_SCHEDULE.getByName(c.req.param("id")).cancel();
  await c.env.DB.batch([c.env.DB.prepare("UPDATE broadcasts SET status='cancelled',updated_at=? WHERE id=?").bind(nowIso(), c.req.param("id")), c.env.DB.prepare("UPDATE deliveries SET status='cancelled',updated_at=? WHERE broadcast_id=? AND status IN ('pending','enqueued','deferred')").bind(nowIso(), c.req.param("id"))]);
  return c.redirect(`/broadcasts/${c.req.param("id")}`, 303);
});
adminApp.post("/broadcasts/:id/test", async (c) => {
  const form = await c.req.parseBody(); const to = normalizeEmail(textField(form.email, "email", 320));
  if (!isEmail(to)) throw new AppError(422, "validation_error", "Test recipient is invalid.");
  const row = await c.env.DB.prepare(`SELECT b.subject,b.html,b.text,s.email,s.name,s.reply_to,s.postal_address,d.name AS domain FROM broadcasts b JOIN senders s ON s.id=b.sender_id JOIN domains d ON d.id=s.domain_id WHERE b.id=?`).bind(c.req.param("id")).first<{ subject: string; html: string | null; text: string | null; email: string; name: string; reply_to: string | null; postal_address: string; domain: string }>();
  if (!row) throw new AppError(404, "not_found", "Broadcast not found.");
  await sendTestEmail(c.env, { to, sender: row, subject: row.subject, html: row.html ?? `<p>${escapeHtml(row.text)}</p>`, text: row.text });
  return c.redirect(`/broadcasts/${c.req.param("id")}`, 303);
});
adminApp.post("/broadcasts/:id/retry", async (c) => { await retryFailedDeliveries(c.env, c.req.param("id")); return c.redirect(`/broadcasts/${c.req.param("id")}`, 303); });

adminApp.get("/senders", async (c) => {
  const domains = parseSendingDomains(c.env.SENDING_DOMAINS);
  const senders = await c.env.DB.prepare("SELECT s.*,d.name AS domain_name FROM senders s JOIN domains d ON d.id=s.domain_id ORDER BY s.created_at DESC").all<SenderRow & { domain_name: string }>();
  const unsubscribeHostnames = parseUnsubscribeHostnames(c.env.UNSUBSCRIBE_HOSTNAMES);
  return c.html(<Layout title="Domains"><PageHead title="Domains & senders"><><ModalTrigger target="add-sender">＋ Add sender</ModalTrigger><SenderModal id="add-sender" domains={domains} returnTo="/senders"/></></PageHead><div class="panel"><p class="muted">Sending domains are discovered from Cloudflare Email Service during deployment. Unsubscribe hostnames remain configured in <code>.deployment.json</code>.</p></div><div class="table-shell responsive-table"><table><thead><tr><th>Sending domain</th><th class="mobile-hide">Unsubscribe hostname</th><th class="narrow-hide">Status</th></tr></thead><tbody>{domains.map((domain) => { const configured = Boolean(unsubscribeHostnames[domain]); return <tr><td>{domain}<small class="mobile-detail">{configured ? `Enabled · ${unsubscribeHostnames[domain]}` : "Enabled · missing unsubscribe hostname"}</small></td><td class="mobile-hide">{unsubscribeHostnames[domain] ?? "—"}</td><td class="narrow-hide"><span class={configured ? "badge good" : "badge bad"}>{configured ? "Enabled" : "Needs unsubscribe hostname"}</span></td></tr>; })}</tbody></table>{!domains.length && <div class="empty">No enabled Email Sending domains were discovered.</div>}</div><div class="table-shell responsive-table"><table><thead><tr><th>Sender</th><th class="mobile-hide">Domain</th><th class="mobile-hide">Reply-to</th><th class="mobile-hide">Postal address</th><th>Status</th></tr></thead><tbody>{senders.results.map((sender) => <tr><td><div class="row-title"><span class="row-icon">@</span><span>{sender.name}<small>{sender.email}</small></span></div></td><td class="mobile-hide">{sender.domain_name}</td><td class="mobile-hide">{sender.reply_to ?? "—"}</td><td class="mobile-hide">{sender.postal_address}</td><td><span class={sender.active ? "badge good" : "badge bad"}>{sender.active ? "Active" : "Inactive"}</span></td></tr>)}</tbody></table>{!senders.results.length && <div class="empty">Add a sender for one of the enabled domains above.</div>}</div></Layout>);
});
adminApp.post("/senders", async (c) => {
  const form = await c.req.parseBody(); const domainName = textField(form.domain, "domain", 253).toLowerCase();
  if (!parseSendingDomains(c.env.SENDING_DOMAINS).includes(domainName)) throw new AppError(422, "validation_error", "Select an enabled Cloudflare Email Sending domain.");
  await c.env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING").bind(crypto.randomUUID(), domainName, nowIso()).run();
  const domain = await c.env.DB.prepare("SELECT id,name FROM domains WHERE name=? COLLATE NOCASE").bind(domainName).first<DomainRow>();
  if (!domain) throw new AppError(500, "application_error", "Could not prepare the sending domain.");
  const email = normalizeEmail(textField(form.email, "email", 320));
  if (!isEmail(email) || email.split("@")[1] !== domain.name.toLowerCase()) throw new AppError(422, "validation_error", "Sender email must be on the selected domain.");
  const replyTo = String(form.reply_to ?? "").trim(); if (replyTo && !isEmail(normalizeEmail(replyTo))) throw new AppError(422, "validation_error", "Reply-to is invalid.");
  const now = nowIso(); await c.env.DB.prepare(`INSERT INTO senders (id,domain_id,email,name,reply_to,postal_address,active,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)`).bind(crypto.randomUUID(), domain.id, email, textField(form.name, "name", 200), replyTo || null, textField(form.postal_address, "postal_address", 1000), now, now).run();
  const returnTo = String(form.return_to ?? "");
  const safeReturnTo = returnTo === "/senders" || returnTo === "/broadcasts/new" || /^\/broadcasts\/[0-9a-f-]+\/editor$/i.test(returnTo) ? returnTo : "/senders";
  return c.redirect(safeReturnTo, 303);
});

adminApp.get("/api-keys", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  const rows = await c.env.DB.prepare(`SELECT id,name,prefix,created_at,last_used_at,revoked_at FROM api_keys ${search ? "WHERE name LIKE ?" : ""} ORDER BY created_at DESC`).bind(...(search ? [`%${search}%`] : [])).all<{ id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>();
  return c.html(<Layout title="API keys"><PageHead title="API keys"><><ModalTrigger target="create-api-key">＋ Create API key</ModalTrigger><Modal id="create-api-key" title="Add API Key" autoOpen={c.req.query("new") === "true"}><form method="post"><label>Name</label><input name="name" required maxlength={200} placeholder="Your API Key name"/><label>Permission <span class="info-dot">i</span></label><select disabled><option>Full access</option></select><label>Domain</label><select disabled><option>All domains</option></select><ModalActions submitLabel="Add"/></form></Modal></></PageHead><form method="get" class="toolbar" style="grid-template-columns:1fr auto"><div class="search-field"><input name="search" value={search} placeholder="Search…"/></div><button>Search</button></form><div class="table-shell responsive-table"><table><thead><tr><th class="check-cell mobile-hide"><span class="fake-check"></span></th><th>Name</th><th>Token</th><th class="mobile-hide">Permission</th><th class="mobile-hide">Last used</th><th class="mobile-hide">Created</th><th></th></tr></thead><tbody>{rows.results.map((row) => <tr><td class="mobile-hide"><span class="fake-check"></span></td><td><div class="row-title"><span class="row-icon">⌕</span><span>{row.name}<small class="mobile-detail">{row.revoked_at ? "Revoked" : "Full access"}</small></span></div></td><td><span class="key-token">{row.prefix}…</span></td><td class="mobile-hide">{row.revoked_at ? <span class="danger-text">Revoked</span> : "Full access"}</td><td class="mobile-hide">{row.last_used_at ? relativeDate(row.last_used_at) : "Never"}</td><td class="mobile-hide">{relativeDate(row.created_at)}</td><td class="row-action">{!row.revoked_at && <form method="post" action={`/api-keys/${row.id}/revoke`} data-confirm="Revoke this API key?"><button class="danger small-button">Revoke</button></form>}</td></tr>)}</tbody></table>{!rows.results.length && <div class="empty">No API keys yet.</div>}</div><div class="table-foot">{rows.results.length} keys</div></Layout>);
});
adminApp.post("/api-keys", async (c) => { const form = await c.req.parseBody(); const raw = `re_${randomToken(30)}`; await c.env.DB.prepare("INSERT INTO api_keys (id,name,prefix,key_hash,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), textField(form.name, "name", 200), raw.slice(0, 12), await sha256(raw), nowIso()).run(); return c.html(<Layout title="API key created"><div class="panel success"><h1>API key created</h1><p>Copy this key now. It will not be shown again.</p><div class="code">{raw}</div><p><a class="button" href="/api-keys">Done</a></p></div></Layout>); });
adminApp.post("/api-keys/:id/revoke", async (c) => { await c.env.DB.prepare("UPDATE api_keys SET revoked_at=? WHERE id=?").bind(nowIso(), c.req.param("id")).run(); return c.redirect("/api-keys", 303); });

function Layout({ title, children }: { title: string; children: Child }) {
  const active = title.toLowerCase().includes("broadcast") ? "broadcasts" : title.toLowerCase().includes("audience") ? "audience" : title.toLowerCase().includes("domain") ? "domains" : title.toLowerCase().includes("api key") ? "keys" : "";
  return <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>{title} · Cloudflare Mail</title><link rel="stylesheet" href="/assets/admin.css"/></head><body><div class="app-shell"><aside class="sidebar"><a class="workspace" href="/broadcasts"><span class="workspace-mark">CF</span><span>Cloudflare Mail</span></a><nav class="side-nav"><NavLink href="/broadcasts" icon="◉" label="Broadcasts" active={active === "broadcasts"}/><NavLink href="/audience" icon="♧" label="Audience" active={active === "audience"}/><NavLink href="/senders" icon="◎" label="Domains" active={active === "domains"}/><NavLink href="/api-keys" icon="⌕" label="API keys" active={active === "keys"}/></nav><div class="side-foot">Protected by Cloudflare Access</div></aside><main class="main"><div class="content">{children}</div></main></div><script type="module" src="/assets/admin.js"></script></body></html>;
}
function NavLink({ href, icon, label, active }: { href: string; icon: string; label: string; active: boolean }) { return <a class={`side-link ${active ? "active" : ""}`} href={href}><span class="nav-icon">{icon}</span>{label}</a>; }
function PageHead({ title, children }: { title: string; children?: Child }) { return <div class="page-head"><h1>{title}</h1>{children && <div class="head-actions">{children}</div>}</div>; }
function ModalTrigger({ target, children }: { target: string; children: Child }) { return <button type="button" class="primary" data-modal-open={target}>{children}</button>; }
function Modal({ id, title, children, autoOpen = false }: { id: string; title: string; children: Child; autoOpen?: boolean }) {
  return <dialog id={id} class="modal" data-auto-open={autoOpen ? "true" : undefined}><div class="modal-card"><header class="modal-head"><h2>{title}</h2><button type="button" class="modal-close" data-modal-close aria-label="Close dialog">×</button></header><div class="modal-content">{children}</div></div></dialog>;
}
function ModalActions({ submitLabel }: { submitLabel: string }) {
  return <div class="modal-actions"><button class="primary" type="submit">{submitLabel} <kbd>⌘</kbd><kbd>↵</kbd></button><button type="button" data-modal-close>Cancel <kbd>Esc</kbd></button></div>;
}
function AudienceTabs({ active }: { active: "contacts" | "segments" | "topics" }) { return <div class="tabs"><a class={`tab ${active === "contacts" ? "active" : ""}`} href="/audience">Contacts</a><a class={`tab ${active === "segments" ? "active" : ""}`} href="/audience/segments">Segments</a><a class={`tab ${active === "topics" ? "active" : ""}`} href="/audience/topics">Topics</a></div>; }
function Metric({ label, value }: { label: string; value: number }) { return <div class="metric">{label}<strong>{Number(value).toLocaleString("en")}</strong></div>; }
function Stat({ label, value }: { label: string; value: number | string }) { return <div class="panel"><div class="stat">{value}</div><div class="muted">{label}</div></div>; }

function SenderModal({ id, domains, returnTo }: { id: string; domains: string[]; returnTo: string }) {
  return <Modal id={id} title="Add sender"><form method="post" action="/senders"><input type="hidden" name="return_to" value={returnTo}/><label>Domain</label><select name="domain" required><option value="">Select…</option>{domains.map((domain) => <option value={domain}>{domain}</option>)}</select><label>Email</label><input name="email" type="email" required/><label>Display name</label><input name="name" required/><label>Reply-to</label><input name="reply_to" type="email"/><label>Physical postal address</label><textarea name="postal_address" required></textarea><ModalActions submitLabel="Add"/></form></Modal>;
}

function BroadcastEditor({ broadcast, segments, senders, domains, topics }: { broadcast?: BroadcastRow; segments: SegmentRow[]; senders: SenderRow[]; domains: string[]; topics: TopicRow[] }) {
  const action = broadcast ? `/broadcasts/${broadcast.id}/editor` : "/broadcasts";
  const returnTo = broadcast ? `/broadcasts/${broadcast.id}/editor` : "/broadcasts/new";
  return <><div class="editor-page"><form method="post" action={action}><div class="editor-head"><a class="crumb" href="/broadcasts">← Broadcasts</a><strong>/</strong><input name="name" value={broadcast?.name ?? "Untitled"} aria-label="Broadcast name" required maxlength={200} style="width:220px"/><span class="badge draft">Draft</span><div class="push actions">{broadcast && <a class="button" href={`/broadcasts/${broadcast.id}`}>Cancel</a>}<button class="primary">Save and review</button></div></div><div class="editor-canvas"><div class="editor-fields"><div class="editor-row"><label>From</label><div class="editor-field-control"><select name="sender_id" required><option value="">{senders.length ? "Select a sending address…" : "No sending addresses yet"}</option>{senders.map((sender) => <option value={sender.id} selected={sender.id === broadcast?.sender_id}>{sender.name} &lt;{sender.email}&gt;</option>)}</select><button type="button" class="ghost small-button" data-modal-open="editor-add-sender">＋ Add sender</button></div></div><div class="editor-row"><label>To</label><select name="segment_id" required><option value="">Select a segment…</option>{segments.map((segment) => <option value={segment.id} selected={segment.id === broadcast?.segment_id}>{segment.name}</option>)}</select></div><div class="editor-row"><label>Topic</label><div class="editor-field-control"><select name="topic_id"><option value="">No topic — unsubscribe applies globally</option>{topics.map((topic) => <option value={topic.id} selected={topic.id === broadcast?.topic_id}>{topic.name}</option>)}</select><a class="button ghost small-button" href="/audience/topics">Manage topics</a></div></div><div class="editor-row"><label>Subject</label><input name="subject" value={broadcast?.subject ?? ""} placeholder="Write a subject…" required maxlength={998}/></div><div class="editor-row"><label>Preview</label><input name="preview_text" value={broadcast?.preview_text ?? ""} placeholder="Optional preview text" maxlength={500}/></div></div><div class="editor-body"><div data-rich-editor></div><textarea id="html-input" name="html" style="display:none">{broadcast?.html ?? "<p>Start writing your email…</p>"}</textarea><div class="editor-note">A compliant postal-address and unsubscribe footer is added automatically. A Topic limits unsubscribe to that preference; no Topic means global unsubscribe.</div></div></div></form></div><SenderModal id="editor-add-sender" domains={domains} returnTo={returnTo}/></>;
}
async function broadcastOptions(c: AdminContext): Promise<[D1Result<SegmentRow>, D1Result<SenderRow>, string[], D1Result<TopicRow>]> { const [segments, senders, topics] = await Promise.all([c.env.DB.prepare("SELECT * FROM segments ORDER BY name").all<SegmentRow>(), c.env.DB.prepare("SELECT * FROM senders WHERE active=1 ORDER BY name").all<SenderRow>(), c.env.DB.prepare("SELECT * FROM topics ORDER BY name").all<TopicRow>()]); return [segments, senders, parseSendingDomains(c.env.SENDING_DOMAINS), topics]; }
async function adminBroadcastFields(c: AdminContext, form: Record<string, string | File>): Promise<{ name: string; segmentId: string; topicId: string | null; sender: SenderRow; subject: string; previewText: string | null; html: string }> {
  const segmentId = textField(form.segment_id, "segment_id", 100); const senderId = textField(form.sender_id, "sender_id", 100);
  const topicId = String(form.topic_id ?? "").trim() || null;
  const [segment, sender, topic] = await Promise.all([c.env.DB.prepare("SELECT id FROM segments WHERE id=?").bind(segmentId).first(), c.env.DB.prepare("SELECT * FROM senders WHERE id=? AND active=1").bind(senderId).first<SenderRow>(), topicId ? c.env.DB.prepare("SELECT id FROM topics WHERE id=?").bind(topicId).first() : null]);
  if (!segment || !sender || (topicId && !topic)) throw new AppError(422, "validation_error", "Select a valid segment, topic, and sending address.");
  return { name: textField(form.name, "name", 200), segmentId, topicId, sender, subject: textField(form.subject, "subject", 998), previewText: String(form.preview_text ?? "").trim() || null, html: textField(form.html, "html", 1_000_000) };
}
function textField(value: string | File | undefined, field: string, max: number): string { if (typeof value !== "string" || !value.trim()) throw new AppError(422, "missing_required_field", `${field} is required.`); if (value.length > max) throw new AppError(422, "validation_error", `${field} is too long.`); return value.trim(); }
function optionalFormText(value: string | File | undefined, max: number): string | null { if (value === undefined || value === "") return null; if (typeof value !== "string" || value.length > max) throw new AppError(422, "validation_error", `Value must be at most ${max} characters.`); return value.trim() || null; }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function relativeDate(value: string): string { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return "just now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; if (seconds < 2_592_000) return `${Math.floor(seconds / 86400)}d ago`; return new Date(value).toLocaleDateString("en", { month: "short", day: "numeric", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }); }
