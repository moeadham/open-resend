import { applyD1Migrations, createMessageBatch, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { processEmailEvent } from "../src/delivery";
import type { EmailEventMessage } from "../src/types";

const now = "2026-11-12T02:00:00.000Z";
let eventCounter = 0;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('bc-domain','example.com',?)").bind(now),
    env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,created_at,updated_at) VALUES ('bc-sender','bc-domain','news@example.com','News','1 Main Street',?,?)").bind(now, now),
    env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('bc-segment','Readers',?,?)").bind(now, now),
    env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,status,created_at,updated_at) VALUES ('bc','Update','bc-segment','bc-sender','news@example.com','News','<p>Hi</p>','sending',?,?)").bind(now, now),
    ...["one", "two"].map(id => env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES (?,?,?,?)").bind(id, `${id}@example.net`, now, now)),
    env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,contact_id,recipient,status,attempts,message_id,created_at,updated_at) VALUES ('bc:one','bc','one','one@example.net','delivered',1,'msg-one',?,?)").bind(now, now),
    env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,contact_id,recipient,status,attempts,message_id,created_at,updated_at) VALUES ('bc:two','bc','two','two@example.net','accepted',1,'msg-two',?,?)").bind(now, now),
  ]);
});

async function deliverEvent(messageId: string, status: string, extra: Partial<EmailEventMessage["payload"]> = {}): Promise<void> {
  const body: EmailEventMessage = {
    type: `cf.email.sending.message.${status}`,
    payload: { eventId: `event-${++eventCounter}`, messageId, terminal: status !== "deferred", delivery: { status }, ...extra },
  };
  const batch = createMessageBatch<EmailEventMessage>("open-resend-email-events", [{ id: body.payload.eventId, timestamp: new Date(), attempts: 1, body }]);
  await processEmailEvent(batch.messages[0]!, env);
}

const broadcastStatus = () => env.DB.prepare("SELECT status, sent_at FROM broadcasts WHERE id='bc'").first<{ status: string; sent_at: string | null }>();
const deliveryStatus = (id: string) => env.DB.prepare("SELECT status, last_error FROM deliveries WHERE id=?").bind(id).first<{ status: string; last_error: string | null }>();

describe("broadcast completion with provider events", () => {
  it("completes a broadcast when the provider is still retrying an accepted message", async () => {
    await deliverEvent("msg-two", "deferred", { delivery: { status: "deferred", smtpResponse: "452 4.2.2 Inbox out of storage space" } });
    expect(await deliveryStatus("bc:two")).toEqual({ status: "deferred", last_error: "452 4.2.2 Inbox out of storage space" });
    const broadcast = await broadcastStatus();
    expect(broadcast?.status).toBe("sent");
    expect(broadcast?.sent_at).toBeTruthy();
  });

  it("completes a broadcast when the final provider event arrives", async () => {
    await deliverEvent("msg-two", "delivered");
    expect((await deliveryStatus("bc:two"))?.status).toBe("delivered");
    expect((await broadcastStatus())?.status).toBe("sent");
  });

  it("keeps a broadcast open while a delivery is deferred before the provider accepted it", async () => {
    await env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES ('three','three@example.net',?,?)").bind(now, now).run();
    await env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,contact_id,recipient,status,attempts,last_error,created_at,updated_at) VALUES ('bc:three','bc','three','three@example.net','deferred',1,'E_INTERNAL_SERVER_ERROR: retry',?,?)").bind(now, now).run();
    await deliverEvent("msg-two", "delivered");
    expect((await broadcastStatus())?.status).toBe("sending");
  });

  it("does not let a late deferred event undo a final outcome", async () => {
    await deliverEvent("msg-one", "deferred");
    expect((await deliveryStatus("bc:one"))?.status).toBe("delivered");
    await deliverEvent("msg-two", "bounced", { bounce: { type: "hard", reason: "550 No such user" } });
    await deliverEvent("msg-two", "delivered");
    expect(await deliveryStatus("bc:two")).toEqual({ status: "bounced", last_error: "550 No such user" });
  });

  it("still records a bounce or complaint that follows a delivery", async () => {
    await deliverEvent("msg-one", "complained");
    expect((await deliveryStatus("bc:one"))?.status).toBe("complained");
    expect(await env.DB.prepare("SELECT suppression_reason FROM contacts WHERE id='one'").first("suppression_reason")).toBe("complained");
  });
});
