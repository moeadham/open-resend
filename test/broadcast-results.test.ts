import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { loadBroadcastResults } from "../src/broadcast-results";
import { BroadcastResultsPanel } from "../src/ui/broadcast-results";

const now = "2026-10-15T01:00:00.000Z";
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('results-domain','example.com',?)").bind(now),
    env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,created_at,updated_at) VALUES ('results-sender','results-domain','news@example.com','News','1 Main Street',?,?)").bind(now, now),
    env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('results-segment','Readers',?,?)").bind(now, now),
    env.DB.prepare("INSERT INTO topics (id,name,default_subscription,created_at,updated_at) VALUES ('results-topic','News','opt_in',?,?)").bind(now, now),
    env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,topic_id,sender_id,from_value,subject,html,status,created_at,updated_at) VALUES ('results-broadcast','News','results-segment','results-topic','results-sender','news@example.com','News','<p>Hello</p>','sent',?,?)").bind(now, now),
  ]);
  for (let index = 0; index < 27; index++) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES (?,?,?,?)").bind(`results-contact-${index}`, `reader${index}@example.net`, now, now),
      env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,contact_id,recipient,status,attempts,message_id,last_error,created_at,updated_at) VALUES (?,'results-broadcast',?,?,?,?,?,?,?,?)")
        .bind(`results-delivery-${String(index).padStart(2, "0")}`, `results-contact-${index}`, `reader${index}@example.net`, index < 23 ? "delivered" : index === 23 ? "accepted" : index === 24 ? "bounced" : index === 25 ? "failed" : "rejected", 1, `message-${index}`, index === 24 ? "Mailbox does not exist" : null, now, now),
    ]);
  }
});

describe("broadcast recipient reporting", () => {
  it("paginates all recipients with stable ordering and never treats accepted as delivered", async () => {
    const first = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams());
    const second = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_page: "2" }));
    expect(first.total).toBe(27);
    expect(first.counts.delivered).toBe(23);
    expect(first.counts.accepted).toBe(1);
    expect(first.recipients).toHaveLength(10);
    expect(second.recipients).toHaveLength(10);
    expect(first.recipients.some(a => second.recipients.some(b => a.id === b.id))).toBe(false);
    const last = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_page: "999" }));
    expect(last.page).toBe(3);
    expect(last.recipients).toHaveLength(7);
  });

  it("reports current topic/global opt-outs separately from delivery status", async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE contacts SET unsubscribed=1 WHERE id='results-contact-0'"),
      env.DB.prepare("INSERT INTO contact_topics (topic_id,contact_id,subscription,updated_at) VALUES ('results-topic','results-contact-1','opt_out',?)").bind(now),
      env.DB.prepare("INSERT INTO contact_topics (topic_id,contact_id,subscription,updated_at) VALUES ('results-topic','results-contact-0','opt_out',?)").bind(now),
    ]);
    const result = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_status: "unsubscribed" }));
    expect(result.unsubscribed).toBe(2);
    expect(result.filteredTotal).toBe(2);
    expect(result.recipients.every(row => row.status === "delivered" && row.opted_out === 1)).toBe(true);
    await env.DB.prepare("UPDATE broadcasts SET topic_id=NULL WHERE id='results-broadcast'").run();
    const global = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_status: "unsubscribed" }));
    expect(global.unsubscribed).toBe(1);
  });

  it("filters failures, pending provider acceptance, literal search, and invalid pages safely", async () => {
    const failed = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_status: "failed" }));
    expect(failed.filteredTotal).toBe(2);
    const pending = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_status: "pending" }));
    expect(pending.recipients.map(row => row.status)).toEqual(["accepted"]);
    for (const search of ["%", "_", "' OR 1=1 --"]) {
      const result = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_search: search }));
      expect(result.filteredTotal).toBe(0);
    }
    const found = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_search: " READER24@EXAMPLE.NET ", delivery_status: "bounced", delivery_page: "NaN" }));
    expect(found.page).toBe(1);
    expect(found.recipients[0]?.last_error).toBe("Mailbox does not exist");
    const invalid = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_status: "invalid", delivery_page: "-10" }));
    expect(invalid.filter).toBe("all");
    expect(invalid.page).toBe(1);
  });

  it("keeps historical deliveries after a contact is deleted and renders mobile diagnostics", async () => {
    await env.DB.prepare("DELETE FROM contacts WHERE id='results-contact-24'").run();
    const result = await loadBroadcastResults(env.DB, "results-broadcast", new URLSearchParams({ delivery_status: "bounced" }));
    expect(result.filteredTotal).toBe(1);
    expect(result.recipients[0]?.contact_id).toBe(null);
    const html = BroadcastResultsPanel({ id: "results-broadcast", results: result, canRetry: true }).toString();
    expect(html).toContain("<summary>");
    expect(html).toContain("Mailbox does not exist");
    expect(html).toContain("not campaign-attributed clicks");
    expect(html).not.toContain("mobile-hide");
    expect(html).not.toContain("View contact");
    expect(html).toContain("data-confirm");
  });
});
