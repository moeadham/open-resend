CREATE TABLE deliveries_next (
  id TEXT PRIMARY KEY,
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'enqueued', 'sending', 'accepted', 'delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained', 'cancelled', 'suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  message_id TEXT UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (broadcast_id, contact_id)
);

INSERT INTO deliveries_next
  (id, broadcast_id, contact_id, recipient, status, attempts, message_id, last_error, created_at, updated_at)
SELECT id, broadcast_id, contact_id, recipient, status, attempts, message_id, last_error, created_at, updated_at
FROM deliveries;

DROP TABLE deliveries;
ALTER TABLE deliveries_next RENAME TO deliveries;

CREATE INDEX idx_deliveries_broadcast_status ON deliveries(broadcast_id, status);
CREATE INDEX idx_deliveries_message ON deliveries(message_id);

CREATE TABLE idempotency_keys_next (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

INSERT INTO idempotency_keys_next
  (key, request_hash, response_status, response_json, created_at, expires_at)
SELECT key, request_hash, response_status, response_json, created_at, expires_at
FROM idempotency_keys;

DROP TABLE idempotency_keys;
ALTER TABLE idempotency_keys_next RENAME TO idempotency_keys;
CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at);
