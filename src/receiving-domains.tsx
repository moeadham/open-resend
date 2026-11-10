import { Hono } from "hono";
import { AppError, isEmail, nowIso } from "./lib";
import { Layout, PageHead, Modal, ModalActions, ModalTrigger } from "./admin";

type RoutingEnv = Env & { CLOUDFLARE_EMAIL_ROUTING_TOKEN?: string };
type ReceivingDomain = {
  name: string;
  zone_id: string;
  status: string;
  addresses_json: string;
  rules_json: string;
  created_at: string;
};
type DnsRecord = {
  id?: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
};
type Rule = {
  id: string;
  name?: string;
  enabled: boolean;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
};
async function cf<T>(
  env: RoutingEnv,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!env.CLOUDFLARE_EMAIL_ROUTING_TOKEN)
    throw new AppError(
      503,
      "application_error",
      "Receiving setup requires CLOUDFLARE_EMAIL_ROUTING_TOKEN with Zone Read, Zone Settings Read, DNS Read, and Email Routing Rules Edit permissions.",
    );
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_ROUTING_TOKEN}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  const body = (await response.json()) as {
    success: boolean;
    result: T;
    errors?: { message: string }[];
  };
  if (!response.ok || !body.success)
    throw new AppError(
      502,
      "application_error",
      `Cloudflare receiving setup failed: ${body.errors?.map((e) => e.message).join("; ") ?? response.status}`,
    );
  return body.result;
}
async function findZone(env: RoutingEnv, name: string) {
  const labels = name.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const zones = await cf<{ id: string; name: string }[]>(
      env,
      `/zones?name=${encodeURIComponent(labels.slice(i).join("."))}&account.id=${env.CLOUDFLARE_ACCOUNT_ID}`,
    );
    if (zones[0]) return zones[0];
  }
  throw new AppError(
    422,
    "validation_error",
    "The receiving domain must belong to a Cloudflare zone in this account.",
  );
}
async function domain(env: Env, name: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM receiving_domains WHERE name=?",
  )
    .bind(name)
    .first<ReceivingDomain>();
  if (!row) throw new AppError(404, "not_found", "Receiving domain not found.");
  return row;
}
async function records(env: RoutingEnv, row: ReceivingDomain) {
  const required = await cf<DnsRecord[]>(
    env,
    `/zones/${row.zone_id}/email/routing/dns`,
  );
  const zone = await cf<{ name: string }>(env, `/zones/${row.zone_id}`);
  if (row.name === zone.name) return required;
  // The deprecated subdomain query has an undocumented response. Use the zone's
  // authoritative routing MX/SPF template; subdomain onboarding remains in Cloudflare.
  return required
    .filter(
      (r) =>
        r.type === "MX" || (r.type === "TXT" && r.content.startsWith("v=spf1")),
    )
    .map((r) => ({ ...r, name: row.name }));
}
async function verifyAndRoute(env: RoutingEnv, row: ReceivingDomain) {
  const required = await records(env, row);
  const existing = await cf<DnsRecord[]>(
    env,
    `/zones/${row.zone_id}/dns_records?name=${encodeURIComponent(row.name)}&per_page=100`,
  );
  const mx = required.filter((r) => r.type === "MX");
  if (
    !mx.length ||
    !mx.every((r) =>
      existing.some(
        (e) =>
          e.type === "MX" &&
          e.content.replace(/\.$/, "") === r.content.replace(/\.$/, "") &&
          e.priority === r.priority,
      ),
    )
  )
    throw new AppError(
      422,
      "validation_error",
      "Receiving MX records are not verified yet. Add the displayed records and try again.",
    );
  if (
    existing.some(
      (e) =>
        e.type === "MX" &&
        !mx.some(
          (r) => r.content.replace(/\.$/, "") === e.content.replace(/\.$/, ""),
        ),
    )
  )
    throw new AppError(
      409,
      "conflict",
      "Other MX records exist. Resolve the mail-provider conflict before enabling receiving.",
    );
  const settings = await cf<{ enabled: boolean }>(
    env,
    `/zones/${row.zone_id}/email/routing`,
  );
  if (!settings.enabled)
    throw new AppError(
      422,
      "validation_error",
      "Enable Email Routing in Cloudflare before verifying this domain.",
    );
  const addresses = JSON.parse(row.addresses_json) as string[];
  const existingRules = await cf<Rule[]>(
    env,
    `/zones/${row.zone_id}/email/routing/rules?per_page=100`,
  );
  const owned: string[] = JSON.parse(row.rules_json);
  for (const address of addresses) {
    const match = existingRules.find((r) =>
      r.matchers.some(
        (m) => m.type === "literal" && m.field === "to" && m.value === address,
      ),
    );
    if (match) {
      if (
        !match.actions.some(
          (a) => a.type === "worker" && a.value?.[0] === env.WORKER_NAME,
        )
      )
        throw new AppError(
          409,
          "conflict",
          `A different routing rule already handles ${address}.`,
        );
      continue;
    }
    const created = await cf<Rule>(
      env,
      `/zones/${row.zone_id}/email/routing/rules`,
      {
        method: "POST",
        body: JSON.stringify({
          name: `open-resend ${row.name}`,
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: address }],
          actions: [{ type: "worker", value: [env.WORKER_NAME] }],
        }),
      },
    );
    owned.push(created.id);
    // Record each created rule immediately, so interrupted setup can resume safely.
    await env.DB.prepare(
      "UPDATE receiving_domains SET rules_json=? WHERE name=?",
    )
      .bind(JSON.stringify(owned), row.name)
      .run();
  }
  if (!addresses.length) {
    const catchAll = await cf<Rule>(
      env,
      `/zones/${row.zone_id}/email/routing/rules/catch_all`,
    );
    if (
      catchAll.enabled &&
      !catchAll.actions.some(
        (a) => a.type === "worker" && a.value?.[0] === env.WORKER_NAME,
      )
    )
      throw new AppError(
        409,
        "conflict",
        "An existing catch-all routes to another destination. Configure explicit addresses instead.",
      );
    if (!catchAll.enabled) {
      await cf(env, `/zones/${row.zone_id}/email/routing/rules/catch_all`, {
        method: "PUT",
        body: JSON.stringify({
          name: `open-resend ${row.name}`,
          enabled: true,
          matchers: [{ type: "all" }],
          actions: [{ type: "worker", value: [env.WORKER_NAME] }],
        }),
      });
      owned.push("catch_all");
    }
  }
  await env.DB.prepare(
    "UPDATE receiving_domains SET status='verified',rules_json=? WHERE name=?",
  )
    .bind(JSON.stringify(owned), row.name)
    .run();
}
export const receivingAdmin = new Hono<{ Bindings: RoutingEnv }>();
receivingAdmin.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM receiving_domains ORDER BY created_at DESC",
  ).all<ReceivingDomain>();
  return c.html(
    <Layout title="Receiving domains">
      <PageHead title="Receiving domains">
        <ModalTrigger target="add-receiving-domain">Add domain</ModalTrigger>
      </PageHead>
      <div class="tabs">
        <a class="tab" href="/senders">
          Sending
        </a>
        <a class="tab active" href="/receiving-domains">
          Receiving
        </a>
      </div>
      <Modal id="add-receiving-domain" title="Enable receiving">
        <form method="post">
          <label>Domain name</label>
          <input name="name" placeholder="test.visibl.ai" required />
          <label>Receiving addresses</label>
          <textarea name="addresses" placeholder="calendar@test.visibl.ai" />
          <p class="field-help">
            Enter one address per line. Subdomains require explicit addresses.
            Leave empty for a catch-all on an apex domain.
          </p>
          <ModalActions submitLabel="Enable receiving" />
        </form>
      </Modal>
      <div class="table-shell">
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.results.map((row) => (
              <tr>
                <td>
                  <a href={`/receiving-domains/${row.name}`}>{row.name}</a>
                </td>
                <td>
                  <span
                    class={`badge ${row.status === "verified" ? "good" : ""}`}
                  >
                    {row.status}
                  </span>
                </td>
                <td>{row.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.results.length && (
          <div class="empty">Enable a domain to receive emails.</div>
        )}
      </div>
    </Layout>,
  );
});
receivingAdmin.post("/", async (c) => {
  const form = await c.req.parseBody();
  const name = String(form.name ?? "")
    .trim()
    .toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name))
    throw new AppError(422, "validation_error", "Invalid domain name.");
  const zone = await findZone(c.env, name);
  const addresses = [
    ...new Set(
      String(form.addresses ?? "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((a) => a.toLowerCase()),
    ),
  ];
  if (
    addresses.some((a) => !isEmail(a) || a.split("@")[1] !== name) ||
    addresses.length > 50
  )
    throw new AppError(
      422,
      "validation_error",
      "Provide at most 50 addresses belonging to this domain.",
    );
  if (name !== zone.name && !addresses.length)
    throw new AppError(
      422,
      "validation_error",
      "Subdomains require explicit receiving addresses.",
    );
  await c.env.DB.prepare(
    "INSERT INTO receiving_domains(name,zone_id,status,addresses_json,created_at) VALUES(?,?,'pending',?,?) ON CONFLICT(name) DO UPDATE SET addresses_json=excluded.addresses_json,status='pending'",
  )
    .bind(name, zone.id, JSON.stringify(addresses), nowIso())
    .run();
  return c.redirect(`/receiving-domains/${name}?setup=true`, 303);
});
receivingAdmin.get("/:name", async (c) => {
  const row = await domain(c.env, c.req.param("name"));
  const required = await records(c.env, row);
  const existing = await cf<DnsRecord[]>(
    c.env,
    `/zones/${row.zone_id}/dns_records?type=MX&name=${encodeURIComponent(row.name)}&per_page=100`,
  );
  const conflicts = existing.filter(
    (e) =>
      !required.some(
        (r) =>
          r.type === "MX" &&
          r.content.replace(/\.$/, "") === e.content.replace(/\.$/, ""),
      ),
  );
  return c.html(
    <Layout title="Receiving domain">
      <PageHead title={row.name} />
      <Modal
        id="receiving-mx-records"
        title="Add DNS records"
        autoOpen={c.req.query("setup") === "true"}
      >
        <p>
          Add these records at your DNS provider to start receiving email at{" "}
          {row.name}.
        </p>
        {conflicts.length > 0 && (
          <div class="panel error">
            Existing MX records use another mail provider. Resolve the conflict
            before verifying receiving.
          </div>
        )}
        <DnsTable records={required} />
        <form method="post" action={`/receiving-domains/${row.name}/verify`}>
          <ModalActions submitLabel="I’ve added the record" />
        </form>
      </Modal>

      <p>
        <span class={`badge ${row.status === "verified" ? "good" : ""}`}>
          {row.status}
        </span>
      </p>
      <section class="panel">
        <div class="section-head">
          <h2>DNS records</h2>
          <ModalTrigger target="receiving-mx-records">
            View setup instructions
          </ModalTrigger>
        </div>
        <p>Add these records at your DNS provider, then verify receiving.</p>
        {conflicts.length > 0 && (
          <div class="panel error">
            <strong>Existing mail provider detected</strong>
            <p>
              Other MX records point to{" "}
              {conflicts.map((r) => r.content).join(", ")}. Use a subdomain or
              deliberately migrate your mail before changing MX records.
            </p>
          </div>
        )}
        <DnsTable records={required} />
        <form method="post" action={`/receiving-domains/${row.name}/verify`}>
          <button class="primary">I’ve added the record</button>
        </form>
      </section>
      <section class="panel">
        <h2>Routing</h2>
        <p>
          {(JSON.parse(row.addresses_json) as string[]).join(", ") ||
            "All addresses on this domain"}{" "}
          → {c.env.WORKER_NAME}
        </p>
        <p class="muted">
          Cloudflare Email Routing must be enabled for this domain. Configure it
          in Cloudflare before verifying here. This page creates routing rules
          after DNS verification; it does not replace DNS records.
        </p>
        <a
          class="button"
          href={`https://dash.cloudflare.com/${c.env.CLOUDFLARE_ACCOUNT_ID}/${row.name}/email/routing/overview`}
          target="_blank"
          rel="noreferrer"
        >
          Open Cloudflare Email Routing ↗
        </a>
      </section>
      <p>
        Configure an <a href="/webhooks">email.received webhook</a> to notify
        your application.
      </p>
      <form
        method="post"
        action={`/receiving-domains/${row.name}/disable`}
        data-confirm="Disable receiving for this domain? Existing DNS records will be kept."
      >
        <button class="danger">Disable receiving</button>
      </form>
    </Layout>,
  );
});
receivingAdmin.post("/:name/verify", async (c) => {
  const row = await domain(c.env, c.req.param("name"));
  await verifyAndRoute(c.env, row);
  return c.redirect(`/receiving-domains/${row.name}`, 303);
});
receivingAdmin.post("/:name/disable", async (c) => {
  const row = await domain(c.env, c.req.param("name"));
  for (const id of JSON.parse(row.rules_json) as string[]) {
    const rule = await cf<Rule>(
      c.env,
      `/zones/${row.zone_id}/email/routing/rules/${id}`,
    );
    if (
      rule.name !== `open-resend ${row.name}` ||
      !rule.actions.some(
        (a) => a.type === "worker" && a.value?.[0] === c.env.WORKER_NAME,
      )
    )
      throw new AppError(
        409,
        "conflict",
        "A managed rule was changed outside open-resend; review it in Cloudflare.",
      );
    if (id === "catch_all")
      await cf(c.env, `/zones/${row.zone_id}/email/routing/rules/catch_all`, {
        method: "PUT",
        body: JSON.stringify({ ...rule, enabled: false }),
      });
    else
      await cf(c.env, `/zones/${row.zone_id}/email/routing/rules/${id}`, {
        method: "DELETE",
      });
    const remaining = (JSON.parse(row.rules_json) as string[]).filter(
      (value) => value !== id,
    );
    row.rules_json = JSON.stringify(remaining);
    await c.env.DB.prepare(
      "UPDATE receiving_domains SET rules_json=? WHERE name=?",
    )
      .bind(row.rules_json, row.name)
      .run();
  }
  await c.env.DB.prepare(
    "UPDATE receiving_domains SET status='disabled' WHERE name=?",
  )
    .bind(row.name)
    .run();
  return c.redirect(`/receiving-domains/${row.name}`, 303);
});
function DnsTable({ records }: { records: DnsRecord[] }) {
  return (
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Name</th>
            <th>Content</th>
            <th>TTL</th>
            <th>Priority</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr>
              <td>{r.type}</td>
              <td>
                <button type="button" data-copy-value={r.name}>
                  {r.name}
                </button>
              </td>
              <td>
                <button type="button" data-copy-value={r.content}>
                  {r.content}
                </button>
              </td>
              <td>{r.ttl === 1 ? "Auto" : (r.ttl ?? "Auto")}</td>
              <td>{r.priority ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
