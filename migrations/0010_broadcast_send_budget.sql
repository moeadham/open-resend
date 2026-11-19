-- First-come, first-served order for broadcasts sharing the 24-hour send budget.
ALTER TABLE broadcasts ADD COLUMN queued_at TEXT;

-- Account-wide broadcast send budget. A window opens with the first broadcast email sent after the
-- previous window ended and lasts 24 hours, mirroring Cloudflare Email Sending's observed quota.
CREATE TABLE broadcast_send_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_started_at TEXT,
  used INTEGER NOT NULL DEFAULT 0,
  last_grant INTEGER NOT NULL DEFAULT 0
);

INSERT INTO broadcast_send_budget (id, used, last_grant) VALUES (1, 0, 0);
