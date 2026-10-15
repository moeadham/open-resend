import { applyD1Migrations, createMessageBatch, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { apiApp } from "../src/api";
import { loadBroadcastResults } from "../src/broadcast-results";
import { processDeliveryMessage } from "../src/delivery";
import { sha256 } from "../src/lib";
import type { DeliveryQueueMessage } from "../src/types";

const now = "2026-10-15T01:00:00.000Z";
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('at-domain','example.com',?)").bind(now),
    env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,created_at,updated_at) VALUES ('at-sender','at-domain','news@example.com','News','1 Main Street',?,?)").bind(now, now),
    env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('at-segment','Readers',?,?)").bind(now, now),
    env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES ('at-contact','reader@example.net',?,?)").bind(now, now),
    env.DB.prepare("INSERT INTO segment_contacts (segment_id,contact_id,status,subscribed_at,updated_at) VALUES ('at-segment','at-contact','subscribed',?,?)").bind(now, now),
    ...["news", "events"].map(topic => env.DB.prepare("INSERT INTO topics (id,name,default_subscription,visibility,created_at,updated_at) VALUES (?,?,'opt_in','public',?,?)").bind(topic, topic, now, now)),
    ...["a", "b", "global"].map(id => env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,topic_id,sender_id,from_value,subject,html,status,created_at,updated_at) VALUES (?,?,'at-segment',?,'at-sender','news@example.com','News','<p>Hello</p>','sent',?,?)").bind(id, id, id === "global" ? null : "news", now, now)),
    ...["a", "b", "global"].map(id => env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,contact_id,recipient,status,message_id,created_at,updated_at) VALUES (?,?,'at-contact','reader@example.net','delivered',?,?,?)").bind(`delivery-${id}`, id, `message-${id}`, now, now)),
  ]);
  for (const id of ["a", "b", "global"]) {
    await env.DB.prepare("INSERT INTO unsubscribe_tokens (token_hash,contact_id,topic_id,delivery_id,created_at) VALUES (?,'at-contact',?,?,?)")
      .bind(await sha256(`token-${id}`), id === "global" ? null : "news", `delivery-${id}`, now).run();
  }
  await env.DB.prepare("INSERT INTO unsubscribe_tokens (token_hash,contact_id,topic_id,created_at) VALUES (?,'at-contact','news',?)")
    .bind(await sha256("legacy-token"), now).run();
});

const post = (token: string, body = "List-Unsubscribe=One-Click") => apiApp.request(`https://api.example.com/unsubscribe/${token}`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
}, env);
const report = (id: string) => loadBroadcastResults(env.DB, id, new URLSearchParams({ delivery_status: "unsubscribed" }));

describe("broadcast unsubscribe attribution", () => {
  it("counts a one-click action only for the originating broadcast, once, and keeps it after resubscribing", async () => {
    expect((await apiApp.request("https://api.example.com/unsubscribe/token-a", {}, env)).status).toBe(200);
    expect((await report("a")).unsubscribed).toBe(0); // A visit/link scanner is not an unsubscribe.
    expect((await post("token-a")).status).toBe(200);
    const first = (await report("a")).recipients[0]?.unsubscribed_at;
    expect(first).toBeTruthy();
    expect((await report("a")).unsubscribed).toBe(1);
    expect((await report("b")).unsubscribed).toBe(0);
    await Promise.all([post("token-a"), post("token-a")]);
    expect((await report("a")).recipients[0]?.unsubscribed_at).toBe(first);
    await post("token-b"); // Already opted out: not a new transition from B.
    expect((await report("b")).unsubscribed).toBe(0);
    await post("token-a", "preference_form=1&topic=news&topic=events");
    expect(await env.DB.prepare("SELECT subscription FROM contact_topics WHERE contact_id='at-contact' AND topic_id='news'").first("subscription")).toBe("opt_in");
    expect((await report("a")).unsubscribed).toBe(1);
    await post("token-a");
    expect((await report("a")).recipients[0]?.unsubscribed_at).toBe(first);
    expect((await report("b")).unsubscribed).toBe(0);
  });

  it("attributes preference-form opt-outs only when the broadcast topic is disabled", async () => {
    await post("token-a", "preference_form=1&topic=news"); // Disable Events only.
    expect((await report("a")).unsubscribed).toBe(0);
    await post("token-a", "preference_form=1&topic=events");
    expect((await report("a")).unsubscribed).toBe(1);
    expect((await report("b")).unsubscribed).toBe(0);
  });

  it.each(["token-global", "token-a"])("attributes global unsubscribe from %s without changing other broadcast counters", async token => {
    const origin = token === "token-global" ? "global" : "a";
    expect((await post(token, "unsubscribe_all=1")).status).toBe(200);
    expect(await env.DB.prepare("SELECT unsubscribed FROM contacts WHERE id='at-contact'").first("unsubscribed")).toBe(1);
    expect((await report(origin)).unsubscribed).toBe(1);
    expect((await report("b")).unsubscribed).toBe(0);
    await post("token-b");
    expect((await report("b")).unsubscribed).toBe(0);
  });

  it("preserves legacy unsubscribe links without guessing a broadcast", async () => {
    expect((await post("legacy-token")).status).toBe(200);
    expect(await env.DB.prepare("SELECT subscription FROM contact_topics WHERE contact_id='at-contact' AND topic_id='news'").first("subscription")).toBe("opt_out");
    expect((await report("a")).unsubscribed).toBe(0);
    expect((await report("b")).unsubscribed).toBe(0);
    expect((await post("invalid-token")).status).toBe(404);
  });

  it("does not attribute admin/API preference changes and retains attribution when the contact is deleted", async () => {
    await env.DB.prepare("UPDATE contacts SET unsubscribed=1 WHERE id='at-contact'").run();
    expect((await report("a")).unsubscribed).toBe(0);
    await env.DB.prepare("UPDATE contacts SET unsubscribed=0 WHERE id='at-contact'").run();
    await post("token-a");
    await env.DB.prepare("DELETE FROM contacts WHERE id='at-contact'").run();
    expect((await report("a")).unsubscribed).toBe(1);
    expect((await report("a")).recipients[0]?.contact_id).toBe(null);
  });

  it("writes the delivery identity on unsubscribe tokens generated during sending", async () => {
    await env.DB.prepare("UPDATE deliveries SET status='pending',message_id=NULL WHERE id='delivery-a'").run();
    const batch = createMessageBatch<DeliveryQueueMessage>("cloudflare-resend-deliveries", [{ id: "job", timestamp: new Date(), attempts: 1, body: { deliveryId: "delivery-a" } }]);
    const fakeEmailEnv = new Proxy(env, { get(target, key, receiver) {
      return key === "EMAIL" ? { send: async () => ({ messageId: "new-message-a" }) } : Reflect.get(target, key, receiver);
    } });
    await processDeliveryMessage(batch.messages[0]!, fakeEmailEnv);
    expect(await env.DB.prepare("SELECT COUNT(*) FROM unsubscribe_tokens WHERE delivery_id='delivery-a'").first("COUNT(*)")).toBe(2);
    expect(await env.DB.prepare("SELECT status FROM deliveries WHERE id='delivery-a'").first("status")).toBe("accepted");
  });

  it("rolls back attribution if the corresponding preference update fails", async () => {
    await env.DB.exec("CREATE TRIGGER reject_test_optout BEFORE INSERT ON contact_topics BEGIN SELECT RAISE(ABORT, 'test preference failure'); END;");
    const response = await post("token-a");
    expect(response.status).toBe(500);
    expect((await report("a")).unsubscribed).toBe(0);
  });
});
