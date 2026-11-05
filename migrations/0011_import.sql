-- Import fix: staged import data is reserved against the account (users.import_staged_bytes),
-- jobs are registered in the directory (outstanding cap, cleanup sweep), and bulk import has a
-- daily per-account note budget.
ALTER TABLE users ADD COLUMN import_staged_bytes INTEGER NOT NULL DEFAULT 0;
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  status TEXT NOT NULL,            -- staging | running | done | aborted
  staged_bytes INTEGER NOT NULL DEFAULT 0,
  last_batch TEXT,                 -- token of the last reserved staging batch (atomic admission)
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX import_jobs_user ON import_jobs(user_id, status);
CREATE TABLE import_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  notes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
