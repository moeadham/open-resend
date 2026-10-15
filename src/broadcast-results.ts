export const DELIVERY_FILTERS = ["all", "delivered", "unsubscribed", "bounced", "suppressed", "complained", "failed", "pending"] as const;
export type DeliveryFilter = typeof DELIVERY_FILTERS[number];
export type BroadcastRecipient = {
  id: string;
  contact_id: string | null;
  recipient: string;
  status: string;
  attempts: number;
  message_id: string | null;
  last_error: string | null;
  updated_at: string;
  unsubscribed_at: string | null;
};
export type BroadcastResults = {
  counts: Record<string, number>;
  total: number;
  unsubscribed: number;
  untracked: number;
  filter: DeliveryFilter;
  search: string;
  page: number;
  pageSize: number;
  filteredTotal: number;
  recipients: BroadcastRecipient[];
};

// Attribution is a durable event on this delivery, never a preference snapshot.
const recipientJoin = "FROM deliveries d";
const optedOut = "d.unsubscribed_at IS NOT NULL";
const pendingStates = "'pending','enqueued','sending','accepted','deferred'";

export async function loadBroadcastResults(db: D1Database, broadcastId: string, params: URLSearchParams): Promise<BroadcastResults> {
  const requestedFilter = params.get("delivery_status") ?? "all";
  const filter = DELIVERY_FILTERS.includes(requestedFilter as DeliveryFilter) ? requestedFilter as DeliveryFilter : "all";
  const search = (params.get("delivery_search") ?? "").trim().slice(0, 320);
  const pageSize = 10;
  const [statusCounts, optOutCount] = await Promise.all([
    db.prepare(`SELECT status,COUNT(*) AS count,
      SUM(CASE WHEN message_id IS NOT NULL AND unsubscribed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM unsubscribe_tokens ut WHERE ut.delivery_id=deliveries.id)
        THEN 1 ELSE 0 END) AS untracked
      FROM deliveries WHERE broadcast_id=? GROUP BY status`)
      .bind(broadcastId).all<{ status: string; count: number; untracked: number }>(),
    db.prepare(`SELECT COUNT(*) AS count ${recipientJoin} WHERE d.broadcast_id=? AND ${optedOut}`)
      .bind(broadcastId).first<{ count: number }>(),
  ]);
  const counts: Record<string, number> = Object.fromEntries(statusCounts.results.map(row => [row.status, Number(row.count)]));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const conditions = ["d.broadcast_id=?"];
  const bindings: string[] = [broadcastId];
  if (filter === "unsubscribed") conditions.push(optedOut);
  else if (filter === "pending") conditions.push(`d.status IN (${pendingStates})`);
  else if (filter !== "all") {
    conditions.push(filter === "failed" ? "d.status IN ('failed','rejected')" : "d.status=?");
    if (filter !== "failed") bindings.push(filter);
  }
  // instr treats %, _ and apostrophes as literal search text, not SQL patterns.
  if (search) { conditions.push("instr(lower(d.recipient),lower(?))>0"); bindings.push(search); }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const matching = await db.prepare(`SELECT COUNT(*) AS count ${recipientJoin} ${where}`).bind(...bindings).first<{ count: number }>();
  const filteredTotal = Number(matching?.count ?? 0);
  const requestedPage = Number(params.get("delivery_page") ?? 1);
  const page = Math.min(Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, Math.max(1, Math.ceil(filteredTotal / pageSize)));
  const recipients = await db.prepare(`SELECT d.id,d.contact_id,d.recipient,d.status,d.attempts,d.message_id,d.last_error,d.updated_at,d.unsubscribed_at
    ${recipientJoin} ${where} ORDER BY d.updated_at DESC,d.id DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, pageSize, (page - 1) * pageSize).all<BroadcastRecipient>();
  const untracked = statusCounts.results.reduce((sum, row) => sum + Number(row.untracked), 0);
  return { counts, total, unsubscribed: Number(optOutCount?.count ?? 0), untracked, filter, search, page, pageSize, filteredTotal, recipients: recipients.results };
}
