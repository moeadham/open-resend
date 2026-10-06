import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { requireAccess, requireSameOrigin } from "./auth";
import { enqueueBroadcast, retryFailedDeliveries, sendTestEmail, validateBroadcastReady } from "./delivery";
import { AppError, appErrorResponse, assertIsoFuture, escapeHtml, isEmail, normalizeEmail, nowIso, randomToken, sha256, stripHtml } from "./lib";
import type { BroadcastRow, SegmentRow, SenderRow } from "./types";

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
    <AudienceTabs active="contacts"/><div class="metric-strip"><Metric label="All contacts" value={metrics?.total ?? 0}/><Metric label="Active" value={metrics?.active ?? 0}/><Metric label="Unsubscribed / suppressed" value={metrics?.inactive ?? 0}/></div>
    <form method="get" class="toolbar"><div class="search-field"><input name="search" value={search} placeholder="Search…" aria-label="Search contacts"/></div><select name="status" aria-label="Subscription status"><option value="">All subscriptions</option><option value="active" selected={status === "active"}>Active</option><option value="unsubscribed" selected={status === "unsubscribed"}>Unsubscribed</option><option value="suppressed" selected={status === "suppressed"}>Suppressed</option></select><select name="segment" aria-label="Segment"><option value="">All segments</option>{segments.results.map((segment) => <option value={segment.id} selected={segmentId === segment.id}>{segment.name}</option>)}</select><button>Filter</button></form>
    <div class="table-shell"><table><thead><tr><th class="check-cell"><span class="fake-check"></span></th><th>Email</th><th>Segments</th><th>Status</th><th>Added</th><th></th></tr></thead><tbody>{rows.results.map((row) => <tr><td><span class="fake-check"></span></td><td><div class="row-title"><span class="row-icon">@</span><span>{row.email}{(row.first_name || row.last_name) && <small>{[row.first_name, row.last_name].filter(Boolean).join(" ")}</small>}</span></div></td><td>{row.memberships ?? <span class="muted">—</span>}</td><td>{row.suppression_reason ? <span class="badge bad">Suppressed</span> : row.unsubscribed ? <span class="badge bad">Unsubscribed</span> : <span class="badge good">Subscribed</span>}</td><td>{relativeDate(row.created_at)}</td><td class="row-more">···</td></tr>)}</tbody></table>{!rows.results.length && <div class="empty">No contacts match these filters.</div>}</div>
    <div class="table-foot"><span>Page {page} · {total} contacts · 40 items</span><div class="push pagination">{page > 1 && <a class="button small-button" href={queryFor(page - 1)}>Newer</a>}{page * pageSize < total && <a class="button small-button" href={queryFor(page + 1)}>Older</a>}</div></div></Layout>);
});

