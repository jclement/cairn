-- Durable R2 cleanup records for attachment objects that have no live row to track them: an upload
-- that finished after its row was purged or rolled back, or a put whose outcome is unknown. Kept
-- (with the user and vault gone, if need be) until the object's deletion is acknowledged; the
-- nightly sweeper retries any that are due (`not_before` lets a late-landing put be caught).
CREATE TABLE r2_cleanup (
  r2_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  not_before TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX r2_cleanup_due ON r2_cleanup(not_before);
