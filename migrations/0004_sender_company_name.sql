ALTER TABLE senders ADD COLUMN company_name TEXT;

UPDATE senders
SET company_name = name
WHERE company_name IS NULL;
