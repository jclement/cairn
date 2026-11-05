-- Fix round 4 / account: fresh passkey re-authentication on the session (for download, delete
-- account, recovery codes, removing passkeys, creating tokens) and a resumable account deletion.
ALTER TABLE sessions ADD COLUMN reauth_at TEXT;
ALTER TABLE users ADD COLUMN deleting_at TEXT;
