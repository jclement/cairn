-- Round 3a: core memory budget, gardening opt-out, and what the nightly cron needs to skip idle vaults.
ALTER TABLE users ADD COLUMN core_budget INTEGER NOT NULL DEFAULT 8192;
ALTER TABLE users ADD COLUMN garden_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE vaults ADD COLUMN last_write_at TEXT;
ALTER TABLE vaults ADD COLUMN next_expiry TEXT;
CREATE INDEX vaults_last_write ON vaults(last_write_at);
CREATE INDEX vaults_next_expiry ON vaults(next_expiry);