adminApp.get("/audience/segments", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  const rows = await c.env.DB.prepare(`SELECT s.*,
      SUM(CASE WHEN sc.status = 'subscribed' THEN 1 ELSE 0 END) AS subscribed,
      SUM(CASE WHEN sc.status = 'unsubscribed' THEN 1 ELSE 0 END) AS unsubscribed
    FROM segments s LEFT JOIN segment_contacts sc ON sc.segment_id = s.id
    ${search ? "WHERE s.name LIKE ?" : ""} GROUP BY s.id ORDER BY s.created_at DESC`)
    .bind(...(search ? [`%${search}%`] : [])).all<SegmentRow & { subscribed: number; unsubscribed: number }>();
  return c.html(<Layout title="Audience segments"><PageHead title="Audience"><><ModalTrigger target="create-segment">＋ Create segment</ModalTrigger><Modal id="create-segment" title="Create segment"><form method="post" action="/segments"><label>Name</label><input name="name" required maxlength={200} placeholder="Product updates"/><ModalActions submitLabel="Create"/></form></Modal></></PageHead><AudienceTabs active="segments"/>
    <form method="get" class="toolbar" style="grid-template-columns:1fr auto"><div class="search-field"><input name="search" value={search} placeholder="Search…" aria-label="Search segments"/></div><button>Search</button></form>
    <div class="table-shell"><table><thead><tr><th class="check-cell"><span class="fake-check"></span></th><th>Name</th><th>Contacts</th><th>Unsubscribed</th><th>Created</th><th></th></tr></thead><tbody>{rows.results.map((row) => <tr><td><span class="fake-check"></span></td><td><div class="row-title"><span class="row-icon">♧</span><form method="post" action={`/segments/${row.id}`} class="inline-form"><input name="name" value={row.name} required maxlength={200}/><button class="small-button">Save</button></form></div></td><td>{row.subscribed ?? 0}</td><td>{row.unsubscribed ?? 0}</td><td>{relativeDate(row.created_at)}</td><td><form method="post" action={`/segments/${row.id}/delete`} data-confirm="Delete this segment?"><button class="danger small-button">Delete</button></form></td></tr>)}</tbody></table>{!rows.results.length && <div class="empty">No segments yet.</div>}</div><div class="table-foot">{rows.results.length} segments · 40 items</div></Layout>);
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

adminApp.get("/broadcasts", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  const status = c.req.query("status") ?? "";
  const segmentId = c.req.query("segment") ?? "";
  const conditions: string[] = []; const bindings: unknown[] = [];
  if (search) { conditions.push("(b.name LIKE ? OR b.subject LIKE ?)"); bindings.push(`%${search}%`, `%${search}%`); }
  if (status) { conditions.push("b.status = ?"); bindings.push(status); }
  if (segmentId) { conditions.push("b.segment_id = ?"); bindings.push(segmentId); }
  const [broadcasts, segments] = await Promise.all([
    c.env.DB.prepare(`SELECT b.*,s.name AS segment_name FROM broadcasts b JOIN segments s ON s.id=b.segment_id ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY b.updated_at DESC LIMIT 100`)
      .bind(...bindings).all<BroadcastRow & { segment_name: string }>(),
    c.env.DB.prepare("SELECT * FROM segments ORDER BY name").all<SegmentRow>(),
  ]);
  return c.html(<Layout title="Broadcasts"><PageHead title="Broadcasts"><a class="button primary" href="/broadcasts/new">＋ Create broadcast</a></PageHead>
    <form method="get" class="toolbar"><div class="search-field"><input name="search" value={search} placeholder="Search…" aria-label="Search broadcasts"/></div><select name="status"><option value="">All statuses</option>{["draft","scheduled","queued","sending","sent","cancelled"].map((item) => <option value={item} selected={status === item}>{capitalize(item)}</option>)}</select><select name="segment"><option value="">All audiences</option>{segments.results.map((segment) => <option value={segment.id} selected={segmentId === segment.id}>{segment.name}</option>)}</select><button>Filter</button></form>
    <div class="table-shell"><table><thead><tr><th class="check-cell"><span class="fake-check"></span></th><th>Name</th><th>Status</th><th>Audience</th><th>Updated</th><th></th></tr></thead><tbody>{broadcasts.results.map((broadcast) => <tr><td><span class="fake-check"></span></td><td><a class="row-title" href={broadcast.status === "draft" ? `/broadcasts/${broadcast.id}/editor` : `/broadcasts/${broadcast.id}`}><span class="row-icon">◉</span><span>{broadcast.name}<small>{broadcast.subject}</small></span></a></td><td><span class={`badge ${broadcast.status}`}>{broadcast.status}</span></td><td>{broadcast.segment_name}</td><td>{relativeDate(broadcast.updated_at)}</td><td class="row-more">···</td></tr>)}</tbody></table>{!broadcasts.results.length && <div class="empty">No broadcasts match these filters.</div>}</div><div class="table-foot">{broadcasts.results.length} broadcasts · 40 items</div></Layout>);
});

adminApp.get("/broadcasts/new", async (c) => {
  const [segments, senders, domains] = await broadcastOptions(c);
  return c.html(<Layout title="New broadcast"><BroadcastEditor segments={segments.results} senders={senders.results} domains={domains.results}/></Layout>);
});

