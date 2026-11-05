-- Files an import stores belong to that import until it commits (the job starts): rolling the
-- import back, or the nightly sweep after an upload died, deletes only files still owned by it.
-- Anything else that reuses such a file (dedupe by identical content) adopts it first, clearing
-- import_job, so rollback can never delete a file another operation now relies on.
ALTER TABLE attachments ADD COLUMN import_job TEXT;
CREATE INDEX attachments_import_job ON attachments(import_job) WHERE import_job IS NOT NULL;
