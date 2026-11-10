ALTER TABLE email_events ADD COLUMN payload_json TEXT;
ALTER TABLE email_events ADD COLUMN transactional_processed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_email_events_transactional ON email_events(transactional_processed,message_id);
