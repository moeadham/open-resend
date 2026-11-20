import { AppError, isEmail, normalizeEmail, nowIso } from "./lib";

export const SUPPRESSION_ORIGINS = ["bounce", "complaint", "manual"] as const;
export type SuppressionOrigin = (typeof SUPPRESSION_ORIGINS)[number];

export type SuppressionRow = {
  id: string;
  email: string;
  origin: SuppressionOrigin;
  details: string | null;
  created_at: string;
  updated_at: string;
};

export const SUPPRESSIONS_PAGE_SIZE = 40;

/** Extracts the bare address from values such as `Jane <jane@example.com>`. */
export function suppressionAddress(value: string): string | null {
  const address = normalizeEmail(/<([^>]+)>/.exec(value)?.[1] ?? value);
  return isEmail(address) ? address : null;
}

/**
 * Records an automatic suppression from a hard bounce or complaint. Re-suppressing an address keeps
 * its original date but refreshes the origin and reason. Triggers mirror the flag onto contacts.
 */
export async function recordSuppression(db: D1Database, recipient: string, origin: Exclude<SuppressionOrigin, "manual">, details: string | null): Promise<void> {
  const email = suppressionAddress(recipient);
  if (!email) return;
  const now = nowIso();
  await db.prepare(
    `INSERT INTO suppressions (id, email, origin, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET origin = excluded.origin, details = COALESCE(excluded.details, suppressions.details), updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), email, origin, details?.slice(0, 2000) ?? null, now, now).run();
}

/** Adds an address by hand. Returns the new suppression's ID. */
export async function addManualSuppression(db: D1Database, value: unknown): Promise<string> {
  const email = typeof value === "string" ? suppressionAddress(value) : null;
  if (!email) throw new AppError(422, "validation_error", "Enter a valid email address.");
  const id = crypto.randomUUID();
  const now = nowIso();
  const inserted = await db.prepare(
    "INSERT INTO suppressions (id, email, origin, details, created_at, updated_at) VALUES (?, ?, 'manual', NULL, ?, ?) ON CONFLICT(email) DO NOTHING",
  ).bind(id, email, now, now).run();
  if (!inserted.meta.changes) throw new AppError(409, "conflict", `${email} is already on the suppression list.`);
  return id;
}

export async function removeSuppression(db: D1Database, id: string): Promise<void> {
  const removed = await db.prepare("DELETE FROM suppressions WHERE id = ?").bind(id).run();
  if (!removed.meta.changes) throw new AppError(404, "not_found", "Suppression not found.");
}

export async function getSuppression(db: D1Database, id: string): Promise<SuppressionRow & { contact_id: string | null }> {
  const row = await db.prepare(
    "SELECT s.*, (SELECT c.id FROM contacts c WHERE c.email = s.email) AS contact_id FROM suppressions s WHERE s.id = ?",
  ).bind(id).first<SuppressionRow & { contact_id: string | null }>();
  if (!row) throw new AppError(404, "not_found", "Suppression not found.");
  return row;
}

export async function getSuppressionForEmail(db: D1Database, email: string): Promise<SuppressionRow | null> {
  return db.prepare("SELECT * FROM suppressions WHERE email = ?").bind(email).first<SuppressionRow>();
}

export async function listSuppressions(db: D1Database, filters: { search: string; origin: string; page: number }): Promise<{ rows: SuppressionRow[]; total: number }> {
  const clauses: string[] = [];
  const binds: (string | number)[] = [];
  if (filters.search) {
    clauses.push("email LIKE ?");
    binds.push(`%${filters.search}%`);
  }
  if ((SUPPRESSION_ORIGINS as readonly string[]).includes(filters.origin)) {
    clauses.push("origin = ?");
    binds.push(filters.origin);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [rows, total] = await Promise.all([
    db.prepare(`SELECT * FROM suppressions ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, SUPPRESSIONS_PAGE_SIZE, (filters.page - 1) * SUPPRESSIONS_PAGE_SIZE).all<SuppressionRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM suppressions ${where}`).bind(...binds).first<number>("n"),
  ]);
  return { rows: rows.results, total: Number(total ?? 0) };
}
