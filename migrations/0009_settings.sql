CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO settings (key, value, updated_at)
VALUES ('email_retention_days', '30', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