adminApp.post("/broadcasts", async (c) => {
  const form = await c.req.parseBody();
  const prepared = await adminBroadcastFields(c, form);
  const id = crypto.randomUUID(); const now = nowIso();
  await c.env.DB.prepare(`INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,preview_text,html,text,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?)`).bind(id, prepared.name, prepared.segmentId, prepared.sender.id, `${prepared.sender.name} <${prepared.sender.email}>`, prepared.subject, prepared.previewText, prepared.html, stripHtml(prepared.html), now, now).run();
  return c.redirect(`/broadcasts/${id}/editor`, 303);
});

adminApp.get("/broadcasts/:id/editor", async (c) => {
  const [segments, senders, domains] = await broadcastOptions(c);
  const broadcast = await c.env.DB.prepare("SELECT * FROM broadcasts WHERE id=?").bind(c.req.param("id")).first<BroadcastRow>();
  if (!broadcast) throw new AppError(404, "not_found", "Broadcast not found.");
  if (broadcast.status !== "draft") return c.redirect(`/broadcasts/${broadcast.id}`, 302);
  return c.html(<Layout title={`${broadcast.name} editor`}><BroadcastEditor broadcast={broadcast} segments={segments.results} senders={senders.results} domains={domains.results}/></Layout>);
});

adminApp.post("/broadcasts/:id/editor", async (c) => {
  const existing = await c.env.DB.prepare("SELECT status FROM broadcasts WHERE id=?").bind(c.req.param("id")).first<{ status: string }>();
  if (!existing) throw new AppError(404, "not_found", "Broadcast not found.");
  if (existing.status !== "draft") throw new AppError(409, "conflict", "Only draft broadcasts can be edited.");
  const prepared = await adminBroadcastFields(c, await c.req.parseBody());
  await c.env.DB.prepare(`UPDATE broadcasts SET name=?,segment_id=?,sender_id=?,from_value=?,subject=?,preview_text=?,html=?,text=?,updated_at=? WHERE id=?`)
    .bind(prepared.name, prepared.segmentId, prepared.sender.id, `${prepared.sender.name} <${prepared.sender.email}>`, prepared.subject, prepared.previewText, prepared.html, stripHtml(prepared.html), nowIso(), c.req.param("id")).run();
  return c.redirect(`/broadcasts/${c.req.param("id")}/editor`, 303);
});

adminApp.get("/broadcasts/:id", async (c) => {
  const broadcast = await c.env.DB.prepare(`SELECT b.*,s.email AS sender_email,s.name AS sender_name,sg.name AS segment_name FROM broadcasts b JOIN senders s ON s.id=b.sender_id JOIN segments sg ON sg.id=b.segment_id WHERE b.id=?`)
    .bind(c.req.param("id")).first<BroadcastRow & { sender_email: string; sender_name: string; segment_name: string }>();
  if (!broadcast) throw new AppError(404, "not_found", "Broadcast not found.");
  const [counts, deliveries] = await Promise.all([
    c.env.DB.prepare("SELECT status,COUNT(*) AS count FROM deliveries WHERE broadcast_id=? GROUP BY status").bind(broadcast.id).all<{ status: string; count: number }>(),
    c.env.DB.prepare("SELECT recipient,status,attempts,message_id,last_error,updated_at FROM deliveries WHERE broadcast_id=? ORDER BY updated_at DESC LIMIT 100").bind(broadcast.id).all<{ recipient: string; status: string; attempts: number; message_id: string | null; last_error: string | null; updated_at: string }>(),
  ]);
  return c.html(<Layout title={broadcast.name}><div class="editor-head"><a class="crumb" href="/broadcasts">← Broadcasts</a><strong>/</strong><strong>{broadcast.name}</strong><span class={`badge ${broadcast.status}`}>{broadcast.status}</span><div class="push actions">{broadcast.status === "draft" && <a class="button" href={`/broadcasts/${broadcast.id}/editor`}>Edit</a>}{!['sent','cancelled','draft'].includes(broadcast.status) && <form method="post" action={`/broadcasts/${broadcast.id}/cancel`} data-confirm="Cancel unsent deliveries?"><button class="danger">Cancel</button></form>}</div></div>
    <div class="grid"><Stat label="Audience" value={broadcast.segment_name}/><Stat label="Sender" value={broadcast.sender_name}/>{counts.results.map((row) => <Stat label={capitalize(row.status)} value={row.count}/>)}</div>
    <div class="panel"><h2 class="section-title">{broadcast.subject}</h2><iframe title="Campaign preview" sandbox="" class="preview-frame" srcdoc={broadcast.html ?? `<pre>${escapeHtml(broadcast.text)}</pre>`}></iframe></div>
    <div class="panel actions">{broadcast.status === "draft" && <><form method="post" action={`/broadcasts/${broadcast.id}/send`} data-confirm="Send this broadcast now?"><button class="primary">Send now</button></form><form method="post" action={`/broadcasts/${broadcast.id}/schedule`} data-schedule-form><input type="datetime-local" data-schedule-local required/><input type="hidden" name="scheduled_at"/><button>Schedule</button></form></>}<form method="post" action={`/broadcasts/${broadcast.id}/test`}><input name="email" type="email" placeholder="Test recipient" required/><button>Send test</button></form><form method="post" action={`/broadcasts/${broadcast.id}/retry`}><button>Retry failures</button></form></div>
    {deliveries.results.length > 0 && <div class="table-shell"><table><thead><tr><th>Recipient</th><th>Status</th><th>Attempts</th><th>Message ID / error</th><th>Updated</th></tr></thead><tbody>{deliveries.results.map((delivery) => <tr><td>{delivery.recipient}</td><td><span class={`badge ${delivery.status}`}>{delivery.status}</span></td><td>{delivery.attempts}</td><td class="muted">{delivery.last_error ?? delivery.message_id ?? "—"}</td><td>{relativeDate(delivery.updated_at)}</td></tr>)}</tbody></table></div>}</Layout>);
});

