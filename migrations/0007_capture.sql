-- Capture: attachments in R2 (metadata, lifecycle and quota here), email inbox keys and sender
-- allowlists, and email Message-ID dedupe.
--
-- Attachment lifecycle: a row is inserted as 'pending' in the same transaction that charges the
-- owner's quota, becomes 'ready' once its R2 object is written, and 'deleting' while its object is
-- being removed. Only 'ready' rows are served. A sweeper (nightly cron) finishes or rolls back
-- rows stuck in 'pending' or 'deleting', so the charge always matches a row.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,                 -- short random id used in /app/files/<project>/<id>
  user_id TEXT NOT NULL,               -- owner charged for the bytes
  vault_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,                -- <vaultId>/<sha256>.<id>.<ext>: unique per row
  name TEXT NOT NULL,                  -- original file name (sanitised, <= 120 chars)
  mime TEXT NOT NULL,                  -- from a short allowlist
  bytes INTEGER NOT NULL,
  caption TEXT,                        -- AI caption for images (<= 400 chars)
  source TEXT NOT NULL,                -- upload | email | url | mcp
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One live row per content per project (dedupe); a row being deleted doesn't block a re-upload.
CREATE UNIQUE INDEX attachments_content ON attachments(vault_id, sha256) WHERE state != 'deleting';
CREATE INDEX attachments_user ON attachments(user_id, state);
CREATE INDEX attachments_vault ON attachments(vault_id, state, id);
CREATE INDEX attachments_state ON attachments(state, updated_at);

ALTER TABLE users ADD COLUMN inbox_key TEXT;
ALTER TABLE users ADD COLUMN inbox_allow TEXT NOT NULL DEFAULT '[]';  -- JSON array of sender addresses
CREATE UNIQUE INDEX users_inbox_key ON users(inbox_key) WHERE inbox_key IS NOT NULL;

CREATE TABLE email_seen (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  permalink TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
