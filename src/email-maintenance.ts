import { nowIso } from "./lib";
import { objectKey } from "./transactional-storage";
import { publishWebhookOutbox } from "./webhooks";
import type { EmailEventMessage } from "./types";
import {
  updateTransactionalStatus,
  applyTransactionalProviderEvent,
} from "./outgoing-email";

export async function maintainEmail(env: Env): Promise<void> {
  const providerEvents = await env.DB.prepare(
    `SELECT DISTINCT e.payload_json FROM email_events e JOIN transactional_recipients r ON r.provider_id=e.message_id WHERE e.transactional_processed=0 AND e.payload_json IS NOT NULL LIMIT 50`,
  ).all<{ payload_json: string }>();
  for (const event of providerEvents.results)
    await applyTransactionalProviderEvent(
      env,
      JSON.parse(event.payload_json) as EmailEventMessage,
    );
  await env.DB.prepare(
    "UPDATE email_events SET payload_json=NULL WHERE received_at<? AND payload_json IS NOT NULL",
  )
    .bind(new Date(Date.now() - 30 * 86400_000).toISOString())
    .run();
  try {
    await publishWebhookOutbox(env);
  } catch (error) {
    console.error(
      "Webhook outbox recovery deferred",
      error instanceof Error ? error.message : "queue unavailable",
    );
  }
  const pending = await env.DB.prepare(
    `SELECT DISTINCT r.email_id AS id FROM transactional_recipients r JOIN transactional_emails e ON e.id=r.email_id WHERE r.status='pending' AND e.expires_at>? LIMIT 50`,
  )
    .bind(nowIso())
    .all<{ id: string }>();
  if (pending.results.length) {
    try {
      await env.DELIVERY_QUEUE.sendBatch(
        pending.results.map((r) => ({ body: { transactionalId: r.id } })),
      );
    } catch (error) {
      console.error(
        "Transactional recovery deferred",
        error instanceof Error ? error.message : "queue unavailable",
      );
    }
  }
  const stale = await env.DB.prepare(
    "SELECT DISTINCT email_id FROM transactional_recipients WHERE status='sending' AND updated_at<?",
  )
    .bind(new Date(Date.now() - 15 * 60_000).toISOString())
    .all<{ email_id: string }>();
  for (const { email_id } of stale.results) {
    await env.DB.prepare(
      "UPDATE transactional_recipients SET status='failed',error='Transport outcome unknown; not automatically resent',updated_at=? WHERE email_id=? AND status='sending' AND updated_at<?",
    )
      .bind(
        nowIso(),
        email_id,
        new Date(Date.now() - 15 * 60_000).toISOString(),
      )
      .run();
    await updateTransactionalStatus(env, email_id);
  }
  const expired = await env.DB.prepare(
    "SELECT id FROM transactional_emails WHERE expires_at<=? LIMIT 50",
  )
    .bind(nowIso())
    .all<{ id: string }>();
  for (const { id } of expired.results) {
    let cursor: string | undefined;
    do {
      const list = await env.EMAIL_STORAGE.list({
        prefix: objectKey(id, ""),
        cursor,
        limit: 1000,
      });
      if (list.objects.length)
        await env.EMAIL_STORAGE.delete(list.objects.map((o) => o.key));
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    await env.DB.prepare("DELETE FROM transactional_emails WHERE id=?")
      .bind(id)
      .run();
  }
  // One bounded page per minute also removes uploads orphaned by an interrupted ingest.
  const state = await env.EMAIL_STORAGE.get("maintenance/cursor");
  const cursor = state ? await state.text() : undefined;
  const objects = await env.EMAIL_STORAGE.list({
    prefix: "emails/",
    cursor: cursor || undefined,
    include: ["customMetadata"],
    limit: 100,
  });
  const remove = objects.objects
    .filter(
      (o) =>
        o.customMetadata?.expires_at && o.customMetadata.expires_at <= nowIso(),
    )
    .map((o) => o.key);
  if (remove.length) await env.EMAIL_STORAGE.delete(remove);
  await env.EMAIL_STORAGE.put(
    "maintenance/cursor",
    objects.truncated ? objects.cursor : "",
  );
}