adminApp.post("/broadcasts/:id/send", async (c) => { await enqueueBroadcast(c.env, c.req.param("id")); return c.redirect(`/broadcasts/${c.req.param("id")}`, 303); });
adminApp.post("/broadcasts/:id/schedule", async (c) => {
  const form = await c.req.parseBody(); const scheduledAt = assertIsoFuture(textField(form.scheduled_at, "scheduled_at", 100));
  await validateBroadcastReady(c.env.DB, c.req.param("id"));
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
  const row = await c.env.DB.prepare(`SELECT b.subject,b.html,b.text,s.email,s.name,s.reply_to,s.postal_address FROM broadcasts b JOIN senders s ON s.id=b.sender_id WHERE b.id=?`).bind(c.req.param("id")).first<{ subject: string; html: string | null; text: string | null; email: string; name: string; reply_to: string | null; postal_address: string }>();
  if (!row) throw new AppError(404, "not_found", "Broadcast not found.");
  await sendTestEmail(c.env, { to, sender: row, subject: row.subject, html: row.html ?? `<p>${escapeHtml(row.text)}</p>`, text: row.text });
  return c.redirect(`/broadcasts/${c.req.param("id")}`, 303);
});
adminApp.post("/broadcasts/:id/retry", async (c) => { await retryFailedDeliveries(c.env, c.req.param("id")); return c.redirect(`/broadcasts/${c.req.param("id")}`, 303); });

