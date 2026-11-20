-- Account-wide suppression list, modelled on Resend's: an address (not a contact) is suppressed
-- because it hard-bounced, complained, or was added manually. Contacts keep their status, topics,
-- and segments; contacts.suppression_reason mirrors this list so broadcast eligibility checks stay
-- unchanged, and the triggers below keep the two in sync.
CREATE TABLE suppressions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('bounce', 'complaint', 'manual')),
  details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_suppressions_created ON suppressions(created_at, id);

-- Backfill from contacts already suppressed, carrying over the most recent bounce/complaint reason.
INSERT INTO suppressions (id, email, origin, details, created_at, updated_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  c.email,
  CASE c.suppression_reason WHEN 'bounced' THEN 'bounce' WHEN 'complained' THEN 'complaint' ELSE 'manual' END,
  (SELECT d.last_error FROM deliveries d
     WHERE d.contact_id = c.id AND d.status IN ('bounced', 'complained') AND d.last_error IS NOT NULL
     ORDER BY d.updated_at DESC LIMIT 1),
  c.updated_at,
  c.updated_at
FROM contacts c
WHERE c.suppression_reason IS NOT NULL;

CREATE TRIGGER suppressions_flag_contacts_on_insert AFTER INSERT ON suppressions BEGIN
  UPDATE contacts
  SET suppression_reason = CASE NEW.origin WHEN 'bounce' THEN 'bounced' WHEN 'complaint' THEN 'complained' ELSE 'manual' END
  WHERE email = NEW.email;
END;

CREATE TRIGGER suppressions_flag_contacts_on_update AFTER UPDATE OF origin, email ON suppressions BEGIN
  UPDATE contacts SET suppression_reason = NULL WHERE email = OLD.email;
  UPDATE contacts
  SET suppression_reason = CASE NEW.origin WHEN 'bounce' THEN 'bounced' WHEN 'complaint' THEN 'complained' ELSE 'manual' END
  WHERE email = NEW.email;
END;

CREATE TRIGGER suppressions_unflag_contacts_on_delete AFTER DELETE ON suppressions BEGIN
  UPDATE contacts SET suppression_reason = NULL WHERE email = OLD.email;
END;

CREATE TRIGGER contacts_apply_suppression_on_insert AFTER INSERT ON contacts BEGIN
  UPDATE contacts
  SET suppression_reason = (
    SELECT CASE s.origin WHEN 'bounce' THEN 'bounced' WHEN 'complaint' THEN 'complained' ELSE 'manual' END
    FROM suppressions s WHERE s.email = NEW.email
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER contacts_apply_suppression_on_email_change AFTER UPDATE OF email ON contacts BEGIN
  UPDATE contacts
  SET suppression_reason = (
    SELECT CASE s.origin WHEN 'bounce' THEN 'bounced' WHEN 'complaint' THEN 'complained' ELSE 'manual' END
    FROM suppressions s WHERE s.email = NEW.email
  )
  WHERE id = NEW.id;
END;
