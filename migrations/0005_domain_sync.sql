ALTER TABLE domains ADD COLUMN cloudflare_enabled INTEGER NOT NULL DEFAULT 1 CHECK (cloudflare_enabled IN (0, 1));
ALTER TABLE domains ADD COLUMN last_synced_at TEXT;

CREATE INDEX idx_domains_cloudflare_enabled ON domains(cloudflare_enabled, name);
