-- NOTE: assumes an empty store (first deployment). On an installation with existing notes this
-- starts every charge at zero; there is no populated-store upgrade path (see README).
-- Per-user storage accounting (live notes + retained revisions across all vaults), maintained
-- by the vault Durable Objects with atomic conditional UPDATEs.
ALTER TABLE users ADD COLUMN bytes_used INTEGER NOT NULL DEFAULT 0;
