import { applyD1Migrations, createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { QueueBody } from "../src/types";

const NOW = "2026-10-14T00:00:00.000Z";
const names = { DELIVERY_QUEUE_NAME: "open-resend-deliveries", EMAIL_EVENTS_QUEUE_NAME: "open-resend-email-events", DEAD_LETTER_QUEUE_NAME: "open-resend-deliveries-dlq" };
const deploymentEnv = new Proxy(env, {
  get(target, property, receiver) { return property in names ? names[property as keyof typeof names] : Reflect.get(target, property, receiver); },
});

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('queue-domain','example.com',?)").bind(NOW),
    env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,created_at,updated_at) VALUES ('queue-sender','queue-domain','news@example.com','News','1 Main Street',?,?)").bind(NOW, NOW),
    env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('queue-segment','Queue tests',?,?)").bind(NOW, NOW),
    env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES ('queue-contact','reader@example.net',?,?)").bind(NOW, NOW),
    env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,status,created_at,updated_at) VALUES ('queue-broadcast','Queue tests','queue-segment','queue-sender','news@example.com','Hello','<p>Hello</p>','queued',?,?)").bind(NOW, NOW),
    env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,contact_id,recipient,status,message_id,created_at,updated_at) VALUES ('queue-delivery','queue-broadcast','queue-contact','reader@example.net','accepted','queue-message',?,?)").bind(NOW, NOW),
  ]);
});

async function dispatch(queue: string, body: QueueBody, bindings = deploymentEnv) {
  const batch = createMessageBatch<QueueBody>(queue, [{ id: "test-job", timestamp: new Date(), attempts: 1, body }]);
  const context = createExecutionContext();
  await worker.queue(batch, bindings);
  return getQueueResult(batch, context);
}

describe("deployment-configured queue routing", () => {
  it.each(["delivered", "bounced", "complained"])("handles %s events on the deployed queue name", async (status) => {
    const result = await dispatch(names.EMAIL_EVENTS_QUEUE_NAME, {
      type: `message.${status}`, payload: { eventId: "queue-event", messageId: "queue-message", bounce: { type: "hard", reason: "Test bounce" } },
    });
    expect(result.explicitAcks).toContain("test-job");
    expect(await env.DB.prepare("SELECT status FROM deliveries WHERE id='queue-delivery'").first("status")).toBe(status);
    expect(await env.DB.prepare("SELECT suppression_reason FROM contacts WHERE id='queue-contact'").first("suppression_reason")).toBe(status === "delivered" ? null : status);
  });

  it("marks exhausted delivery retries failed without sending again", async () => {
    await env.DB.prepare("UPDATE deliveries SET status='deferred' WHERE id='queue-delivery'").run();
    const result = await dispatch(names.DEAD_LETTER_QUEUE_NAME, { deliveryId: "queue-delivery" });
    expect(result.explicitAcks).toContain("test-job");
    expect(await env.DB.prepare("SELECT status,last_error FROM deliveries WHERE id='queue-delivery'").first()).toEqual({ status: "failed", last_error: "Queue retries exhausted" });
  });

  it("marks exhausted coordinator retries failed instead of resuming fan-out", async () => {
    await env.DB.prepare("UPDATE broadcasts SET status='queueing' WHERE id='queue-broadcast'").run();
    const result = await dispatch(names.DEAD_LETTER_QUEUE_NAME, { type: "broadcast_fanout", broadcastId: "queue-broadcast", createDeliveries: true, queuedAt: NOW });
    expect(result.explicitAcks).toContain("test-job");
    expect(await env.DB.prepare("SELECT status FROM broadcasts WHERE id='queue-broadcast'").first("status")).toBe("failed");
  });

  it("still routes delivery messages on a custom delivery queue", async () => {
    const result = await dispatch(names.DELIVERY_QUEUE_NAME, { deliveryId: "queue-delivery" });
    expect(result.explicitAcks).toContain("test-job");
    expect(await env.DB.prepare("SELECT status FROM deliveries WHERE id='queue-delivery'").first("status")).toBe("accepted");
  });

  it("still routes coordinator messages on a custom delivery queue", async () => {
    const result = await dispatch(names.DELIVERY_QUEUE_NAME, { type: "broadcast_fanout", broadcastId: "queue-broadcast", createDeliveries: true, queuedAt: NOW });
    expect(result.explicitAcks).toContain("test-job");
    expect(await env.DB.prepare("SELECT status FROM broadcasts WHERE id='queue-broadcast'").first("status")).toBe("queued");
  });

  it("rejects an unknown queue rather than silently acknowledging its messages", async () => {
    await expect(dispatch("wrong-events-queue", { type: "message.delivered", payload: { eventId: "unknown-event", messageId: "queue-message" } })).rejects.toThrow("unconfigured queue");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM email_events").first("count")).toBe(0);
  });
});
