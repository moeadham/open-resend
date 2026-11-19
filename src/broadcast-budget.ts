import { AppError, nowIso } from "./lib";

export const DEFAULT_BROADCAST_DAILY_LIMIT = 900;
export const MAX_BROADCAST_DAILY_LIMIT = 10_000_000;
export const BROADCAST_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const BROADCAST_DAILY_LIMIT_KEY = "broadcast_daily_limit";

export type BroadcastBudget = {
  limit: number;
  used: number;
  /** When the current window ends, or null when no window is open (the next send opens one). */
  resetsAt: string | null;
  exhausted: boolean;
};

export async function getBroadcastDailyLimit(db: D1Database): Promise<number> {
  const value = await db.prepare("SELECT value FROM settings WHERE key=?").bind(BROADCAST_DAILY_LIMIT_KEY).first<string>("value");
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_BROADCAST_DAILY_LIMIT ? limit : DEFAULT_BROADCAST_DAILY_LIMIT;
}

export function parseBroadcastDailyLimit(value: unknown): number {
  const limit = Number(typeof value === "string" ? value.trim().replaceAll(",", "") : value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BROADCAST_DAILY_LIMIT) {
    throw new AppError(422, "validation_error", `The broadcast limit must be a whole number between 1 and ${MAX_BROADCAST_DAILY_LIMIT.toLocaleString("en")}.`);
  }
  return limit;
}

export async function setBroadcastDailyLimit(db: D1Database, limit: number): Promise<void> {
  await db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .bind(BROADCAST_DAILY_LIMIT_KEY, String(limit), nowIso()).run();
}

/**
 * Atomically reserves up to `want` broadcast sends from the shared 24-hour budget and returns how
 * many were granted (possibly 0). An expired window is replaced by one starting now, so a window
 * always begins with the first send after the previous one ended.
 */
export async function reserveBroadcastSends(db: D1Database, want: number, limit: number, nowMs = Date.now()): Promise<{ granted: number; budget: BroadcastBudget }> {
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - BROADCAST_BUDGET_WINDOW_MS).toISOString();
  const [, reserved] = await db.batch<{ last_grant: number; used: number; window_started_at: string }>([
    db.prepare("UPDATE broadcast_send_budget SET window_started_at = ?, used = 0 WHERE id = 1 AND (window_started_at IS NULL OR window_started_at <= ?)")
      .bind(now, cutoff),
    // SQLite evaluates every SET expression against the old row, so both use the same grant.
    db.prepare(
      `UPDATE broadcast_send_budget
         SET last_grant = MAX(0, MIN(?1, ?2 - used)), used = used + MAX(0, MIN(?1, ?2 - used))
       WHERE id = 1
       RETURNING last_grant, used, window_started_at`,
    ).bind(Math.max(0, want), limit),
  ]);
  const row = reserved?.results[0];
  if (!row) throw new Error("Broadcast send budget row is missing.");
  return { granted: Number(row.last_grant), budget: describeBudget(limit, Number(row.used), row.window_started_at, nowMs) };
}

export async function getBroadcastBudget(db: D1Database, nowMs = Date.now()): Promise<BroadcastBudget> {
  const [limit, row] = await Promise.all([
    getBroadcastDailyLimit(db),
    db.prepare("SELECT used, window_started_at FROM broadcast_send_budget WHERE id = 1").first<{ used: number; window_started_at: string | null }>(),
  ]);
  return describeBudget(limit, Number(row?.used ?? 0), row?.window_started_at ?? null, nowMs);
}

function describeBudget(limit: number, used: number, windowStartedAt: string | null, nowMs: number): BroadcastBudget {
  const endsMs = windowStartedAt ? Date.parse(windowStartedAt) + BROADCAST_BUDGET_WINDOW_MS : Number.NaN;
  if (!Number.isFinite(endsMs) || endsMs <= nowMs) return { limit, used: 0, resetsAt: null, exhausted: false };
  return { limit, used, resetsAt: new Date(endsMs).toISOString(), exhausted: used >= limit };
}
