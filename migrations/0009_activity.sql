-- Fix round 6: cron eligibility follows user/assistant activity, not Cairn's own maintenance writes.
ALTER TABLE vaults ADD COLUMN last_activity_at TEXT;
CREATE INDEX vaults_last_activity ON vaults(last_activity_at);
