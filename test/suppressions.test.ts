import { applyD1Migrations, createMessageBatch, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin";
import { processEmailEvent } from "../src/delivery";
import { addManualSuppression, getSuppressionForEmail, recordSuppression } from "../src/suppressions";
import type { EmailEventMessage } from "../src/types";

const now = "2026-11-20T00:00:00.000Z";
const local = { ...env, ENVIRONMENT: "development", ALLOW_LOCAL_ADMIN: "true" };
let eventCounter = 0;

const contactFlag = (email: string) =>
  env.DB.prepare("SELECT suppression_reason FROM contacts WHERE email = ?").bind(email).first<string | null>("suppression_reason");
const addContact = (id: string, email: string) =>
  env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES (?,?,?,?)").bind(id, email, now, now).run();

async function providerEvent(status: string, payload: Partial<EmailEventMessage["payload"]>): Promise<void> {
  const body: EmailEventMessage = {
    type: `cf.email.sending.message.${status}`,
    payload: { eventId: `suppression-event-${++eventCounter}`, terminal: status !== "deferred", delivery: { status }, ...payload },
  };
  const batch = createMessageBatch<EmailEventMessage>("open-resend-email-events", [{ id: body.payload.eventId, timestamp: new Date(), attempts: 1, body }]);
  await processEmailEvent(batch.messages[0]!, env);
}

describe("migration backfill", () => {
  it("copies contacts that were already suppressed, with their latest bounce reason", async () => {
    const before = env.TEST_MIGRATIONS.filter((migration) => migration.name < "0011");
    await applyD1Migrations(env.DB, before);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,email,suppression_reason,created_at,updated_at) VALUES ('old-bounce','old@example.net','bounced',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO contacts (id,email,suppression_reason,created_at,updated_at) VALUES ('old-complaint','spam@example.net','complained',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('bf-domain','example.com',?)").bind(now),
      env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,created_at,updated_at) VALUES ('bf-sender','bf-domain','news@example.com','News','1 Main St',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('bf-segment','Readers',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,status,created_at,updated_at) VALUES ('bf','bf','bf-segment','bf-sender','news@example.com','News','<p>Hi</p>','sent',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,contact_id,recipient,status,attempts,last_error,created_at,updated_at) VALUES ('bf:old','bf','old-bounce','old@example.net','bounced',1,'550 5.1.1 No such user',?,?)").bind(now, now),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const bounce = await getSuppressionForEmail(env.DB, "old@example.net");
    expect(bounce).toMatchObject({ origin: "bounce", details: "550 5.1.1 No such user" });
    expect((await getSuppressionForEmail(env.DB, "spam@example.net"))?.origin).toBe("complaint");
    expect(await contactFlag("old@example.net")).toBe("bounced");
  });
});

describe("suppression list", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it("records hard bounces and complaints from broadcasts, but not soft bounces", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('sp-domain','example.com',?)").bind(now),
      env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,created_at,updated_at) VALUES ('sp-sender','sp-domain','news@example.com','News','1 Main St',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('sp-segment','Readers',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,status,created_at,updated_at) VALUES ('sp','sp','sp-segment','sp-sender','news@example.com','News','<p>Hi</p>','sending',?,?)").bind(now, now),
    ]);
    for (const [id, email] of [["hard", "hard@example.net"], ["soft", "soft@example.net"], ["spam", "spam@example.net"]] as const) {
      await addContact(id, email);
      await env.DB.prepare("INSERT INTO segment_contacts (segment_id,contact_id,status,subscribed_at,updated_at) VALUES ('sp-segment',?,'subscribed',?,?)").bind(id, now, now).run();
      await env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,contact_id,recipient,status,attempts,message_id,created_at,updated_at) VALUES (?,'sp',?,?,'accepted',1,?,?,?)").bind(`sp:${id}`, id, email, `msg-${id}`, now, now).run();
    }

    await providerEvent("bounced", { messageId: "msg-hard", bounce: { type: "hard", reason: "550 5.1.1 No such user" } });
    await providerEvent("bounced", { messageId: "msg-soft", bounce: { type: "soft", reason: "452 4.2.2 Mailbox full" } });
    await providerEvent("complained", { messageId: "msg-spam" });

    expect(await getSuppressionForEmail(env.DB, "hard@example.net")).toMatchObject({ origin: "bounce", details: "550 5.1.1 No such user" });
    expect(await getSuppressionForEmail(env.DB, "soft@example.net")).toBeNull();
    expect((await getSuppressionForEmail(env.DB, "spam@example.net"))?.origin).toBe("complaint");
    expect(await contactFlag("hard@example.net")).toBe("bounced");
    expect(await contactFlag("soft@example.net")).toBeNull();
    expect(await contactFlag("spam@example.net")).toBe("complained");
    // Contacts keep their segment membership, as in Resend.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM segment_contacts WHERE segment_id='sp-segment' AND status='subscribed'").first<number>("n")).toBe(3);
  });

  it("records a transactional hard bounce from the event recipient and flags a matching contact", async () => {
    await addContact("tx", "tx@example.net");
    await providerEvent("bounced", { messageId: "transactional-provider-id", recipient: "Tx User <TX@example.net>", bounce: { type: "hard", reason: "550 unknown user" } });
    expect((await getSuppressionForEmail(env.DB, "tx@example.net"))?.origin).toBe("bounce");
    expect(await contactFlag("tx@example.net")).toBe("bounced");
  });

  it("applies the list to contacts created or renamed later, and clears it when removed", async () => {
    await recordSuppression(env.DB, "later@example.net", "bounce", "550");
    await addContact("later", "later@example.net");
    expect(await contactFlag("later@example.net")).toBe("bounced");

    await addContact("renamed", "clean@example.net");
    await env.DB.prepare("UPDATE contacts SET email='later2@example.net' WHERE id='renamed'").run();
    expect(await contactFlag("later2@example.net")).toBeNull();
    await recordSuppression(env.DB, "later2@example.net", "complaint", null);
    expect(await contactFlag("later2@example.net")).toBe("complained");
    await env.DB.prepare("UPDATE contacts SET email='clean@example.net' WHERE id='renamed'").run();
    expect(await contactFlag("clean@example.net")).toBeNull();

    await env.DB.prepare("DELETE FROM suppressions WHERE email = 'later@example.net'").run();
    expect(await contactFlag("later@example.net")).toBeNull();
  });

  it("re-suppresses an address that bounces again, keeping its original date", async () => {
    await recordSuppression(env.DB, "again@example.net", "bounce", "first");
    const first = await getSuppressionForEmail(env.DB, "again@example.net");
    await recordSuppression(env.DB, "again@example.net", "complaint", "second");
    const second = await getSuppressionForEmail(env.DB, "again@example.net");
    expect(second).toMatchObject({ id: first!.id, created_at: first!.created_at, origin: "complaint", details: "second" });
  });

  it("rejects invalid and duplicate manual additions", async () => {
    await expect(addManualSuppression(env.DB, "not-an-email")).rejects.toThrow("valid email");
    await addManualSuppression(env.DB, " Someone@Example.net ");
    expect((await getSuppressionForEmail(env.DB, "someone@example.net"))?.origin).toBe("manual");
    await expect(addManualSuppression(env.DB, "someone@example.net")).rejects.toThrow("already on the suppression list");
  });

  it("lists, adds, shows, and removes suppressions in the dashboard", async () => {
    await addContact("dash", "dash@example.net");
    const post = (path: string, body: Record<string, string>) => adminApp.request(`http://localhost${path}`, {
      method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body),
    }, local);

    const added = await post("/emails/suppressions", { email: "dash@example.net" });
    expect(added.status).toBe(303);
    const detailPath = added.headers.get("Location")!;
    expect(detailPath).toMatch(/^\/emails\/suppressions\/[\w-]+$/);
    expect(await contactFlag("dash@example.net")).toBe("manual");

    const list = await (await adminApp.request("http://localhost/emails/suppressions?origin=manual", {}, local)).text();
    expect(list).toContain("dash@example.net");
    expect(list).toContain("1 suppression");
    const detail = await (await adminApp.request(`http://localhost${detailPath}`, {}, local)).text();
    expect(detail).toContain("Manual");
    expect(detail).toContain("/contacts/dash");
    const contactPage = await (await adminApp.request("http://localhost/contacts/dash", {}, local)).text();
    expect(contactPage).toContain("On the suppression list (Manual)");
    expect(contactPage).not.toContain('class="panel error"');

    expect((await post(`${detailPath}/delete`, {})).status).toBe(303);
    expect(await getSuppressionForEmail(env.DB, "dash@example.net")).toBeNull();
    expect(await contactFlag("dash@example.net")).toBeNull();
    expect((await adminApp.request(`http://localhost${detailPath}`, {}, local)).status).toBe(404);
  });
});
