type UnsubscribeSource = { delivery_id: string | null; contact_id: string; topic_id: string | null };

// Run BEFORE the preference update, in the same D1 batch/transaction. Checking
// current state in SQL prevents concurrent/replayed requests from counting a
// transition twice or attributing an existing opt-out to a different broadcast.
export function attributeUnsubscribe(db: D1Database, source: UnsubscribeSource, scope: "global" | "topic", now: string): D1PreparedStatement[] {
  if (!source.delivery_id) return [];
  return [db.prepare(`UPDATE deliveries SET unsubscribed_at=COALESCE(unsubscribed_at, ?)
    WHERE id=? AND contact_id=?
      AND EXISTS (SELECT 1 FROM contacts WHERE id=? AND unsubscribed=0)
      AND (?='global' OR EXISTS (
        SELECT 1 FROM topics t LEFT JOIN contact_topics ct ON ct.topic_id=t.id AND ct.contact_id=?
        WHERE t.id=? AND COALESCE(ct.subscription,t.default_subscription)='opt_in'
      ))`)
    .bind(now, source.delivery_id, source.contact_id, source.contact_id, scope, source.contact_id, source.topic_id)];
}
