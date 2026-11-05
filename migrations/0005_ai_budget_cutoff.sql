-- Fix round 3: per-user daily AI budget (atomic), "unknown" (timed-out) AI calls, and an account
-- token cutoff so re-enabling an account can't revive credentials issued before it was disabled.
CREATE TABLE ai_budget (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
ALTER TABLE ai_daily ADD COLUMN unknown_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN tokens_valid_after TEXT;
