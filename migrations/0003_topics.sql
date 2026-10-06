CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  default_subscription TEXT NOT NULL CHECK (default_subscription IN ('opt_in', 'opt_out')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE contact_topics (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  subscription TEXT NOT NULL CHECK (subscription IN ('opt_in', 'opt_out')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, contact_id)
);

ALTER TABLE broadcasts ADD COLUMN topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL;

DROP TABLE unsubscribe_tokens;

CREATE TABLE unsubscribe_tokens (
  token_hash TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

UPDATE segment_contacts
SET status = 'subscribed', unsubscribed_at = NULL, updated_at = CURRENT_TIMESTAMP
WHERE status = 'unsubscribed';

CREATE INDEX idx_contact_topics_contact ON contact_topics(contact_id);
CREATE INDEX idx_unsubscribe_contact ON unsubscribe_tokens(contact_id);
CREATE INDEX idx_broadcasts_topic ON broadcasts(topic_id);
