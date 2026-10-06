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
    env.DB.prepare("DELETE FROM segment_contacts"),
    env.DB.prepare("DELETE FROM contacts"),
    env.DB.prepare("DELETE FROM senders"),
    env.DB.prepare("DELETE FROM domains"),
    env.DB.prepare("DELETE FROM segments"),
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

  it("provides contact detail and segment membership actions in the admin", async () => {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES ('contact-admin','person@example.net',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('segment-admin','Updates',?,?)").bind(now, now),
    ]);
    const token = await accessToken("replace-with-access-application-aud", "5 minutes");
    const authHeaders = { "Cf-Access-Jwt-Assertion": token };
    const detail = await SELF.fetch("https://admin.example.com/contacts/contact-admin", { headers: authHeaders });
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("Contact details");
    expect(detailHtml).toContain("Add or resubscribe");

    const added = await SELF.fetch("https://admin.example.com/contacts/contact-admin/segments", {
      method: "POST",
      redirect: "manual",
      headers: { ...authHeaders, Origin: "https://admin.example.com" },
      body: new URLSearchParams({ segment_id: "segment-admin" }),
    });
    expect(added.status).toBe(303);
    expect((await env.DB.prepare("SELECT status FROM segment_contacts WHERE contact_id='contact-admin' AND segment_id='segment-admin'").first<{ status: string }>())?.status).toBe("subscribed");

    const unsubscribed = await SELF.fetch("https://admin.example.com/contacts/contact-admin/segments/segment-admin", {
      method: "POST",
      redirect: "manual",
      headers: { ...authHeaders, Origin: "https://admin.example.com" },
      body: new URLSearchParams({ status: "unsubscribed" }),
    });
    expect(unsubscribed.status).toBe(303);
    expect((await env.DB.prepare("SELECT status FROM segment_contacts WHERE contact_id='contact-admin' AND segment_id='segment-admin'").first<{ status: string }>())?.status).toBe("unsubscribed");
  });

  it("shows an explicit send action when reviewing a draft broadcast", async () => {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('domain-admin','example.com',?)").bind(now),
      env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,active,created_at,updated_at) VALUES ('sender-admin','domain-admin','news@example.com','Example News','1 Main Street',1,?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('segment-broadcast','Readers',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,text,status,created_at,updated_at) VALUES ('broadcast-admin','Draft update','segment-broadcast','sender-admin','Example News <news@example.com>','Hello','<p>Hello</p>','Hello','draft',?,?)").bind(now, now),
    ]);
    const token = await accessToken("replace-with-access-application-aud", "5 minutes");
    const response = await SELF.fetch("https://admin.example.com/broadcasts/broadcast-admin", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Send now");
    expect(html).toContain("Edit");
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

  it("supports contacts, segment membership, and broadcasts through the SDK", async () => {
    const resend = new Resend(API_KEY, { baseUrl: "https://api.example.com" });
    const segment = await resend.segments.create({ name: "Product updates" });
    const segmentId = segment.data?.id;
    expect(segmentId).toBeTruthy();

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
    expect(loaded.data).toMatchObject({ name: "October update", status: "draft", segment_id: segmentId });
  });

  it("keeps browser GET unsubscribe requests non-mutating", async () => {
    const now = nowIso();
    const token = "unsubscribe-token";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO segments (id, name, created_at, updated_at) VALUES ('s1', 'News', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('c1', 'person@example.net', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO segment_contacts (segment_id, contact_id, status, subscribed_at, updated_at) VALUES ('s1', 'c1', 'subscribed', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO unsubscribe_tokens (token_hash, segment_id, contact_id, created_at) VALUES (?, 's1', 'c1', ?)").bind(await sha256(token), now),
    ]);

    const page = await SELF.fetch(`https://api.example.com/unsubscribe/${token}`);
    expect(page.status).toBe(200);
    const before = await env.DB.prepare("SELECT status FROM segment_contacts WHERE segment_id = 's1' AND contact_id = 'c1'").first<{ status: string }>();
    expect(before?.status).toBe("subscribed");

    const posted = await SELF.fetch(`https://api.example.com/unsubscribe/${token}`, { method: "POST", body: "List-Unsubscribe=One-Click" });
    expect(posted.status).toBe(200);
    const after = await env.DB.prepare("SELECT status FROM segment_contacts WHERE segment_id = 's1' AND contact_id = 'c1'").first<{ status: string }>();
    expect(after?.status).toBe("unsubscribed");
  });

  it("serves unsubscribe links on a configured sender-domain hostname only", async () => {
    const now = nowIso();
    const token = "domain-unsubscribe-token";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO segments (id, name, created_at, updated_at) VALUES ('s2', 'Other news', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('c2', 'other@example.net', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO segment_contacts (segment_id, contact_id, status, subscribed_at, updated_at) VALUES ('s2', 'c2', 'subscribed', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO unsubscribe_tokens (token_hash, segment_id, contact_id, created_at) VALUES (?, 's2', 'c2', ?)").bind(await sha256(token), now),
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
