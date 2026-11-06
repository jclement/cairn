-- Misses: questions Cairn's notes didn't answer, per user, so they can see what memory lacked.
-- Recorded automatically (a search with no results, or with "No note answers this directly") and
-- explicitly (log_miss). Only the query and its filters, never note text. Repeats of the same query
-- in the same project within 10 minutes collapse into one row (count). Kept 90 days (nightly cron).
-- A member's misses in a shared project are the member's own: the owner never sees them.
CREATE TABLE misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  -- NULL: a search across several projects (vault_name lists them).
  vault_id TEXT,
  vault_name TEXT NOT NULL,
  query TEXT NOT NULL,
  -- Lower-cased, whitespace-collapsed query: the de-duplication key.
  norm TEXT NOT NULL,
  tool TEXT NOT NULL,
  -- empty (no results) | no_answer (results, none answers) | not_found | explicit (log_miss)
  kind TEXT NOT NULL,
  filters TEXT,
  expected TEXT,
  client TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  dismissed_at TEXT
);
CREATE INDEX misses_user_last ON misses(user_id, last_at);
CREATE INDEX misses_user_norm ON misses(user_id, norm, last_at);
CREATE INDEX misses_last ON misses(last_at);
