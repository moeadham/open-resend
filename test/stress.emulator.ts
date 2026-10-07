import { applyD1Migrations, createExecutionContext, createMessageBatch, env, getQueueResult, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { enqueueBroadcast, processBroadcastQueueMessage } from "../src/delivery";
import type { BroadcastQueueMessage, DeliveryQueueMessage } from "../src/types";
import worker from "../src/index";

const CONTACT_COUNT = 50_000;
const NOW = "2026-10-07T00:00:00.000Z";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO segments (id,name,created_at,updated_at) VALUES ('stress-segment','50k stress audience',?,?)").bind(NOW, NOW),
    env.DB.prepare("INSERT INTO domains (id,name,created_at) VALUES ('stress-domain','example.com',?)").bind(NOW),
    env.DB.prepare("INSERT INTO senders (id,domain_id,email,name,postal_address,active,created_at,updated_at) VALUES ('stress-sender','stress-domain','stress@example.com','Stress sender','1 Emulator Way',1,?,?)").bind(NOW, NOW),
    env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,text,status,created_at,updated_at) VALUES ('stress-broadcast','50k queue stress','stress-segment','stress-sender','Stress sender <stress@example.com>','Emulator stress test','<p>Local only</p>','Local only','draft',?,?)").bind(NOW, NOW),
  ]);
  await env.DB.prepare(
    `WITH RECURSIVE counter(n) AS (
       VALUES(1) UNION ALL SELECT n + 1 FROM counter WHERE n < ?
     )
     INSERT INTO contacts (id,email,created_at,updated_at)
     SELECT printf('stress-contact-%05d',n),printf('stress-%05d@example.test',n),?,? FROM counter`,
  ).bind(CONTACT_COUNT, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO segment_contacts (segment_id,contact_id,status,subscribed_at,updated_at)
     SELECT 'stress-segment',id,'subscribed',?,? FROM contacts`,
  ).bind(NOW, NOW).run();
});

describe("50,000-contact emulator stress test", () => {
  it("keeps admin audience pagination bounded and correct", async () => {
    const firstHtml = await fetchAdminHtml("/audience");
    const secondHtml = await fetchAdminHtml("/audience?page=2");
    const lastHtml = await fetchAdminHtml("/audience?page=1250");
    const filteredHtml = await fetchAdminHtml("/audience?search=stress-25000%40example.test");

    const firstIds = contactIds(firstHtml);
    const secondIds = contactIds(secondHtml);
    const lastIds = contactIds(lastHtml);
    expect(firstIds).toHaveLength(40);
    expect(secondIds).toHaveLength(40);
    expect(lastIds).toHaveLength(40);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(80);
    expect(firstHtml).toContain("Page 1 · 50000 contacts · 40 items");
    expect(firstHtml).not.toContain(">Newer</a>");
    expect(firstHtml).toContain(">Older</a>");
    expect(secondHtml).toContain(">Newer</a>");
    expect(secondHtml).toContain(">Older</a>");
    expect(lastHtml).toContain("Page 1250 · 50000 contacts · 40 items");
    expect(lastHtml).toContain(">Newer</a>");
    expect(lastHtml).not.toContain(">Older</a>");
    expect(lastIds).toContain("stress-contact-00001");
    expect(contactIds(filteredHtml)).toEqual(["stress-contact-25000"]);
    expect(filteredHtml).toContain("Page 1 · 1 contacts · 40 items");

    const broadcastHtml = await fetchAdminHtml("/broadcasts/stress-broadcast");
    expect(broadcastHtml).toContain("50,000 eligible recipients");
  });

  it("fans all recipients out through bounded queue jobs", async () => {
    const fanoutJobs: BroadcastQueueMessage[] = [];
    const deliveryIds: string[] = [];
    const batchSizes: number[] = [];
    const queue = {
      async send(body: BroadcastQueueMessage | DeliveryQueueMessage) {
        capture(body);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
      async sendBatch(messages: Iterable<{ body: BroadcastQueueMessage | DeliveryQueueMessage }>) {
        const items = [...messages];
        batchSizes.push(items.length);
        for (const item of items) capture(item.body);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    } as unknown as Queue;
    const stressEnv = new Proxy(env as Env, {
      get(target, property, receiver) {
        return property === "DELIVERY_QUEUE" ? queue : Reflect.get(target, property, receiver);
      },
    });

    function capture(body: BroadcastQueueMessage | DeliveryQueueMessage): void {
      if ("broadcastId" in body) fanoutJobs.push(body);
      else deliveryIds.push(body.deliveryId);
    }

    expect(await enqueueBroadcast(stressEnv, "stress-broadcast")).toBe(CONTACT_COUNT);
    expect(fanoutJobs).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM deliveries").first<{ count: number }>())?.count).toBe(0);

    const late = new Date(new Date(fanoutJobs[0]!.queuedAt).getTime() + 1).toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id,email,created_at,updated_at) VALUES ('stress-contact-late','late@example.test',?,?)").bind(late, late),
      env.DB.prepare("INSERT INTO segment_contacts (segment_id,contact_id,status,subscribed_at,updated_at) VALUES ('stress-segment','stress-contact-late','subscribed',?,?)").bind(late, late),
    ]);

    let jobCount = 0;
    while (fanoutJobs.length > 0) {
      const body = fanoutJobs.shift()!;
      let acked = false;
      await processBroadcastQueueMessage({
        body,
        ack: () => { acked = true; },
        retry: () => { throw new Error("Fan-out job unexpectedly retried"); },
      } as unknown as Message<BroadcastQueueMessage>, stressEnv);
      expect(acked).toBe(true);
      jobCount += 1;
      if (jobCount > 2_000) throw new Error("Fan-out continuation did not terminate");
    }

    expect(deliveryIds).toHaveLength(CONTACT_COUNT);
    expect(new Set(deliveryIds).size).toBe(CONTACT_COUNT);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(100);
    expect(batchSizes.every((size) => size > 0)).toBe(true);
    const counts = await env.DB.prepare("SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status")
      .all<{ status: string; count: number }>();
    expect(counts.results).toEqual([{ status: "enqueued", count: CONTACT_COUNT }]);
    expect((await env.DB.prepare("SELECT status FROM broadcasts WHERE id='stress-broadcast'").first<{ status: string }>())?.status).toBe("queued");
  });

  it("routes a coordinator through the configured emulator Queue binding", async () => {
    await env.DB.prepare("INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,text,status,created_at,updated_at) VALUES ('stress-binding-broadcast','Queue binding stress','stress-segment','stress-sender','Stress sender <stress@example.com>','Queue binding','<p>Local only</p>','Local only','draft',?,?)")
      .bind(NOW, NOW).run();
    expect(await enqueueBroadcast(env, "stress-binding-broadcast")).toBe(CONTACT_COUNT);
    const queued = await env.DB.prepare("SELECT updated_at FROM broadcasts WHERE id='stress-binding-broadcast'")
      .first<{ updated_at: string }>();
    const body: BroadcastQueueMessage = {
      type: "broadcast_fanout",
      broadcastId: "stress-binding-broadcast",
      createDeliveries: true,
      queuedAt: queued!.updated_at,
    };
    const batch = createMessageBatch<BroadcastQueueMessage>("cloudflare-resend-deliveries", [{
      id: "stress-coordinator",
      timestamp: new Date(),
      attempts: 1,
      body,
    }]);
    const context = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, context);
    expect(result.outcome).toBe("ok");
    expect(result.explicitAcks).toContain("stress-coordinator");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE broadcast_id='stress-binding-broadcast'").first<{ count: number }>())?.count).toBe(1_000);
  });
});

async function fetchAdminHtml(path: string): Promise<string> {
  const response = await SELF.fetch(`http://localhost${path}`);
  expect(response.status).toBe(200);
  return response.text();
}

function contactIds(html: string): string[] {
  return [...html.matchAll(/data-row-href="\/contacts\/([^"]+)"/g)].map((match) => match[1]!);
}
