-- Shared projects: members (editor | reader; the owner is vaults.owner_id, never a row here) and
-- share links (only a hash of the code is kept; shown once when created). Membership is read on
-- every request (getVault/listVaults in src/directory.ts), so removal takes effect at once.
CREATE TABLE vault_members (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'reader')),
  added_by TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, user_id)
);
CREATE INDEX vault_members_user ON vault_members(user_id);

CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,         -- sha256("share:" + code)
  role TEXT NOT NULL CHECK (role IN ('editor', 'reader')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  single_use INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,        -- redemptions (joins and role upgrades)
  signups INTEGER NOT NULL DEFAULT 0,     -- accounts created through this link (capped)
  last_token TEXT,                        -- the last redemption's token (atomic admission)
  revoked_at TEXT
);
CREATE INDEX share_links_vault ON share_links(vault_id, created_at);

-- Guidance for assistants: a project's guide (what belongs there, its conventions; owner and
-- editors edit, every member reads) and each user's private routing guidance across projects.
-- Kept in the directory, not as notes, so search and export stay free of it. Each is <= 4 KB.
ALTER TABLE vaults ADD COLUMN guide TEXT;
ALTER TABLE vaults ADD COLUMN guide_updated_by TEXT;
ALTER TABLE vaults ADD COLUMN guide_updated_at TEXT;
ALTER TABLE users ADD COLUMN guidance TEXT;
