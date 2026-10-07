PRAGMA foreign_keys = ON;

DELETE FROM email_events;
DELETE FROM idempotency_keys;
DELETE FROM unsubscribe_tokens;
DELETE FROM deliveries;
DELETE FROM broadcasts;
DELETE FROM contact_topics;
DELETE FROM segment_contacts;
DELETE FROM contacts;
DELETE FROM senders;
DELETE FROM domains;
DELETE FROM segments;
DELETE FROM topics;
DELETE FROM api_keys;

INSERT INTO segments (id,name,created_at,updated_at)
VALUES ('stress-segment','50k stress audience','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');

INSERT INTO domains (id,name,created_at)
VALUES ('stress-domain','example.com','2026-10-07T00:00:00.000Z');

INSERT INTO senders (id,domain_id,email,name,postal_address,active,created_at,updated_at)
VALUES ('stress-sender','stress-domain','stress@example.com','Stress sender','1 Emulator Way',1,'2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');

WITH RECURSIVE counter(n) AS (
  VALUES(1)
  UNION ALL
  SELECT n + 1 FROM counter WHERE n < 50000
)
INSERT INTO contacts (id,email,created_at,updated_at)
SELECT printf('stress-contact-%05d',n),printf('stress-%05d@example.test',n),'2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z'
FROM counter;

INSERT INTO segment_contacts (segment_id,contact_id,status,subscribed_at,updated_at)
SELECT 'stress-segment',id,'subscribed','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z'
FROM contacts;

INSERT INTO broadcasts (id,name,segment_id,sender_id,from_value,subject,html,text,status,created_at,updated_at)
VALUES ('stress-broadcast','50k queue stress','stress-segment','stress-sender','Stress sender <stress@example.com>','Emulator stress test','<p>Local only</p>','Local only','draft','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');
