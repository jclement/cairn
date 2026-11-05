-- Round 2: per-person invites, account admin, stats rollups, AI usage rollups.

ALTER TABLE users ADD COLUMN invited_by TEXT;
ALTER TABLE users ADD COLUMN disabled_at TEXT;
ALTER TABLE users ADD COLUMN last_active_at TEXT;

-- Invites keep their code so the inviter can see and share the link again until it is used.
ALTER TABLE invites ADD COLUMN id TEXT;
ALTER TABLE invites ADD COLUMN code TEXT;
ALTER TABLE invites ADD COLUMN note TEXT;
ALTER TABLE invites ADD COLUMN revoked_at TEXT;
CREATE UNIQUE INDEX invites_id ON invites(id);
CREATE INDEX invites_creator ON invites(created_by, created_at);

-- Daily counters per user. metric is e.g. op_search, note_create, write_ai, client:Claude Code, mcp:bm_write.
CREATE TABLE stats_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, metric)
);
CREATE INDEX stats_daily_day ON stats_daily(day, metric);

-- Daily AI usage per user, model and purpose (embed, query_embed, search_rerank, write_hints).
CREATE TABLE ai_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,      -- total, for averages
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_calls INTEGER NOT NULL DEFAULT 0, -- calls whose token counts are estimates
  PRIMARY KEY (user_id, day, model, purpose)
);
CREATE INDEX ai_daily_day ON ai_daily(day);

CREATE TABLE instance_meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO instance_meta (key, value) VALUES ('stats_since', strftime('%Y-%m-%d', 'now'));
