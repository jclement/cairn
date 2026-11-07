-- Files' text: what Cairn read out of an attachment (a PDF's text by page, an image's visible text
-- and a description, a text file's contents), so search finds it and an agent can quote a page.
--
-- extract_state on the attachment: NULL never tried (files stored before this migration: the
-- owner's backfill queues them), 'pending' queued (extract_after: not before this time, e.g. the
-- next day when the daily AI budget ran out), 'done' text kept, 'failed' (extract_error says why;
-- retryable), 'none' nothing to read (not a PDF/image/text file, or a PDF with no text layer).
ALTER TABLE attachments ADD COLUMN extract_state TEXT;
ALTER TABLE attachments ADD COLUMN extract_error TEXT;
ALTER TABLE attachments ADD COLUMN extract_after TEXT;
ALTER TABLE attachments ADD COLUMN extract_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN extract_pages INTEGER;
-- Bytes of the kept text, charged to the owner's quota with the file (released with it).
ALTER TABLE attachments ADD COLUMN extract_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN extract_at TEXT;
CREATE INDEX attachments_extract ON attachments(extract_state, extract_after) WHERE extract_state = 'pending';

-- The kept text itself (apart from the attachments row, which is read in lists). Page boundaries
-- are "<!-- page N -->" lines. Secrets redacted. The notes that link the file keep a searchable
-- copy in their vault (note_sources.attachment_id), uncharged there: this row carries the charge.
CREATE TABLE attachment_texts (
  attachment_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  cut INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX attachment_texts_vault ON attachment_texts(vault_id);

-- One-time upload URLs (attach_file for files too big to send inline). Only the token's hash is
-- kept. Single use: 'open' -> 'uploaded' (the PUT stored the file: attachment_id) -> 'done'
-- (attach_file finalised it). Expire after 15 minutes; swept nightly.
CREATE TABLE upload_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  filename TEXT,
  mime TEXT,
  note TEXT,
  max_bytes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  attachment_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX upload_tickets_user ON upload_tickets(user_id, state);
