import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Resend } from "resend";
import { nowIso, sha256 } from "../src/lib";

const API_KEY = "re_contract_test_key";
let accessPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let accessPublicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  accessPrivateKey = pair.privateKey;
  accessPublicJwk = { ...await exportJWK(pair.publicKey), kid: "access-test", alg: "RS256", use: "sig" };
});

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_events"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM unsubscribe_tokens"),
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM broadcasts"),
    env.DB.prepare("DELETE FROM contact_topics"),
    env.DB.prepare("DELETE FROM segment_contacts"),
    env.DB.prepare("DELETE FROM contacts"),
    env.DB.prepare("DELETE FROM senders"),
    env.DB.prepare("DELETE FROM domains"),
    env.DB.prepare("DELETE FROM segments"),
    env.DB.prepare("DELETE FROM topics"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind("test-key", "Contract tests", "re_contract", await sha256(API_KEY), nowIso()).run();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://example.cloudflareaccess.com/cdn-cgi/access/certs") {
      return Promise.resolve(Response.json({ keys: [accessPublicJwk] }));
    }
    return SELF.fetch(input, init);
  });
});

describe("Resend-compatible API", () => {
  it("requires a Cloudflare Access JWT on the admin hostname", async () => {
    const response = await SELF.fetch("https://admin.example.com/");
    expect(response.status).toBe(401);
  });

  it("validates Access JWT signature, issuer, audience, and expiration", async () => {
    const valid = await accessToken("replace-with-access-application-aud", "5 minutes");
    expect((await SELF.fetch("https://admin.example.com/", { headers: { "Cf-Access-Jwt-Assertion": valid } })).status).toBe(200);

    const wrongAudience = await accessToken("wrong-audience", "5 minutes");
    expect((await SELF.fetch("https://admin.example.com/", { headers: { "Cf-Access-Jwt-Assertion": wrongAudience } })).status).toBe(401);

    const expired = await accessToken("replace-with-access-application-aud", Math.floor(Date.now() / 1000) - 60);
    expect((await SELF.fetch("https://admin.example.com/", { headers: { "Cf-Access-Jwt-Assertion": expired } })).status).toBe(401);
    expect((await SELF.fetch("https://admin.example.com/", { headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" } })).status).toBe(401);
  });

  it("provides contact detail, segment membership, and topic preference actions in the admin", async () => {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES ('contact-admin','person@example.net',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('segment-admin','Updates',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO topics (id,name,description,default_subscription,visibility,created_at,updated_at) VALUES ('topic-admin','Product news','Release notes','opt_in','public',?,?)").bind(now, now),
    ]);
    const token = await accessToken("replace-with-access-application-aud", "5 minutes");
    const authHeaders = { "Cf-Access-Jwt-Assertion": token };
    const detail = await SELF.fetch("https://admin.example.com/contacts/contact-admin", { headers: authHeaders });
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("Contact details");
    expect(detailHtml).toContain("Segments are internal recipient groups");
    expect(detailHtml).toContain("Product news");

    const added = await SELF.fetch("https://admin.example.com/contacts/contact-admin/segments", {
      method: "POST",
      redirect: "manual",
      headers: { ...authHeaders, Origin: "https://admin.example.com" },
      body: new URLSearchParams({ segment_id: "segment-admin" }),
    });
    expect(added.status).toBe(303);
    expect((await env.DB.prepare("SELECT status FROM segment_contacts WHERE contact_id='contact-admin' AND segment_id='segment-admin'").first<{ status: string }>())?.status).toBe("subscribed");

    const removed = await SELF.fetch("https://admin.example.com/contacts/contact-admin/segments/segment-admin", {
      method: "POST",
      redirect: "manual",
      headers: { ...authHeaders, Origin: "https://admin.example.com" },
      body: new URLSearchParams({ status: "removed" }),
    });
    expect(removed.status).toBe(303);
    expect((await env.DB.prepare("SELECT status FROM segment_contacts WHERE contact_id='contact-admin' AND segment_id='segment-admin'").first<{ status: string }>())?.status).toBe("removed");

    const optedOut = await SELF.fetch("https://admin.example.com/contacts/contact-admin/topics/topic-admin", {
      method: "POST", redirect: "manual", headers: { ...authHeaders, Origin: "https://admin.example.com" },
      body: new URLSearchParams({ subscription: "opt_out" }),
    });
    expect(optedOut.status).toBe(303);
    expect((await env.DB.prepare("SELECT subscription FROM contact_topics WHERE contact_id='contact-admin' AND topic_id='topic-admin'").first<{ subscription: string }>())?.subscription).toBe("opt_out");
  });

  it("registers sending domains before creating senders", async () => {
    const token = await accessToken("replace-with-access-application-aud", "5 minutes");
    const authHeaders = { "Cf-Access-Jwt-Assertion": token };
    const page = await SELF.fetch("https://admin.example.com/senders", { headers: authHeaders });
    const html = await page.text();
    expect(html).toContain("Add domain");
    expect(html).toContain("Add sender");
    expect(html).toContain("Enable domains in Cloudflare Email Sending before adding them here.");
    expect(html).toContain("Open Email Sending");
    expect(html).toContain('class="button"');
    expect(html).toContain("https://dash.cloudflare.com/?to=/:account/email-service/sending");

    const registered = await SELF.fetch("https://admin.example.com/senders/domains", {
      method: "POST", redirect: "manual", headers: { ...authHeaders, Origin: "https://admin.example.com" },
      body: new URLSearchParams({ domain: "Example.COM" }),
    });
    expect(registered.status).toBe(303);
    const domain = await env.DB.prepare("SELECT id,name FROM domains WHERE name='example.com'").first<{ id: string; name: string }>();
    expect(domain).toMatchObject({ name: "example.com" });

    const created = await SELF.fetch("https://admin.example.com/senders", {
      method: "POST", redirect: "manual", headers: { ...authHeaders, Origin: "https://admin.example.com" },
      body: new URLSearchParams({ domain_id: domain?.id ?? "", email: "news@example.com", name: "News", postal_address: "1 Main Street", return_to: "/senders" }),
    });
    expect(created.status).toBe(303);
    expect(await env.DB.prepare("SELECT d.name FROM senders s JOIN domains d ON d.id=s.domain_id WHERE s.email='news@example.com'").first()).toMatchObject({ name: "example.com" });

    const invalid = await SELF.fetch("https://admin.example.com/senders", {
      method: "POST", headers: { ...authHeaders, Origin: "https://admin.example.com" },
      body: new URLSearchParams({ domain_id: domain?.id ?? "", email: "news@elsewhere.example", name: "News", postal_address: "1 Main Street" }),
    });
    expect(invalid.status).toBe(422);
  });

  it("shows an explicit send action when reviewing a draft broadcast", async () => {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('domain-admin','example.com',?)").bind(now),
      env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,active,created_at,updated_at) VALUES ('sender-admin','domain-admin','news@example.com','Example News','1 Main Street',1,?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('segment-broadcast','Readers',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES ('contact-broadcast','reader@example.net',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO segment_contacts (segment_id,contact_id,status,subscribed_at,updated_at) VALUES ('segment-broadcast','contact-broadcast','subscribed',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,text,status,created_at,updated_at) VALUES ('broadcast-admin','Draft update','segment-broadcast','sender-admin','Example News <news@example.com>','Hello','<p>Hello</p>','Hello','draft',?,?)").bind(now, now),
    ]);
    const token = await accessToken("replace-with-access-application-aud", "5 minutes");
    const response = await SELF.fetch("https://admin.example.com/broadcasts/broadcast-admin", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Send now");
    expect(html).toContain("Edit");
    expect(html).toContain("Ready to send?");
    expect(html).toContain("1 eligible recipient");
    expect(html).toContain("Unsubscribe handled automatically");
    expect(html).toContain("Schedule broadcast");
    expect(html).toContain("Pick a suggested time or choose an exact date below.");
    expect(html).toContain("Tomorrow morning");
    expect(html).toContain("data-date-picker");
    expect(html).toContain("Send yourself a preview");
    expect(html).toContain('id="send-broadcast"');
    expect(html).not.toContain("Retry failures");

    await env.DB.batch([
      env.DB.prepare("UPDATE broadcasts SET status='sent',sent_at=?,updated_at=? WHERE id='broadcast-admin'").bind(now, now),
      env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,recipient,status,attempts,last_error,created_at,updated_at) VALUES ('delivery-admin','broadcast-admin','failed@example.com','failed',3,'Temporary failure',?,?)").bind(now, now),
    ]);
    const failed = await SELF.fetch("https://admin.example.com/broadcasts/broadcast-admin", { headers: { "Cf-Access-Jwt-Assertion": token } });
    const failedHtml = await failed.text();
    expect(failedHtml).toContain("Retry failures");
    expect(failedHtml).toContain("responsive-table");
  });

  it("uses an empty campaign body instead of saving editor placeholder text", async () => {
    const token = await accessToken("replace-with-access-application-aud", "5 minutes");
    const response = await SELF.fetch("https://admin.example.com/broadcasts/new", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="html-input"');
    expect(html).not.toContain("<p>Start writing your email…</p>");
  });

  it("paginates broadcast administration at 40 rows", async () => {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('domain-page','example.com',?)").bind(now),
      env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,active,created_at,updated_at) VALUES ('sender-page','domain-page','pages@example.com','Pages','1 Main Street',1,?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('segment-page','Pagination',?,?)").bind(now, now),
      ...Array.from({ length: 41 }, (_, index) => env.DB.prepare(
        "INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,text,status,created_at,updated_at) VALUES (?,?, 'segment-page','sender-page','Pages <pages@example.com>','Page','<p>Page</p>','Page','draft',?,?)",
      ).bind(`broadcast-page-${index}`, `Page ${index}`, now, now)),
    ]);
    const token = await accessToken("replace-with-access-application-aud", "5 minutes");
    const headers = { "Cf-Access-Jwt-Assertion": token };
    const first = await (await SELF.fetch("https://admin.example.com/broadcasts", { headers })).text();
    expect(first).toContain("Page 1 · 41 broadcasts · 40 items");
    expect(first).toContain("Older");
    const second = await (await SELF.fetch("https://admin.example.com/broadcasts?page=2", { headers })).text();
    expect(second).toContain("Page 2 · 41 broadcasts · 40 items");
    expect(second).toContain("Newer");
  });

  it("rejects requests without an API key", async () => {
    const response = await SELF.fetch("https://api.example.com/segments");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ name: "invalid_api_key", statusCode: 401 });
  });

  it("limits unsubscribe hostnames to public unsubscribe routes", async () => {
    const apiResponse = await SELF.fetch("https://api.example.com/segments");
    expect(apiResponse.status).toBe(401);

    const alternateApiResponse = await SELF.fetch("https://mail.example.com/segments");
    expect(alternateApiResponse.status).toBe(404);
  });

  it("supports segments through the official Resend SDK", async () => {
    const resend = new Resend(API_KEY, { baseUrl: "https://api.example.com" });
    const created = await resend.segments.create({ name: "Customers" });
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ object: "segment", name: "Customers" });

    const listed = await resend.segments.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.data).toHaveLength(1);
    expect(listed.data?.data[0]?.name).toBe("Customers");
  });

  it("supports Topics and contact preferences through the official Resend SDK", async () => {
    const resend = new Resend(API_KEY, { baseUrl: "https://api.example.com" });
    const created = await resend.topics.create({ name: "Product updates", description: "Release news", defaultSubscription: "opt_in" });
    expect(created.error).toBeNull();
    const topicId = created.data?.id;
    expect(topicId).toBeTruthy();
    expect((await resend.topics.list()).data?.data[0]).toMatchObject({ id: topicId, name: "Product updates", default_subscription: "opt_in" });

    const contact = await resend.contacts.create({ email: "topics@example.net" });
    const contactId = contact.data?.id;
    expect(contactId).toBeTruthy();
    const updated = await resend.contacts.topics.update({ id: contactId!, topics: [{ id: topicId!, subscription: "opt_out" }] });
    expect(updated.error).toBeNull();
    expect((await resend.contacts.topics.list({ id: contactId! })).data?.data[0]).toMatchObject({ id: topicId, subscription: "opt_out" });
  });

  it("supports contacts, segment membership, and broadcasts through the SDK", async () => {
    const resend = new Resend(API_KEY, { baseUrl: "https://api.example.com" });
    const segment = await resend.segments.create({ name: "Product updates" });
    const segmentId = segment.data?.id;
    expect(segmentId).toBeTruthy();
    const topic = await resend.topics.create({ name: "Announcements", defaultSubscription: "opt_in" });
    const topicId = topic.data?.id;

    const contact = await resend.contacts.create({
      email: "reader@example.net",
      firstName: "Ada",
      segments: [{ id: segmentId! }],
    });
    expect(contact.error).toBeNull();

    const contacts = await resend.contacts.list({ segmentId });
    expect(contacts.data?.data[0]).toMatchObject({ email: "reader@example.net", first_name: "Ada" });

    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO domains (id, name, created_at) VALUES ('domain-1', 'example.com', ?)").bind(now),
      env.DB.prepare(
        `INSERT INTO senders (id, domain_id, email, name, postal_address, active, created_at, updated_at)
         VALUES ('sender-1', 'domain-1', 'news@example.com', 'Example News', '1 Main Street', 1, ?, ?)`,
      ).bind(now, now),
    ]);

    const broadcastPayload = {
      name: "October update",
      segmentId: segmentId!,
      topicId: topicId!,
      from: "Example News <news@example.com>",
      subject: "Hello",
      html: "<p>Hello, world.</p>",
      send: false as const,
    };
    const idempotentRequest = { headers: { "Idempotency-Key": "october-update" } };
    const broadcast = await resend.broadcasts.create(broadcastPayload, idempotentRequest);
    expect(broadcast.error).toBeNull();
    expect(broadcast.data?.id).toBeTruthy();

    const replay = await resend.broadcasts.create(broadcastPayload, idempotentRequest);
    expect(replay.error).toBeNull();
    expect(replay.data?.id).toBe(broadcast.data?.id);
    const stored = await env.DB.prepare("SELECT COUNT(*) AS count FROM broadcasts").first<{ count: number }>();
    expect(Number(stored?.count)).toBe(1);

    const loaded = await resend.broadcasts.get(broadcast.data!.id);
    expect(loaded.data).toMatchObject({ name: "October update", status: "draft", segment_id: segmentId, topic_id: topicId });
  });

  it("uses global unsubscribe for broadcasts without a Topic", async () => {
    const now = nowIso();
    const token = "unsubscribe-token";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('c1', 'person@example.net', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO unsubscribe_tokens (token_hash, contact_id, topic_id, created_at) VALUES (?, 'c1', NULL, ?)").bind(await sha256(token), now),
    ]);

    const page = await SELF.fetch(`https://api.example.com/unsubscribe/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Unsubscribe from all emails?");
    expect(pageHtml).toContain("person@example.net");
    expect(pageHtml).toContain("Unsubscribe from all");
    expect(pageHtml).not.toContain("Cloudflare Mail");
    expect(pageHtml).not.toContain("Powered by");
    expect((await env.DB.prepare("SELECT unsubscribed FROM contacts WHERE id='c1'").first<{ unsubscribed: number }>())?.unsubscribed).toBe(0);

    const posted = await SELF.fetch(`https://api.example.com/unsubscribe/${token}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(posted.status).toBe(200);
    const postedHtml = await posted.text();
    expect(postedHtml).toContain("You’re unsubscribed from all emails");
    expect((await env.DB.prepare("SELECT unsubscribed FROM contacts WHERE id='c1'").first<{ unsubscribed: number }>())?.unsubscribed).toBe(1);
  });

  it("shows Topic toggles and one-click unsubscribes only the broadcast Topic", async () => {
    const now = nowIso(); const token = "topic-token";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES ('ct','topics@example.net',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO topics (id,name,description,default_subscription,visibility,created_at,updated_at) VALUES ('t1','Product updates','Release news','opt_in','public',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO topics (id,name,description,default_subscription,visibility,created_at,updated_at) VALUES ('t2','Events','Invitations','opt_in','public',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO unsubscribe_tokens (token_hash,contact_id,topic_id,created_at) VALUES (?,'ct','t1',?)").bind(await sha256(token), now),
    ]);
    const page = await SELF.fetch(`https://api.example.com/unsubscribe/${token}`);
    const html = await page.text();
    expect(html).toContain("Manage your email preferences");
    expect(html).toContain("Product updates");
    expect(html).toContain("Events");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM contact_topics").first<{ count: number }>())?.count).toBe(0);

    await SELF.fetch(`https://api.example.com/unsubscribe/${token}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect((await env.DB.prepare("SELECT subscription FROM contact_topics WHERE contact_id='ct' AND topic_id='t1'").first<{ subscription: string }>())?.subscription).toBe("opt_out");
    expect((await env.DB.prepare("SELECT unsubscribed FROM contacts WHERE id='ct'").first<{ unsubscribed: number }>())?.unsubscribed).toBe(0);

    const saved = await SELF.fetch(`https://api.example.com/unsubscribe/${token}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "preference_form=1&topic=t1" });
    expect((await saved.text())).toContain("Your preferences were updated");
    const preferences = await env.DB.prepare("SELECT topic_id,subscription FROM contact_topics WHERE contact_id='ct' ORDER BY topic_id").all<{ topic_id: string; subscription: string }>();
    expect(preferences.results).toEqual([{ topic_id: "t1", subscription: "opt_in" }, { topic_id: "t2", subscription: "opt_out" }]);
  });

  it("serves unsubscribe links on a configured sender-domain hostname only", async () => {
    const now = nowIso();
    const token = "domain-unsubscribe-token";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('c2', 'other@example.net', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO unsubscribe_tokens (token_hash, contact_id, topic_id, created_at) VALUES (?, 'c2', NULL, ?)").bind(await sha256(token), now),
    ]);

    expect((await SELF.fetch(`https://mail.example.com/unsubscribe/${token}`)).status).toBe(200);
    expect((await SELF.fetch("https://api.example.com/segments")).status).toBe(401);
    expect((await SELF.fetch("https://unknown.example.com/unsubscribe/domain-unsubscribe-token")).status).toBe(404);
  });
});

async function accessToken(audience: string, expiration: string | number): Promise<string> {
  return new SignJWT({ email: "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "access-test" })
    .setIssuer("https://example.cloudflareaccess.com")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(accessPrivateKey);
}
