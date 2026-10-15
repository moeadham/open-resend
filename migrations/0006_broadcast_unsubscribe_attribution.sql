-- Legacy tokens have no reliable broadcast identity. Leave them unattributed.
ALTER TABLE unsubscribe_tokens ADD COLUMN delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL;
CREATE INDEX idx_unsubscribe_delivery ON unsubscribe_tokens(delivery_id);

-- Keep the first attributed opt-out even if preferences change or a contact is deleted.
ALTER TABLE deliveries ADD COLUMN unsubscribed_at TEXT;
CREATE INDEX idx_deliveries_broadcast_unsubscribe ON deliveries(broadcast_id, unsubscribed_at);
