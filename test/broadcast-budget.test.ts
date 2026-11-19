import { applyD1Migrations, createMessageBatch, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BROADCAST_BUDGET_WINDOW_MS,
  DEFAULT_BROADCAST_DAILY_LIMIT,
  getBroadcastBudget,
  getBroadcastDailyLimit,
  parseBroadcastDailyLimit,
  reserveBroadcastSends,
  setBroadcastDailyLimit,
} from "../src/broadcast-budget";
import { processBroadcastQueueMessage } from "../src/delivery";
import type { BroadcastQueueMessage, DeliveryQueueMessage } from "../src/types";

const now = "2026-11-19T00:00:00.000Z";
const start = Date.parse("2026-11-19T10:00:00.000Z");

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("broadcast send budget", () => {
  it("defaults to 50,000 per 24 hours and validates the setting", async () => {
    expect(DEFAULT_BROADCAST_DAILY_LIMIT).toBe(50_000);
    expect(await getBroadcastDailyLimit(env.DB)).toBe(50_000);
    await setBroadcastDailyLimit(env.DB, parseBroadcastDailyLimit("1,500"));
    expect(await getBroadcastDailyLimit(env.DB)).toBe(1_500);
    for (const invalid of ["0", "-5", "2.5", "abc", "", "10000001"]) expect(() => parseBroadcastDailyLimit(invalid)).toThrow();
  });

  it("grants up to the limit, then nothing until 24 hours after the first send", async () => {
    expect((await getBroadcastBudget(env.DB, start)).resetsAt).toBeNull();
    expect((await reserveBroadcastSends(env.DB, 99, 150, start)).granted).toBe(99);
    const partial = await reserveBroadcastSends(env.DB, 99, 150, start + 60_000);
    expect(partial.granted).toBe(51);
    expect(partial.budget).toMatchObject({ used: 150, exhausted: true, resetsAt: new Date(start + BROADCAST_BUDGET_WINDOW_MS).toISOString() });
    expect((await reserveBroadcastSends(env.DB, 99, 150, start + BROADCAST_BUDGET_WINDOW_MS - 1)).granted).toBe(0);

    // The next send after the window ends opens a new window starting at that send.
    const later = start + BROADCAST_BUDGET_WINDOW_MS + 3 * 60 * 60 * 1000;
    const renewed = await reserveBroadcastSends(env.DB, 99, 150, later);
    expect(renewed.granted).toBe(99);
    expect(renewed.budget.resetsAt).toBe(new Date(later + BROADCAST_BUDGET_WINDOW_MS).toISOString());
  });

  it("never overshoots the limit under concurrent reservations", async () => {
    const grants = await Promise.all(Array.from({ length: 10 }, () => reserveBroadcastSends(env.DB, 99, 500, start)));
    expect(grants.reduce((sum, { granted }) => sum + granted, 0)).toBe(500);
    expect((await getBroadcastBudget(env.DB, start)).used).toBe(500);
  });

  it("applies a lowered limit immediately to the current window", async () => {
    await reserveBroadcastSends(env.DB, 400, 1_000, start);
    expect((await reserveBroadcastSends(env.DB, 99, 300, start + 1)).granted).toBe(0);
  });
});

describe("broadcast fan-out pacing", () => {
  type Sent = { batch: DeliveryQueueMessage[]; single: { body: BroadcastQueueMessage; delaySeconds?: number }[] };

  async function seedBroadcast(id: string, recipients: number, queuedAt: string): Promise<void> {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO domains (id,name,created_at) VALUES ('bb-domain','example.com',?)").bind(now),
      env.DB.prepare("INSERT OR IGNORE INTO senders (id,domain_id,email,name,postal_address,created_at,updated_at) VALUES ('bb-sender','bb-domain','news@example.com','News','1 Main Street',?,?)").bind(now, now),
      env.DB.prepare("INSERT OR IGNORE INTO segments (id,name,created_at,updated_at) VALUES ('bb-segment','Readers',?,?)").bind(now, now),
      env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,status,queued_at,created_at,updated_at) VALUES (?,?,'bb-segment','bb-sender','news@example.com','News','<p>Hi</p>','queueing',?,?,?)").bind(id, id, queuedAt, now, now),
      ...Array.from({ length: recipients }, (_, i) => env.DB.prepare("INSERT INTO deliveries (id,broadcast_id,contact_id,recipient,status,attempts,created_at,updated_at) VALUES (?,?,NULL,?,'pending',0,?,?)")
        .bind(`${id}:${String(i).padStart(3, "0")}`, id, `${id}-${i}@example.net`, now, now)),
    ]);
  }

  async function runCoordinator(broadcastId: string): Promise<Sent> {
    const sent: Sent = { batch: [], single: [] };
    const queue = {
      sendBatch: async (messages: { body: DeliveryQueueMessage | BroadcastQueueMessage }[]) => {
        for (const { body } of messages) if ("deliveryId" in body) sent.batch.push(body);
      },
      send: async (body: BroadcastQueueMessage, options?: { delaySeconds?: number }) => { sent.single.push({ body, delaySeconds: options?.delaySeconds }); },
    };
    const queueEnv = new Proxy(env, { get: (target, key, receiver) => key === "DELIVERY_QUEUE" ? queue : Reflect.get(target, key, receiver) });
    const job: BroadcastQueueMessage = { type: "broadcast_fanout", broadcastId, createDeliveries: false, queuedAt: now };
    const batch = createMessageBatch<BroadcastQueueMessage>("open-resend-deliveries", [{ id: "job", timestamp: new Date(), attempts: 1, body: job }]);
    await processBroadcastQueueMessage(batch.messages[0]!, queueEnv);
    return sent;
  }

  const countStatus = (broadcastId: string, status: string) =>
    env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE broadcast_id = ? AND status = ?").bind(broadcastId, status).first<number>("n");

  it("enqueues only what the 24-hour budget allows and waits for the reset", async () => {
    await setBroadcastDailyLimit(env.DB, 3);
    await seedBroadcast("first", 5, "2026-11-19T00:00:01.000Z");

    const opened = await runCoordinator("first");
    expect(opened.batch).toHaveLength(3);
    expect(await countStatus("first", "enqueued")).toBe(3);
    expect(await countStatus("first", "pending")).toBe(2);

    const blocked = await runCoordinator("first");
    expect(blocked.batch).toHaveLength(0);
    expect(blocked.single).toHaveLength(1);
    // Waits for the budget reset, capped at the 12-hour Queues delay maximum.
    expect(blocked.single[0]!.delaySeconds).toBe(12 * 60 * 60);
    expect(await countStatus("first", "pending")).toBe(2);
    expect((await env.DB.prepare("SELECT status FROM broadcasts WHERE id='first'").first("status"))).toBe("queueing");
  });

  it("serves broadcasts first come, first served", async () => {
    await seedBroadcast("older", 2, "2026-11-19T00:00:01.000Z");
    await seedBroadcast("newer", 2, "2026-11-19T00:00:02.000Z");

    const waiting = await runCoordinator("newer");
    expect(waiting.batch).toHaveLength(0);
    expect(waiting.single[0]!.delaySeconds).toBe(30);
    expect(await countStatus("newer", "pending")).toBe(2);

    expect((await runCoordinator("older")).batch).toHaveLength(2);
    expect((await runCoordinator("newer")).batch).toHaveLength(2);
  });
});
