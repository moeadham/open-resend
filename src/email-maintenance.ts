import { nowIso } from "./lib";
import { objectKey } from "./transactional-storage";
import { publishWebhookOutbox } from "./webhooks";
import type { EmailEventMessage } from "./types";
import { getEmailRetentionDays } from "./settings";
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
  const retentionDays = await getEmailRetentionDays(env.DB);
  await env.DB.prepare(
    "UPDATE email_events SET payload_json=NULL WHERE received_at<? AND payload_json IS NOT NULL",
  )
    .bind(new Date(Date.now() - retentionDays * 86400_000).toISOString())
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
  await deleteExpiredEmails(env);
  await sweepOrphanedObjects(env);
}

// The cron runs hourly, so each run drains a larger, still bounded backlog.
// Each email costs about two R2 subrequests; the cap keeps the whole
// invocation well under the Workers subrequest limit.
const EXPIRED_EMAILS_PER_RUN = 200;
const SWEEP_PAGES_PER_RUN = 5;

async function deleteExpiredEmails(env: Env): Promise<void> {
  for (let done = 0; done < EXPIRED_EMAILS_PER_RUN; ) {
    const expired = await env.DB.prepare(
      "SELECT id FROM transactional_emails WHERE expires_at<=? LIMIT 50",
    )
      .bind(nowIso())
      .all<{ id: string }>();
    const ids = expired.results.map((row) => row.id);
    if (!ids.length) return;
    for (const id of ids) {
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
    }
    // Rows go after their objects, so an interrupted run is retried next hour.
    await env.DB.prepare(
      `DELETE FROM transactional_emails WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .run();
    done += ids.length;
    if (ids.length < 50) return;
  }
}

// Also removes uploads orphaned by an interrupted ingest. Resumes from a saved
// cursor so successive runs walk the whole bucket.
async function sweepOrphanedObjects(env: Env): Promise<void> {
  const state = await env.EMAIL_STORAGE.get("maintenance/cursor");
  let cursor = (state ? await state.text() : "") || undefined;
  for (let page = 0; page < SWEEP_PAGES_PER_RUN; page++) {
    const objects = await env.EMAIL_STORAGE.list({
      prefix: "emails/",
      cursor,
      include: ["customMetadata"],
      limit: 1000,
    });
    const candidates = objects.objects.filter(
      (o) =>
        o.customMetadata?.expires_at &&
        o.customMetadata.expires_at <= nowIso(),
    );
    // Object metadata keeps the expiry from upload time. If retention was later
    // extended, the email row is still live, so its files must be kept.
    const candidateIds = [
      ...new Set(candidates.map((o) => o.key.split("/")[1]!)),
    ];
    const live = new Set<string>();
    // D1 allows at most 100 bound parameters per statement.
    for (let i = 0; i < candidateIds.length; i += 90) {
      const chunk = candidateIds.slice(i, i + 90);
      const rows = await env.DB.prepare(
        `SELECT id FROM transactional_emails WHERE expires_at>? AND id IN (${chunk.map(() => "?").join(",")})`,
      )
        .bind(nowIso(), ...chunk)
        .all<{ id: string }>();
      for (const row of rows.results) live.add(row.id);
    }
    const remove = candidates
      .filter((o) => !live.has(o.key.split("/")[1]!))
      .map((o) => o.key);
    if (remove.length) await env.EMAIL_STORAGE.delete(remove);
    cursor = objects.truncated ? objects.cursor : undefined;
    if (!cursor) break;
  }
  await env.EMAIL_STORAGE.put("maintenance/cursor", cursor ?? "");
}
