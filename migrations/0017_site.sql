-- Site identity for instances deployed without PUBLIC_URL (the Deploy to Cloudflare button).
-- site_settings: 'canonical_url' (the origin passkeys and OAuth are bound to, recorded at the
-- first claim and movable by an admin), 'claimed_at' (set once, by the first admin's claim; the
-- claim page is gone for good after), 'update_check' (cached GitHub lookup, JSON).
CREATE TABLE site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One-time claim codes, written to the Worker's log; only their hashes are kept. A handful may be
-- live at once so a stranger asking for new ones can't invalidate the owner's code.
CREATE TABLE claim_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
