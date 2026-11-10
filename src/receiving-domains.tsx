import { Hono } from "hono";
import { AppError, isEmail, nowIso, sha256 } from "./lib";
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
  const normalized = required.map(r => ({ ...r, content: r.type === "TXT" ? txtValue(r.content) : r.content }));
  if (row.name === zone.name) return normalized;
  // The deprecated subdomain query has an undocumented response. Use the zone's
  // authoritative routing MX/SPF template; subdomain onboarding remains in Cloudflare.
  return normalized
    .filter(
      (r) =>
        r.type === "MX" || (r.type === "TXT" && r.content.startsWith("v=spf1")),
    )
    .map((r) => ({ ...r, name: row.name }));
}
function txtValue(value: string): string {
  return value.trim().replace(/^"|"$/g, "").replace(/"\s*"/g, "");
}
function dnsName(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}
type DnsChange = { action: "Add" | "Update"; record: DnsRecord };
type DnsPlan = {
  changes: DnsChange[];
  conflicts: DnsRecord[];
  snapshot: string;
  routingEnabled: boolean;
  blockers: string[];
};
async function dnsPlan(env: RoutingEnv, row: ReceivingDomain, required: DnsRecord[]): Promise<DnsPlan> {
  if (!required.some(r => r.type === "MX")) throw new AppError(422, "validation_error", "Cloudflare did not provide receiving MX records.");
  const owners = [...new Set(required.map(r => dnsName(r.name)))].sort();
  for (const owner of owners) {
    if (owner !== dnsName(row.name) && !owner.endsWith(`.${dnsName(row.name)}`)) {
      throw new AppError(409, "conflict", "The DNS template includes records outside this receiving domain.");
    }
  }
  const groups = await Promise.all(owners.map(owner => cf<DnsRecord[]>(env,
    `/zones/${row.zone_id}/dns_records?name=${encodeURIComponent(owner)}&per_page=100`,
  )));
  if (groups.some(group => group.length >= 100)) throw new AppError(409, "conflict", "Too many existing DNS records to review automatically.");
  const existing = groups.flat();
  const settings = await cf<{ enabled: boolean }>(env, `/zones/${row.zone_id}/email/routing`);
  const blockers: string[] = [];
  const changes: DnsChange[] = [];
  for (const template of required) {
    if (!["MX", "TXT"].includes(template.type)) throw new AppError(422, "validation_error", "Unsupported receiving DNS record type.");
    const record = { ...template, name: dnsName(template.name), content: template.type === "TXT" ? txtValue(template.content) : template.content, ttl: template.ttl ?? 1 };
    const atName = existing.filter(e => dnsName(e.name) === record.name);
    if (atName.some(e => e.type === "CNAME")) {
      blockers.push(`A CNAME at ${record.name} conflicts with the required records.`);
      continue;
    }
    if (record.type === "TXT" && /^v=spf1(?:\s|$)/i.test(record.content)) {
      const spf = atName.filter(e => e.type === "TXT" && /^v=spf1(?:\s|$)/i.test(txtValue(e.content)));
      if (spf.length > 1) {
        blockers.push(`Multiple SPF records exist at ${record.name}; combine them before migrating.`);
        continue;
      }
      if (spf[0]) {
        const old = txtValue(spf[0].content).split(/\s+/);
        const added = record.content.split(/\s+/).slice(1).filter(term => !/^[+?~-]?all$/i.test(term) && !old.includes(term));
        if (!added.length) continue;
        const end = old.findIndex(term => /^[+?~-]?all$/i.test(term));
        old.splice(end < 0 ? old.length : end, 0, ...added);
        changes.push({ action: "Update", record: { ...record, id: spf[0].id, content: old.join(" "), ttl: spf[0].ttl ?? 1 } });
        continue;
      }
    }
    const same = atName.find(e => e.type === record.type &&
      (record.type === "MX" ? dnsName(e.content) === dnsName(record.content) : txtValue(e.content) === record.content));
    if (same) {
      if (record.type === "MX" && same.priority !== record.priority) changes.push({ action: "Update", record: { ...record, id: same.id } });
      continue;
    }
    if (record.type === "TXT" && /\._domainkey\./.test(record.name) && atName.some(e => e.type === "TXT")) {
      blockers.push(`A different DKIM key already exists at ${record.name}; review it before migrating.`);
      continue;
    }
    changes.push({ action: "Add", record });
  }
  const conflicts = existing.filter(e => e.type === "MX" && dnsName(e.name) === dnsName(row.name) &&
    !required.some(r => r.type === "MX" && dnsName(r.content) === dnsName(e.content)));
  const snapshot = await sha256(JSON.stringify({ required, existing: existing.map(e => ({ id: e.id, type: e.type, name: e.name, content: e.content, priority: e.priority, ttl: e.ttl })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), routingEnabled: settings.enabled }));
  return { changes, conflicts, snapshot, routingEnabled: settings.enabled, blockers: [...new Set(blockers)] };
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
  const plan = await dnsPlan(c.env, row, required);
  const conflicts = plan.conflicts;
  return c.html(
    <Layout title="Receiving domain">
      <PageHead title={row.name}>
        <ModalTrigger target="migrate-receiving-dns">Migrate now</ModalTrigger>
      </PageHead>
      <Modal id="migrate-receiving-dns" title={`Migrate ${row.name}`}>
        <DnsMigrationForm name={row.name} plan={plan} />
      </Modal>
      {c.req.query("dns") === "updated" && <div class="panel">DNS changes submitted. Allow time for propagation, then verify receiving. Cloudflare Email Routing must also be enabled.</div>}

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
            before verifying receiving, or choose Migrate now to review DNS changes.
          </div>
        )}
        <DnsTable records={required} />
        <details>
          <summary class="button">Migrate now</summary>
          <DnsMigrationForm name={row.name} plan={plan} />
        </details>
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
          after DNS verification. Migrate now writes the DNS changes you approve.
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
receivingAdmin.post("/:name/migrate-dns", async (c) => {
  const row = await domain(c.env, c.req.param("name"));
  const form = await c.req.parseBody();
  if (form.confirm_dns !== row.name || !["replace", "overlap"].includes(String(form.mx_mode)))
    throw new AppError(422, "validation_error", "Confirm the DNS migration and select how to handle existing MX records.");
  const plan = await dnsPlan(c.env, row, await records(c.env, row));
  if (form.snapshot !== plan.snapshot)
    throw new AppError(409, "conflict", "DNS records changed since this preview. Reload the page and review the new migration plan.");
  if (plan.blockers.length) throw new AppError(409, "conflict", plan.blockers.join(" "));
  if (form.mx_mode === "replace" && plan.conflicts.length && !plan.routingEnabled)
    throw new AppError(422, "validation_error", "Enable Cloudflare Email Routing before replacing your existing provider's MX records. You can add overlapping records first.");
  const deletes = form.mx_mode === "replace" ? plan.conflicts.map(r => ({ id: r.id })) : [];
  if (plan.changes.some(change => change.action === "Update" && !change.record.id) || deletes.some(record => !record.id))
    throw new AppError(409, "conflict", "Cloudflare did not return record IDs; no DNS records were changed.");
  const batch = {
    deletes,
    patches: plan.changes.filter(change => change.action === "Update").map(({record}) => ({ id: record.id, type: record.type, name: record.name, content: record.content, ttl: record.ttl ?? 1, ...(record.type === "MX" ? { priority: record.priority } : {}) })),
    posts: plan.changes.filter(change => change.action === "Add").map(({record}) => ({ type: record.type, name: record.name, content: record.content, ttl: record.ttl ?? 1, ...(record.type === "MX" ? { priority: record.priority } : {}) })),
  };
  if (deletes.length || batch.patches.length || batch.posts.length) {
    await cf(c.env, `/zones/${row.zone_id}/dns_records/batch`, { method: "POST", body: JSON.stringify(batch) });
    await c.env.DB.prepare("UPDATE receiving_domains SET status='pending' WHERE name=?").bind(row.name).run();
  }
  return c.redirect(`/receiving-domains/${row.name}?dns=updated`, 303);
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

function DnsMigrationForm({ name, plan }: { name: string; plan: DnsPlan }) {
  const canReplace = plan.routingEnabled || !plan.conflicts.length;
  return <form method="post" action={`/receiving-domains/${name}/migrate-dns`}>
    <p>Review the DNS changes for <strong>{name}</strong>. Existing SPF permissions are preserved. Other domains are unaffected.</p>
    <input type="hidden" name="snapshot" value={plan.snapshot} />
    {plan.blockers.map(message => <div class="panel error">{message}</div>)}
    {plan.changes.length > 0 && <>
      <h3>Records to add or update</h3>
      <div class="table-shell"><table><thead><tr><th>Action</th><th>Type</th><th>Name</th><th>New value</th><th>TTL</th><th>Priority</th></tr></thead>
        <tbody>{plan.changes.map(({action, record}) => <tr><td>{action}</td><td>{record.type}</td><td>{record.name}</td><td><code>{record.content}</code></td><td>{record.ttl === 1 ? "Auto" : record.ttl}</td><td>{record.priority ?? "—"}</td></tr>)}</tbody>
      </table></div>
    </>}
    {plan.conflicts.length > 0 ? <>
      <h3>Existing provider MX records</h3>
      <DnsTable records={plan.conflicts} />
      <label>Handle existing MX records</label>
      <select name="mx_mode">
        <option value="replace" selected={canReplace} disabled={!canReplace}>Replace these MX records — move mail to Cloudflare</option>
        <option value="overlap" selected={!canReplace}>Keep these MX records — add Cloudflare alongside them</option>
      </select>
      <p class="field-help">Keeping both providers can leave mail going to your old provider. Receiving verification stays blocked until the old MX records are removed.</p>
    </> : <input type="hidden" name="mx_mode" value="overlap" />}
    {!plan.routingEnabled && <div class="panel error">Cloudflare Email Routing is not enabled yet. You can add records now, but enable routing before moving mail away from your existing provider.</div>}
    {!plan.changes.length && !plan.conflicts.length ? <p>The required DNS records are already present. You can verify receiving.</p> : <>
      <p class="field-help">Writing records requires DNS Edit permission. DNS changes may take time to propagate. This action does not enable Cloudflare routing or mark the domain verified.</p>
      <label class="dns-migration-confirm"><input type="checkbox" name="confirm_dns" value={name} required /> I approve the displayed DNS changes for {name} and the selected handling of existing MX records.</label>
      <button class="primary" disabled={plan.blockers.length > 0}>Migrate now</button>
    </>}
  </form>;
}
