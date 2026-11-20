import { Hono } from "hono";
import { Layout, Modal, ModalActions, ModalTrigger, PageHead, relativeDate } from "./admin";
import {
  addManualSuppression,
  getSuppression,
  listSuppressions,
  removeSuppression,
  SUPPRESSION_ORIGINS,
  SUPPRESSIONS_PAGE_SIZE,
  type SuppressionOrigin,
} from "./suppressions";

export const suppressionsAdmin = new Hono<{ Bindings: Env }>();

export const ORIGIN_LABELS: Record<SuppressionOrigin, string> = { bounce: "Bounce", complaint: "Complaint", manual: "Manual" };

export function EmailTabs({ active }: { active: "sending" | "receiving" | "suppressions" }) {
  return <div class="tabs">
    <a class={`tab ${active === "sending" ? "active" : ""}`} href="/emails">Sending</a>
    <a class={`tab ${active === "receiving" ? "active" : ""}`} href="/emails?direction=receiving">Receiving</a>
    <a class={`tab ${active === "suppressions" ? "active" : ""}`} href="/emails/suppressions">Suppressions</a>
  </div>;
}

suppressionsAdmin.get("/emails/suppressions", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  const origin = c.req.query("origin") ?? "";
  const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
  const { rows, total } = await listSuppressions(c.env.DB, { search, origin, page });
  const pageLink = (target: number) => `/emails/suppressions?${new URLSearchParams({ ...(search ? { search } : {}), ...(origin ? { origin } : {}), page: String(target) })}`;
  return c.html(<Layout title="Suppressions">
    <PageHead title="Emails"><>
      <ModalTrigger target="add-suppression">Add email address</ModalTrigger>
      <Modal id="add-suppression" title="Add email address"><form method="post" action="/emails/suppressions" data-success="Email address added to suppressions.">
        <label for="suppression-email">Email address</label>
        <input id="suppression-email" name="email" type="email" required maxlength={320} placeholder="name@example.com"/>
        <p class="field-help">Suppressed addresses are skipped by every broadcast.</p>
        <ModalActions submitLabel="Add"/>
      </form></Modal>
    </></PageHead>
    <EmailTabs active="suppressions"/>
    <p class="muted">Addresses that hard bounce or mark your email as spam are suppressed automatically, and every broadcast skips them. Their contacts keep their segments and topics. Removing an address lets broadcasts reach it again; if it bounces or complains again, it is suppressed again.</p>
    <form class="toolbar" method="get">
      <input name="search" value={search} placeholder="Search email addresses…" aria-label="Search suppressions"/>
      <select name="origin" aria-label="Origin">
        <option value="">All origins</option>
        {SUPPRESSION_ORIGINS.map((value) => <option value={value} selected={origin === value}>{ORIGIN_LABELS[value]}</option>)}
      </select>
      <button>Filter</button>
    </form>
    <div class="table-shell responsive-table"><table><thead><tr><th>Email</th><th>Origin</th><th class="mobile-hide">Added</th></tr></thead><tbody>
      {rows.map((row) => <tr class="clickable-row" data-row-href={`/emails/suppressions/${row.id}`} tabindex={0}>
        <td><a class="row-title" href={`/emails/suppressions/${row.id}`}><span class="row-icon">@</span><span>{row.email}<small class="narrow-detail">{ORIGIN_LABELS[row.origin]}</small></span></a></td>
        <td><span class={`badge ${row.origin === "manual" ? "" : "bad"}`}>{ORIGIN_LABELS[row.origin]}</span></td>
        <td class="mobile-hide">{relativeDate(row.created_at)}</td>
      </tr>)}
    </tbody></table>{!rows.length && <div class="empty">{search || origin ? "No suppressions match these filters." : "No suppressions yet. Addresses that bounce or complain are blocked automatically."}</div>}</div>
    <div class="table-foot"><span>{total.toLocaleString("en")} suppression{total === 1 ? "" : "s"}</span><div class="push pagination">
      {page > 1 && <a class="button small-button" href={pageLink(page - 1)}>Newer</a>}
      {page * SUPPRESSIONS_PAGE_SIZE < total && <a class="button small-button" href={pageLink(page + 1)}>Older</a>}
    </div></div>
  </Layout>);
});

suppressionsAdmin.post("/emails/suppressions", async (c) => {
  const form = await c.req.parseBody();
  const id = await addManualSuppression(c.env.DB, form.email);
  return c.redirect(`/emails/suppressions/${id}`, 303);
});

suppressionsAdmin.get("/emails/suppressions/:id", async (c) => {
  const row = await getSuppression(c.env.DB, c.req.param("id"));
  return c.html(<Layout title="Suppression">
    <div class="detail-head"><div><a class="crumb" href="/emails/suppressions">← Suppressions</a><h1>{row.email}</h1><p class="muted">Suppressed address</p></div>
      <div class="actions"><form method="post" action={`/emails/suppressions/${row.id}/delete`} data-confirm={`Remove ${row.email} from the suppression list? Broadcasts can reach it again, and it is suppressed again automatically if it bounces or complains.`} data-success="Email address removed from suppressions."><button class="danger">Remove email address</button></form></div>
    </div>
    <section class="panel suppression-detail"><dl class="detail-list">
      <div><dt>Origin</dt><dd><span class={`badge ${row.origin === "manual" ? "" : "bad"}`}>{ORIGIN_LABELS[row.origin]}</span></dd></div>
      <div><dt>Recipient</dt><dd>{row.email}</dd></div>
      <div><dt>Added</dt><dd><time datetime={row.created_at}>{row.created_at.replace("T", " ").replace(/\.\d+Z$/, " UTC")}</time></dd></div>
      <div><dt>Contact</dt><dd>{row.contact_id ? <a href={`/contacts/${row.contact_id}`}>View contact →</a> : <span class="muted">Not a contact</span>}</dd></div>
    </dl>
    <h2 class="section-title">Details</h2>
    {row.details ? <pre class="suppression-reason">{row.details}</pre> : <p class="muted">{row.origin === "manual" ? "Added manually." : "No reason was reported."}</p>}
    </section>
  </Layout>);
});

suppressionsAdmin.post("/emails/suppressions/:id/delete", async (c) => {
  await removeSuppression(c.env.DB, c.req.param("id"));
  return c.redirect("/emails/suppressions", 303);
});
