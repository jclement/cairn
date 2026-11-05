-- OAuth grants approved in the last few minutes, so Settings → Connected apps shows (and can
-- revoke) a new connection at once: the provider lists grants with Workers KV list(), which is
-- eventually consistent and was measured lagging ~30 s on the live site (scripts/oauth-live.mjs).
-- Rows are pruned after 15 minutes, by which time KV's list includes the grant.
CREATE TABLE recent_grants (
  grant_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,          -- JSON array
  created_at INTEGER NOT NULL   -- seconds since the epoch, as the provider's grants
);
CREATE INDEX recent_grants_user ON recent_grants(user_id, created_at);
