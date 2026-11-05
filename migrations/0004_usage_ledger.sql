-- Recoverable storage accounting: an idempotent ledger of every charge change (keyed by an id
-- the vault Durable Object journals before sending), a per-vault charge for reconciliation, and
-- a version on the absolute display snapshot so stale writes can't overwrite newer ones.
ALTER TABLE vaults ADD COLUMN charged_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vaults ADD COLUMN usage_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE usage_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX usage_ledger_vault ON usage_ledger(vault_id, at);
