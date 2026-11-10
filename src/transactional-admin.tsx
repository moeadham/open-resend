import { Hono } from "hono";
import {
  Layout,
  PageHead,
  Modal,
  ModalActions,
  ModalTrigger,
  relativeDate,
} from "./admin";
import { AppError, nowIso } from "./lib";
import {
  mailRow,
  storedMail,
  downloadInfo,
  emailResponse,
  type MailRow,
} from "./transactional-storage";
import {
  createWebhook,
  getWebhook,
  replayWebhook,
  updateWebhook,
  type WebhookRow,
} from "./webhooks";
import { receivingAdmin } from "./receiving-domains";

export const transactionalAdmin = new Hono<{ Bindings: Env }>();
transactionalAdmin.route("/receiving-domains", receivingAdmin);
transactionalAdmin.get("/emails", async (c) => {
  const direction =
    c.req.query("direction") === "receiving" ? "receiving" : "sending";
  const search = c.req.query("search") ?? "",
    status = c.req.query("status") ?? "",
    key = c.req.query("key") ?? "",
    days = Number(c.req.query("days") ?? 15);
  const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
  const clauses = ["direction=?", "expires_at>?"];
  const binds: (string | number)[] = [direction, nowIso()];
  if (search) {
    clauses.push("(from_value LIKE ? OR to_json LIKE ? OR subject LIKE ?)");
    binds.push(...Array(3).fill(`%${search}%`));
  }
  if (Number.isFinite(days) && days > 0) {
    clauses.push("created_at>=?");
    binds.push(
      new Date(Date.now() - Math.min(30, days) * 86400_000).toISOString(),
    );
  }
  if (direction === "sending" && status) {
    clauses.push("status=?");
    binds.push(status);
  }
  if (direction === "sending" && key) {
    clauses.push("api_key_id=?");
    binds.push(key);
  }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM transactional_emails WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT 41 OFFSET ?`,
  )
    .bind(...binds, (page - 1) * 40)
    .all<MailRow>();
  const keys = await c.env.DB.prepare("SELECT id,name FROM api_keys").all<{
    id: string;
    name: string;
  }>();
  const query = (p: number) =>
    `/emails?${new URLSearchParams({ ...c.req.query(), direction, page: String(p) })}`;
  return c.html(
    <Layout title="Emails">
      <PageHead title="Emails" />
      <div class="tabs">
        <a
          class={`tab ${direction === "sending" ? "active" : ""}`}
          href="/emails"
        >
          Sending
        </a>
        <a
          class={`tab ${direction === "receiving" ? "active" : ""}`}
          href="/emails?direction=receiving"
        >
          Receiving
        </a>
      </div>
      <form class="toolbar" method="get">
        <input type="hidden" name="direction" value={direction} />
        <input
          name="search"
          value={search}
          placeholder="Search emails…"
          aria-label="Search emails"
        />
        <select name="days" aria-label="Date range">
          {[1, 7, 15, 30].map((d) => (
            <option value={d} selected={days === d}>
              Last {d} days
            </option>
          ))}
        </select>
        {direction === "sending" && (
          <>
            <select name="status" aria-label="Email status">
              <option value="">All statuses</option>
              {[
                "queued",
                "sent",
                "delivered",
                "delivery_delayed",
                "bounced",
                "complained",
                "failed",
              ].map((s) => (
                <option value={s} selected={status === s}>
                  {s}
                </option>
              ))}
            </select>
            <select name="key" aria-label="API key">
              <option value="">All API keys</option>
              {keys.results.map((k) => (
                <option value={k.id} selected={key === k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </>
        )}
        <button>Filter</button>
      </form>
      <div class="table-shell responsive-table">
        <table>
          <thead>
            <tr>
              {direction === "receiving" && <th>From</th>}
              <th>To</th>
              {direction === "sending" && <th>Status</th>}
              <th>Subject</th>
              <th>{direction === "sending" ? "Sent" : "Received"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.results.slice(0, 40).map((row) => (
              <tr
                class="clickable-row"
                data-row-href={`/emails/${row.id}`}
                tabindex={0}
              >
                {direction === "receiving" && (
                  <td>
                    <a href={`/emails/${row.id}`}>{row.from_value}</a>
                  </td>
                )}
                <td>
                  <a href={`/emails/${row.id}`}>
                    {(JSON.parse(row.to_json) as string[]).join(", ")}
                  </a>
                </td>
                {direction === "sending" && (
                  <td>
                    <span
                      class={`badge ${row.status === "failed" ? "bad" : "good"}`}
                    >
                      {row.status}
                    </span>
                  </td>
                )}
                <td>{row.subject || "No subject"}</td>
                <td>{relativeDate(row.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.results.length && (
          <div class="empty">No emails match these filters.</div>
        )}
      </div>
      <div class="table-foot">
        Page {page}
        <div class="push pagination">
          {page > 1 && (
            <a class="button" href={query(page - 1)}>
              Newer
            </a>
          )}
          {rows.results.length > 40 && (
            <a class="button" href={query(page + 1)}>
              Older
            </a>
          )}
        </div>
      </div>
    </Layout>,
  );
});
transactionalAdmin.get("/emails/:id", async (c) => {
  const row = await mailRow(c.env, c.req.param("id"));
  const mail = await storedMail(c.env, row.id);
  const view = c.req.query("view") ?? "preview";
  const rawJson =
    view === "raw"
      ? JSON.stringify(await emailResponse(c.env, row), null, 2)
      : null;
  const events = await c.env.DB.prepare(
    "SELECT status,recipient,created_at FROM transactional_events WHERE email_id=? ORDER BY created_at",
  )
    .bind(row.id)
    .all<{ status: string; recipient: string; created_at: string }>();
  return c.html(
    <Layout title="Emails">
      <p class="muted">
        {row.direction === "receiving" ? "Received email" : "Email"}
      </p>
      <PageHead
        title={row.direction === "receiving" ? mail.from : mail.to.join(", ")}
      />
      <div class="email-metadata">
        <div>
          <label>FROM</label>
          {mail.from}
        </div>
        <div>
          <label>SUBJECT</label>
          {mail.subject}
        </div>
        <div>
          <label>TO</label>
          {mail.to.join(", ")}
        </div>
        <div>
          <label>ID</label>
          <code>{row.id}</code>
        </div>
        {mail.cc.length > 0 && (
          <div>
            <label>CC</label>
            {mail.cc.join(", ")}
          </div>
        )}
        {mail.reply_to.length > 0 && (
          <div>
            <label>REPLY-TO</label>
            {mail.reply_to.join(", ")}
          </div>
        )}
      </div>
      {mail.attachments.length > 0 && (
        <section class="panel">
          <h2>Attachments</h2>
          <div class="actions">
            {await Promise.all(
              mail.attachments.map(async (a) => (
                <a
                  class="button"
                  href={
                    (await downloadInfo(c.env, row, `attachment-${a.id}`))
                      .download_url
                  }
                >
                  {a.filename ?? "attachment"} · {a.size} bytes
                </a>
              )),
            )}
          </div>
        </section>
      )}
      {row.direction === "sending" && (
        <section class="panel">
          <h2>Email events</h2>
          {events.results.map((e) => (
            <p>
              <span class="badge">{e.status}</span> {e.recipient}{" "}
              <time>{e.created_at}</time>
            </p>
          ))}
          {!events.results.length && <p>Queued</p>}
        </section>
      )}
      <div class="tabs">
        {["preview", "plain-text", "html", "raw"].map((v) => (
          <a
            class={`tab ${view === v ? "active" : ""}`}
            href={`/emails/${row.id}?view=${v}`}
          >
            {v === "plain-text"
              ? "Plain Text"
              : v === "html"
                ? "HTML"
                : v === "raw"
                  ? "Raw"
                  : "Preview"}
          </a>
        ))}
      </div>
      {view === "preview" ? (
        <iframe
          title="Email preview"
          sandbox=""
          referrerpolicy="no-referrer"
          class="transactional-preview"
          srcdoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline';"><style>body{font-family:system-ui;padding:20px;overflow-wrap:anywhere}img{max-width:100%}</style>${mail.html ?? "<pre>" + escapeText(mail.text ?? "") + "</pre>"}`}
        />
      ) : (
        <CodeBlock
          id="email-source"
          value={
            view === "raw"
              ? (rawJson ?? "")
              : view === "html"
                ? (mail.html ?? "")
                : (mail.text ?? "")
          }
        />
      )}
    </Layout>,
  );
});
transactionalAdmin.get("/webhooks", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM webhooks ORDER BY created_at DESC",
  ).all<WebhookRow>();
  return c.html(
    <Layout title="Webhooks">
      <PageHead title="Webhooks">
        <ModalTrigger target="add-webhook">Add webhook</ModalTrigger>
      </PageHead>
      <WebhookModal />
      {rows.results.length ? (
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.results.map((row) => (
                <tr>
                  <td>
                    <a href={`/webhooks/${row.id}`}>{row.endpoint}</a>
                  </td>
                  <td>
                    <span
                      class={`badge ${row.status === "enabled" ? "good" : "bad"}`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td>{relativeDate(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div class="empty">
          <h2>No webhooks yet</h2>
          <p>
            Configure a webhook to receive real-time updates about email events.
          </p>
          <ModalTrigger target="add-webhook">Add webhook</ModalTrigger>
        </div>
      )}
    </Layout>,
  );
});
transactionalAdmin.post("/webhooks", async (c) => {
  const form = await c.req.parseBody();
  const row = await createWebhook(c.env, {
    endpoint: form.endpoint,
    events: [form.event],
  });
  return c.redirect(`/webhooks/${row.id}`, 303);
});
transactionalAdmin.post("/webhooks/:id", async (c) => {
  const form = await c.req.parseBody();
  await updateWebhook(c.env, c.req.param("id"), {
    endpoint: form.endpoint,
    status: form.status,
    events: ["email.received"],
  });
  return c.redirect(`/webhooks/${c.req.param("id")}`, 303);
});
transactionalAdmin.post("/webhooks/:id/delete", async (c) => {
  await getWebhook(c.env, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM webhooks WHERE id=?")
    .bind(c.req.param("id"))
    .run();
  return c.redirect("/webhooks", 303);
});
transactionalAdmin.post("/webhooks/:id/replay/:event", async (c) => {
  await replayWebhook(c.env, c.req.param("id"), c.req.param("event"));
  return c.redirect(
    `/webhooks/${c.req.param("id")}?event=${encodeURIComponent(c.req.param("event"))}`,
    303,
  );
});
transactionalAdmin.get("/webhooks/:id", async (c) => {
  const row = await getWebhook(c.env, c.req.param("id"));
  const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
  const deliveries = await c.env.DB.prepare(
    `SELECT d.*,e.created_at,e.payload FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN transactional_emails m ON m.id=e.email_id WHERE d.webhook_id=? AND m.expires_at>? ORDER BY e.created_at DESC LIMIT 41 OFFSET ?`,
  )
    .bind(row.id, nowIso(), (page - 1) * 40)
    .all<{
      id: string;
      event_id: string;
      status: string;
      attempts: number;
      created_at: string;
      payload: string;
    }>();
  const selected = c.req.query("event") ?? deliveries.results[0]?.event_id;
  const event = selected
    ? await c.env.DB.prepare(
        `SELECT d.*,e.created_at,e.payload FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN transactional_emails m ON m.id=e.email_id WHERE d.webhook_id=? AND d.event_id=? AND m.expires_at>?`,
      )
        .bind(row.id, selected, nowIso())
        .first<{
          id: string;
          event_id: string;
          status: string;
          attempts: number;
          created_at: string;
          payload: string;
        }>()
    : null;
  const attempts = event
    ? await c.env.DB.prepare(
        "SELECT * FROM webhook_attempts WHERE delivery_id=? ORDER BY created_at DESC",
      )
        .bind(event.id)
        .all<{
          created_at: string;
          http_status: number | null;
          response_body: string;
          success: number;
        }>()
    : null;
  const last = attempts?.results[0];
  return c.html(
    <Layout title="Webhooks">
      <p class="muted">Webhook</p>
      <PageHead title={row.endpoint}>
        <ModalTrigger target="edit-webhook">Edit webhook</ModalTrigger>
      </PageHead>
      <div class="webhook-metadata">
        <div>
          <label>LISTENING FOR</label>email.received
        </div>
        <div>
          <label>STATUS</label>
          <span class={`badge ${row.status === "enabled" ? "good" : "bad"}`}>
            {row.status}
          </span>
        </div>
        <div>
          <label>CREATED</label>
          {relativeDate(row.created_at)}
        </div>
        <div>
          <label>SIGNING SECRET</label>
          <div class="secret-field" data-secret-field>
            <input
              id="webhook-secret"
              type="password"
              readonly
              value={row.signing_secret}
              data-secret-key
            />
            <button
              type="button"
              data-secret-toggle
              data-secret-label="signing secret"
              aria-label="Show signing secret"
            >
              Show
            </button>
            <button
              type="button"
              data-copy-target="webhook-secret"
              aria-label="Copy signing secret"
            >
              Copy
            </button>
          </div>
        </div>
      </div>
      <Modal id="edit-webhook" title="Edit webhook">
        <form method="post">
          <label>Endpoint URL</label>
          <input name="endpoint" type="url" value={row.endpoint} required />
          <label>Status</label>
          <select name="status">
            <option value="enabled" selected={row.status === "enabled"}>
              Enabled
            </option>
            <option value="disabled" selected={row.status === "disabled"}>
              Disabled
            </option>
          </select>
          <ModalActions submitLabel="Save" />
        </form>
        <form
          method="post"
          action={`/webhooks/${row.id}/delete`}
          data-confirm="Delete this webhook and its delivery history?"
        >
          <button class="danger">Delete webhook</button>
        </form>
      </Modal>
      <h2>Events</h2>
      <div class="webhook-event-layout">
        <aside>
          <div class="webhook-event-list">
            {deliveries.results.slice(0, 40).map((d) => (
              <a
                class={`webhook-event ${selected === d.event_id ? "selected" : ""}`}
                href={`/webhooks/${row.id}?event=${encodeURIComponent(d.event_id)}&page=${page}`}
              >
                <span>
                  email.received <small>{relativeDate(d.created_at)}</small>
                </span>
                <span
                  class={`badge ${d.status === "succeeded" ? "good" : d.status === "failed" ? "bad" : ""}`}
                >
                  {d.status === "succeeded"
                    ? "Success"
                    : d.status === "failed"
                      ? "Failed"
                      : d.status}
                </span>
              </a>
            ))}
          </div>
          {!deliveries.results.length && <p class="muted">No events yet.</p>}
          <div class="pagination">
            {page > 1 && <a href={`?page=${page - 1}`}>Newer</a>}
            {deliveries.results.length > 40 && (
              <a href={`?page=${page + 1}`}>Older</a>
            )}
          </div>
        </aside>
        <section>
          {event ? (
            <>
              <div class="section-head">
                <h3>email.received</h3>
                <form
                  method="post"
                  action={`/webhooks/${row.id}/replay/${event.event_id}`}
                >
                  <button
                    disabled={
                      row.status !== "enabled" || event.status === "sending"
                    }
                  >
                    ↻ Replay
                  </button>
                </form>
              </div>
              <div class="email-metadata">
                <div>
                  <label>ID</label>
                  <code>{event.event_id}</code>
                </div>
                <div>
                  <label>TIMESTAMP</label>
                  {event.created_at}
                </div>
                <div>
                  <label>HTTP STATUS CODE</label>
                  {last?.http_status ?? "—"}
                </div>
                <div>
                  <label>ATTEMPTS</label>
                  {event.attempts}
                </div>
              </div>
              <h3>Response body</h3>
              <CodeBlock
                id="webhook-response"
                value={last?.response_body ?? "No response yet."}
              />
              <h3>Message payload</h3>
              <CodeBlock
                id="webhook-payload"
                value={JSON.stringify(JSON.parse(event.payload), null, 2)}
              />
              {(attempts?.results.length ?? 0) > 1 && (
                <details>
                  <summary>All delivery attempts</summary>
                  {attempts?.results.map((a, i) => (
                    <div class="panel">
                      <p>
                        {a.created_at} · HTTP {a.http_status ?? "error"}
                      </p>
                      <CodeBlock id={`attempt-${i}`} value={a.response_body} />
                    </div>
                  ))}
                </details>
              )}
            </>
          ) : (
            <p class="muted">Select an event to inspect its delivery.</p>
          )}
        </section>
      </div>
    </Layout>,
  );
});
function WebhookModal() {
  return (
    <Modal id="add-webhook" title="Add webhook">
      <form method="post" action="/webhooks" data-webhook-form>
        <label for="webhook-endpoint">Endpoint URL</label>
        <input
          id="webhook-endpoint"
          name="endpoint"
          type="url"
          placeholder="https://"
          required
        />
        <label>Select events to listen</label>
        <div class="combobox" data-webhook-event-picker>
          <input type="hidden" name="event" value="" />
          <button
            type="button"
            class="combobox-trigger"
            data-webhook-event-trigger
            role="combobox"
            aria-expanded="false"
            aria-controls="webhook-event-options"
          >
            <span data-webhook-event-label>Select events…</span>
            <span aria-hidden="true">⌄</span>
          </button>
          <div
            id="webhook-event-options"
            class="combobox-content webhook-event-options"
            hidden
          >
            <div class="combobox-search">
              <input
                placeholder="Search events…"
                aria-label="Search events"
                data-webhook-event-search
              />
            </div>
            <div role="listbox" aria-label="Events">
              <button
                type="button"
                class="combobox-item"
                role="option"
                aria-selected="false"
                data-webhook-event-option
              >
                email.received
              </button>
              <p class="muted" data-webhook-event-empty hidden>
                No matching events.
              </p>
            </div>
          </div>
        </div>
        <ModalActions submitLabel="Add" />
      </form>
    </Modal>
  );
}
function CodeBlock({ id, value }: { id: string; value: string }) {
  return (
    <div class="code-block">
      <button type="button" data-copy-target={id} aria-label="Copy content">
        Copy
      </button>
      <pre id={id}>{value}</pre>
    </div>
  );
}
function escapeText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
