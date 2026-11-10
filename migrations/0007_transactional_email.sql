CREATE TABLE transactional_emails (
 id TEXT PRIMARY KEY,
 direction TEXT NOT NULL CHECK(direction IN ('sending','receiving')),
 from_value TEXT NOT NULL,
 to_json TEXT NOT NULL,
 subject TEXT NOT NULL,
 api_key_id TEXT,
 status TEXT NOT NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 download_secret TEXT NOT NULL,
 ingest_key TEXT UNIQUE
);
CREATE INDEX idx_transactional_created ON transactional_emails(direction,created_at,id);
CREATE INDEX idx_transactional_expiry ON transactional_emails(expires_at);
CREATE TABLE transactional_recipients (
 email_id TEXT NOT NULL REFERENCES transactional_emails(id) ON DELETE CASCADE,
 recipient TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 provider_id TEXT,
 error TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(email_id,recipient)
);
CREATE INDEX idx_transactional_provider ON transactional_recipients(provider_id);
CREATE TABLE transactional_events (
 id TEXT PRIMARY KEY,
 email_id TEXT NOT NULL REFERENCES transactional_emails(id) ON DELETE CASCADE,
 status TEXT NOT NULL,
 recipient TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE webhooks (
 id TEXT PRIMARY KEY,
 endpoint TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled')),
 signing_secret TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE webhook_events (
 id TEXT PRIMARY KEY,
 email_id TEXT NOT NULL REFERENCES transactional_emails(id) ON DELETE CASCADE,
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE webhook_deliveries (
 id TEXT PRIMARY KEY,
 webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT NOT NULL,
 lease_until TEXT,
 UNIQUE(webhook_id,event_id)
);
CREATE INDEX idx_webhook_due ON webhook_deliveries(status,next_attempt_at);
CREATE TABLE webhook_attempts (
 id TEXT PRIMARY KEY,
 delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL,
 http_status INTEGER,
 response_body TEXT NOT NULL,
 success INTEGER NOT NULL
);
CREATE TABLE receiving_domains (
 name TEXT PRIMARY KEY COLLATE NOCASE,
 zone_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 addresses_json TEXT NOT NULL DEFAULT '[]',
 rules_json TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL
);
