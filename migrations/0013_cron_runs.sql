-- Production health: one row per nightly cron run (src/memory/cron.ts recordNightly), so a cron
-- that stops running or starts failing shows up in `mise run prod:status` and /app/admin/health.
CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,            -- running | ok | errors (some vault tasks failed) | failed (threw)
  vaults INTEGER NOT NULL DEFAULT 0,   -- vault tasks completed
  errors INTEGER NOT NULL DEFAULT 0,   -- vault tasks failed or timed out
  deferred INTEGER NOT NULL DEFAULT 0, -- vault tasks left for the next night (deadline)
  error TEXT,                      -- the thrown error's message, when status = failed
  summary TEXT                     -- runNightly's result as JSON (counts only)
);
CREATE INDEX cron_runs_started ON cron_runs(started_at);
