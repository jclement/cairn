-- Import fix 2: a per-account daily cap on import jobs (report-only jobs included), and an index
-- for account-wide retention of finished jobs.
ALTER TABLE import_daily ADD COLUMN jobs INTEGER NOT NULL DEFAULT 0;
CREATE INDEX import_jobs_finished ON import_jobs(user_id, finished_at);
