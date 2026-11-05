-- Production health: AI calls per hour, instance-wide (no user), so `prod:status` can judge the
-- last 24 hours instead of whole UTC days (a fixed outage yesterday shouldn't keep a red flag).
-- Counts only; the nightly cron keeps 8 days.
CREATE TABLE ai_hourly (
  hour TEXT NOT NULL,              -- YYYY-MM-DDTHH (UTC)
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,       -- includes timed-out calls
  unknown_calls INTEGER NOT NULL DEFAULT 0, -- timed out (a subset of failed)
  PRIMARY KEY (hour, model, purpose)
);