adminApp.get("/senders", async (c) => {
  const [domains, senders] = await Promise.all([c.env.DB.prepare("SELECT * FROM domains ORDER BY name").all<DomainRow>(), c.env.DB.prepare("SELECT s.*,d.name AS domain_name FROM senders s JOIN domains d ON d.id=s.domain_id ORDER BY s.created_at DESC").all<SenderRow & { domain_name: string }>()]);
  return c.html(<Layout title="Domains"><PageHead title="Domains & senders"><><ModalTrigger target="add-sender">＋ Add sender</ModalTrigger><SenderModal id="add-sender" domains={domains.results} returnTo="/senders"/></></PageHead><div class="panel"><form method="post" action="/senders/domains" class="inline-form"><input name="domain" placeholder="Register an onboarded domain" required/><button>Register domain</button></form></div><div class="table-shell"><table><thead><tr><th>Sender</th><th>Domain</th><th>Reply-to</th><th>Postal address</th><th>Status</th></tr></thead><tbody>{senders.results.map((sender) => <tr><td><div class="row-title"><span class="row-icon">@</span><span>{sender.name}<small>{sender.email}</small></span></div></td><td>{sender.domain_name}</td><td>{sender.reply_to ?? "—"}</td><td>{sender.postal_address}</td><td><span class={sender.active ? "badge good" : "badge bad"}>{sender.active ? "Active" : "Inactive"}</span></td></tr>)}</tbody></table>{!senders.results.length && <div class="empty">Register a domain, then add a sender.</div>}</div></Layout>);
});
adminApp.post("/senders/domains", async (c) => {
  const form = await c.req.parseBody(); const domain = textField(form.domain, "domain", 253).toLowerCase().replace(/^@/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new AppError(422, "validation_error", "Domain is invalid.");
  await c.env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES (?,?,?)").bind(crypto.randomUUID(), domain, nowIso()).run(); return c.redirect("/senders", 303);
});
adminApp.post("/senders", async (c) => {
  const form = await c.req.parseBody(); const domainId = textField(form.domain_id, "domain_id", 100);
  const domain = await c.env.DB.prepare("SELECT name FROM domains WHERE id=?").bind(domainId).first<{ name: string }>();
  if (!domain) throw new AppError(404, "not_found", "Domain not found.");
  const email = normalizeEmail(textField(form.email, "email", 320));
  if (!isEmail(email) || email.split("@")[1] !== domain.name.toLowerCase()) throw new AppError(422, "validation_error", "Sender email must be on the selected domain.");
  const replyTo = String(form.reply_to ?? "").trim(); if (replyTo && !isEmail(normalizeEmail(replyTo))) throw new AppError(422, "validation_error", "Reply-to is invalid.");
  const now = nowIso(); await c.env.DB.prepare(`INSERT INTO senders (id,domain_id,email,name,reply_to,postal_address,active,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)`).bind(crypto.randomUUID(), domainId, email, textField(form.name, "name", 200), replyTo || null, textField(form.postal_address, "postal_address", 1000), now, now).run();
  const returnTo = String(form.return_to ?? "");
  const safeReturnTo = returnTo === "/senders" || returnTo === "/broadcasts/new" || /^\/broadcasts\/[0-9a-f-]+\/editor$/i.test(returnTo) ? returnTo : "/senders";
  return c.redirect(safeReturnTo, 303);
});

adminApp.get("/api-keys", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  const rows = await c.env.DB.prepare(`SELECT id,name,prefix,created_at,last_used_at,revoked_at FROM api_keys ${search ? "WHERE name LIKE ?" : ""} ORDER BY created_at DESC`).bind(...(search ? [`%${search}%`] : [])).all<{ id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>();
  return c.html(<Layout title="API keys"><PageHead title="API keys"><><ModalTrigger target="create-api-key">＋ Create API key</ModalTrigger><Modal id="create-api-key" title="Add API Key" autoOpen={c.req.query("new") === "true"}><form method="post"><label>Name</label><input name="name" required maxlength={200} placeholder="Your API Key name"/><label>Permission <span class="info-dot">i</span></label><select disabled><option>Full access</option></select><label>Domain</label><select disabled><option>All domains</option></select><ModalActions submitLabel="Add"/></form></Modal></></PageHead><form method="get" class="toolbar" style="grid-template-columns:1fr auto"><div class="search-field"><input name="search" value={search} placeholder="Search…"/></div><button>Search</button></form><div class="table-shell"><table><thead><tr><th class="check-cell"><span class="fake-check"></span></th><th>Name</th><th>Token</th><th>Permission</th><th>Last used</th><th>Created</th><th></th></tr></thead><tbody>{rows.results.map((row) => <tr><td><span class="fake-check"></span></td><td><div class="row-title"><span class="row-icon">⌕</span>{row.name}</div></td><td><span class="key-token">{row.prefix}…</span></td><td>{row.revoked_at ? <span class="danger-text">Revoked</span> : "Full access"}</td><td>{row.last_used_at ? relativeDate(row.last_used_at) : "Never"}</td><td>{relativeDate(row.created_at)}</td><td>{!row.revoked_at && <form method="post" action={`/api-keys/${row.id}/revoke`} data-confirm="Revoke this API key?"><button class="danger small-button">Revoke</button></form>}</td></tr>)}</tbody></table>{!rows.results.length && <div class="empty">No API keys yet.</div>}</div><div class="table-foot">{rows.results.length} keys · 40 items</div></Layout>);
});
adminApp.post("/api-keys", async (c) => { const form = await c.req.parseBody(); const raw = `re_${randomToken(30)}`; await c.env.DB.prepare("INSERT INTO api_keys (id,name,prefix,key_hash,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), textField(form.name, "name", 200), raw.slice(0, 12), await sha256(raw), nowIso()).run(); return c.html(<Layout title="API key created"><div class="panel success"><h1>API key created</h1><p>Copy this key now. It will not be shown again.</p><div class="code">{raw}</div><p><a class="button" href="/api-keys">Done</a></p></div></Layout>); });
adminApp.post("/api-keys/:id/revoke", async (c) => { await c.env.DB.prepare("UPDATE api_keys SET revoked_at=? WHERE id=?").bind(nowIso(), c.req.param("id")).run(); return c.redirect("/api-keys", 303); });

function Layout({ title, children }: { title: string; children: Child }) {
  const active = title.toLowerCase().includes("broadcast") ? "broadcasts" : title.toLowerCase().includes("audience") ? "audience" : title.toLowerCase().includes("domain") ? "domains" : title.toLowerCase().includes("api key") ? "keys" : "";
  return <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>{title} · Cloudflare Mail</title><link rel="stylesheet" href="/assets/admin.css"/></head><body><div class="app-shell"><aside class="sidebar"><a class="workspace" href="/broadcasts"><span class="workspace-mark">CF</span><span>Cloudflare Mail <small>Local</small></span></a><nav class="side-nav"><NavLink href="/broadcasts" icon="◉" label="Broadcasts" active={active === "broadcasts"}/><NavLink href="/audience" icon="♧" label="Audience" active={active === "audience"}/><NavLink href="/senders" icon="◎" label="Domains" active={active === "domains"}/><NavLink href="/api-keys" icon="⌕" label="API keys" active={active === "keys"}/></nav><div class="side-foot">Protected by Cloudflare Access</div></aside><main class="main"><div class="content">{children}</div></main></div><script type="module" src="/assets/admin.js"></script></body></html>;
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
function AudienceTabs({ active }: { active: "contacts" | "segments" }) { return <div class="tabs"><a class={`tab ${active === "contacts" ? "active" : ""}`} href="/audience">Contacts</a><a class={`tab ${active === "segments" ? "active" : ""}`} href="/audience/segments">Segments</a></div>; }
function Metric({ label, value }: { label: string; value: number }) { return <div class="metric">{label}<strong>{Number(value).toLocaleString("en")}</strong></div>; }
function Stat({ label, value }: { label: string; value: number | string }) { return <div class="panel"><div class="stat">{value}</div><div class="muted">{label}</div></div>; }

function SenderModal({ id, domains, returnTo }: { id: string; domains: DomainRow[]; returnTo: string }) {
  return <Modal id={id} title="Add sender"><form method="post" action="/senders"><input type="hidden" name="return_to" value={returnTo}/><label>Domain</label><select name="domain_id" required><option value="">Select…</option>{domains.map((domain) => <option value={domain.id}>{domain.name}</option>)}</select><label>Email</label><input name="email" type="email" required/><label>Display name</label><input name="name" required/><label>Reply-to</label><input name="reply_to" type="email"/><label>Physical postal address</label><textarea name="postal_address" required></textarea><ModalActions submitLabel="Add"/></form></Modal>;
}

function BroadcastEditor({ broadcast, segments, senders, domains }: { broadcast?: BroadcastRow; segments: SegmentRow[]; senders: SenderRow[]; domains: DomainRow[] }) {
  const action = broadcast ? `/broadcasts/${broadcast.id}/editor` : "/broadcasts";
  const returnTo = broadcast ? `/broadcasts/${broadcast.id}/editor` : "/broadcasts/new";
  return <><div class="editor-page"><form method="post" action={action}><div class="editor-head"><a class="crumb" href="/broadcasts">← Broadcasts</a><strong>/</strong><input name="name" value={broadcast?.name ?? "Untitled"} aria-label="Broadcast name" required maxlength={200} style="width:220px"/><span class="badge draft">Draft</span><div class="push actions">{broadcast && <a class="button" href={`/broadcasts/${broadcast.id}`}>Preview</a>}<button class="primary">Save draft</button></div></div><div class="editor-canvas"><div class="editor-fields"><div class="editor-row"><label>From</label><div class="editor-field-control"><select name="sender_id" required><option value="">{senders.length ? "Select a sending address…" : "No sending addresses yet"}</option>{senders.map((sender) => <option value={sender.id} selected={sender.id === broadcast?.sender_id}>{sender.name} &lt;{sender.email}&gt;</option>)}</select><button type="button" class="ghost small-button" data-modal-open="editor-add-sender">＋ Add sender</button></div></div><div class="editor-row"><label>To</label><select name="segment_id" required><option value="">Select a segment…</option>{segments.map((segment) => <option value={segment.id} selected={segment.id === broadcast?.segment_id}>{segment.name}</option>)}</select></div><div class="editor-row"><label>Subject</label><input name="subject" value={broadcast?.subject ?? ""} placeholder="Write a subject…" required maxlength={998}/></div><div class="editor-row"><label>Preview</label><input name="preview_text" value={broadcast?.preview_text ?? ""} placeholder="Optional preview text" maxlength={500}/></div></div><div class="editor-body"><div data-rich-editor></div><textarea id="html-input" name="html" style="display:none">{broadcast?.html ?? "<p>Start writing your email…</p>"}</textarea><div class="editor-note">A compliant postal-address and unsubscribe footer is added automatically when the broadcast is sent.</div></div></div></form></div><SenderModal id="editor-add-sender" domains={domains} returnTo={returnTo}/></>;
}
async function broadcastOptions(c: AdminContext): Promise<[D1Result<SegmentRow>, D1Result<SenderRow>, D1Result<DomainRow>]> { return Promise.all([c.env.DB.prepare("SELECT * FROM segments ORDER BY name").all<SegmentRow>(), c.env.DB.prepare("SELECT * FROM senders WHERE active=1 ORDER BY name").all<SenderRow>(), c.env.DB.prepare("SELECT * FROM domains ORDER BY name").all<DomainRow>()]); }
async function adminBroadcastFields(c: AdminContext, form: Record<string, string | File>): Promise<{ name: string; segmentId: string; sender: SenderRow; subject: string; previewText: string | null; html: string }> {
  const segmentId = textField(form.segment_id, "segment_id", 100); const senderId = textField(form.sender_id, "sender_id", 100);
  const [segment, sender] = await Promise.all([c.env.DB.prepare("SELECT id FROM segments WHERE id=?").bind(segmentId).first(), c.env.DB.prepare("SELECT * FROM senders WHERE id=? AND active=1").bind(senderId).first<SenderRow>()]);
  if (!segment || !sender) throw new AppError(422, "validation_error", "Select a valid segment and sending address.");
  return { name: textField(form.name, "name", 200), segmentId, sender, subject: textField(form.subject, "subject", 998), previewText: String(form.preview_text ?? "").trim() || null, html: textField(form.html, "html", 1_000_000) };
}
function textField(value: string | File | undefined, field: string, max: number): string { if (typeof value !== "string" || !value.trim()) throw new AppError(422, "missing_required_field", `${field} is required.`); if (value.length > max) throw new AppError(422, "validation_error", `${field} is too long.`); return value.trim(); }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function relativeDate(value: string): string { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return "just now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; if (seconds < 2_592_000) return `${Math.floor(seconds / 86400)}d ago`; return new Date(value).toLocaleDateString("en", { month: "short", day: "numeric", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }); }
