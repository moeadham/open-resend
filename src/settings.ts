import { AppError, nowIso } from "./lib";

export const DEFAULT_EMAIL_RETENTION_DAYS = 30;
export const MAX_EMAIL_RETENTION_DAYS = 3650;
const EMAIL_RETENTION_KEY = "email_retention_days";

export async function getEmailRetentionDays(db: D1Database): Promise<number> {
  const value = await db
    .prepare("SELECT value FROM settings WHERE key=?")
    .bind(EMAIL_RETENTION_KEY)
    .first<string>("value");
  const days = Number(value);
  return Number.isSafeInteger(days) && days >= 1 && days <= MAX_EMAIL_RETENTION_DAYS
    ? days
    : DEFAULT_EMAIL_RETENTION_DAYS;
}

export function parseEmailRetentionDays(value: unknown): number {
  const days = Number(typeof value === "string" ? value.trim() : value);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_EMAIL_RETENTION_DAYS)
    throw new AppError(
      422,
      "validation_error",
      `Retention must be a whole number of days between 1 and ${MAX_EMAIL_RETENTION_DAYS}.`,
    );
  return days;
}

export function emailExpiry(createdAtMs: number, retentionDays: number): string {
  return new Date(createdAtMs + retentionDays * 86400_000).toISOString();
}

// Stored emails carry their own expires_at so every read path can hide them
// without consulting settings. Changing retention re-derives it from created_at,
// so the new window applies to emails already stored, not just future ones.
export async function setEmailRetentionDays(
  db: D1Database,
  days: number,
): Promise<void> {
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      )
      .bind(EMAIL_RETENTION_KEY, String(days), now),
    db
      .prepare(
        "UPDATE transactional_emails SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,?)",
      )
      .bind(`+${days} days`),
  ]);
}
