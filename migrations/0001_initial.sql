PRAGMA foreign_keys = ON;

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE senders (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  reply_to TEXT,
  postal_address TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  first_name TEXT,
  last_name TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}',
  unsubscribed INTEGER NOT NULL DEFAULT 0 CHECK (unsubscribed IN (0, 1)),
  suppression_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE segment_contacts (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed', 'unsubscribed', 'removed')),
  subscribed_at TEXT NOT NULL,
  unsubscribed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, contact_id)
);

CREATE TABLE unsubscribe_tokens (
  token_hash TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (segment_id, contact_id) REFERENCES segment_contacts(segment_id, contact_id) ON DELETE CASCADE
);

CREATE TABLE broadcasts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE RESTRICT,
  sender_id TEXT NOT NULL REFERENCES senders(id) ON DELETE RESTRICT,
  from_value TEXT NOT NULL,
  subject TEXT NOT NULL,
  reply_to_json TEXT,
  preview_text TEXT,
  html TEXT,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'queueing', 'queued', 'sending', 'sent', 'cancelled', 'failed')),
  scheduled_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE deliveries (
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

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE email_events (
  event_id TEXT PRIMARY KEY,
  message_id TEXT,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX idx_segment_contacts_contact ON segment_contacts(contact_id);
CREATE INDEX idx_segment_contacts_active ON segment_contacts(segment_id, status);
CREATE INDEX idx_unsubscribe_membership ON unsubscribe_tokens(segment_id, contact_id);
CREATE INDEX idx_contacts_created ON contacts(created_at, id);
CREATE INDEX idx_broadcasts_created ON broadcasts(created_at, id);
CREATE INDEX idx_deliveries_broadcast_status ON deliveries(broadcast_id, status);
CREATE INDEX idx_deliveries_message ON deliveries(message_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(prefix);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at);
