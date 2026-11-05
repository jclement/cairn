// Production health: the same checks for `mise run prod:status` (scripts/prod-status.mjs, over the
// D1 HTTP API) and the admin page /app/admin/health (over the DB binding). Counts and metadata
// only, never note content. No imports, so Node can load this file directly.

/** Run one read-only SQL statement; rows as plain objects. */
export type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** A model+purpose whose failure rate is above this (with at least AI_MIN_CALLS calls) is a red flag. */
export const AI_FAIL_RATE_FLAG = 0.1;
export const AI_MIN_CALLS = 5;
/** No finished cron run for this long is a red flag (the cron runs daily at 03:00 UTC). */
export const CRON_STALE_HOURS = 26;
/** Import jobs past these ages are stuck (the cron aborts staging after 1 h, running after 7 days). */
export const IMPORT_STAGING_STUCK_HOURS = 1;
export const IMPORT_RUNNING_STUCK_HOURS = 6;

export interface AiRow {
  model: string;
  purpose: string;
  calls: number;
  failed: number;
  /** Of `failed`, the calls that timed out (they may still have run and billed). */
  unknown: number;
  failure_rate: number;
  flagged: boolean;
}

export interface CronRun {
  started_at: string;
  finished_at: string | null;
  status: string;
  vaults: number;
  errors: number;
  deferred: number;
  error: string | null;
}

export interface Health {
  generated_at: string;
  counts: { users: number; active_users: number; vaults: number; notes: number; bytes: number; attachments: number };
  /** last24h: the last 24 hours (hourly counts; red flags come from here). day7: the last 7 UTC days, for context. */
  ai: { last24h: AiRow[]; day7: AiRow[] };
  cron: { last: CronRun | null; last_finished: CronRun | null; runs_7d: number; failed_7d: number };
  imports: { staging_stuck: number; running_stuck: number; oldest_stuck: string | null };
  email: { day1: { messages: number; attachments: number }; day7: { messages: number; attachments: number } };
  migrations: { applied: string[] };
  /** Red flags: `prod:status` exits non-zero when there are any. */
  flags: string[];
  /** Worth a look, not red. */
  warnings: string[];
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const dayOffset = (now: Date, days: number) => new Date(now.getTime() - days * 86400e3).toISOString().slice(0, 10);
const hoursAgo = (now: Date, h: number) => new Date(now.getTime() - h * 3600e3).toISOString();

async function aiRows(q: Query, table: "ai_hourly" | "ai_daily", since: string, flag: boolean): Promise<AiRow[]> {
  const col = table === "ai_hourly" ? "hour" : "day";
  const rows = await q(
    `SELECT model, purpose, SUM(calls) AS calls, SUM(failed) AS failed, SUM(unknown_calls) AS unknown
     FROM ${table} WHERE ${col} >= ? GROUP BY model, purpose ORDER BY model, purpose`,
    [since],
  );
  return rows.map((r) => {
    const calls = num(r.calls);
    const failed = num(r.failed);
    const unknown = num(r.unknown);
    // A timed-out call is recorded as failed too (unknown_calls is a subset of failed).
    const failure_rate = calls ? failed / calls : 0;
    return {
      model: String(r.model),
      purpose: String(r.purpose),
      calls,
      failed,
      unknown,
      failure_rate,
      flagged: flag && calls >= AI_MIN_CALLS && failure_rate > AI_FAIL_RATE_FLAG,
    };
  });
}

function cronRow(r: Record<string, unknown> | undefined): CronRun | null {
  if (!r) return null;
  return {
    started_at: String(r.started_at),
    finished_at: str(r.finished_at),
    status: String(r.status),
    vaults: num(r.vaults),
    errors: num(r.errors),
    deferred: num(r.deferred),
    error: str(r.error),
  };
}

export async function collectHealth(q: Query, now = new Date()): Promise<Health> {
  const flags: string[] = [];
  const warnings: string[] = [];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] ?? {};
  /** Each section degrades on its own: a failed check is a red flag, never a crash. */
  const section = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      flags.push(`${name}: check failed (${String((e as Error)?.message ?? e).slice(0, 200)})`);
      return fallback;
    }
  };

  const counts = await section("Counts", { users: 0, active_users: 0, vaults: 0, notes: 0, bytes: 0, attachments: 0 }, async () => {
    const u = await one(
      "SELECT COUNT(*) AS users, SUM(CASE WHEN disabled_at IS NULL AND deleting_at IS NULL THEN 1 ELSE 0 END) AS active, COALESCE(SUM(bytes_used), 0) AS bytes FROM users",
    );
    const v = await one("SELECT COUNT(*) AS vaults, COALESCE(SUM(note_count), 0) AS notes FROM vaults");
    const a = await one("SELECT COUNT(*) AS n FROM attachments WHERE state = 'ready'");
    return { users: num(u.users), active_users: num(u.active), vaults: num(v.vaults), notes: num(v.notes), bytes: num(u.bytes), attachments: num(a.n) };
  });

  // Only the last 24 hours can raise a flag, so an outage that has been fixed stops flagging a day later.
  const ai = await section("AI", { last24h: [] as AiRow[], day7: [] as AiRow[] }, async () => ({
    last24h: await aiRows(q, "ai_hourly", hoursAgo(now, 24).slice(0, 13), true),
    day7: await aiRows(q, "ai_daily", dayOffset(now, 6), false),
  }));
  for (const r of ai.last24h)
    if (r.flagged) flags.push(`AI ${r.model} / ${r.purpose}: ${(r.failure_rate * 100).toFixed(0)}% of ${r.calls} calls failed in the last 24 h`);
  for (const r of ai.day7) {
    const recent = ai.last24h.find((x) => x.model === r.model && x.purpose === r.purpose);
    const older = { calls: r.calls - (recent?.calls ?? 0), failed: r.failed - (recent?.failed ?? 0) };
    if (older.calls >= AI_MIN_CALLS && older.failed / older.calls > AI_FAIL_RATE_FLAG && !recent?.flagged)
      warnings.push(`AI ${r.model} / ${r.purpose}: failures earlier in the week (${older.failed} of ${older.calls} calls), none flagged in the last 24 h`);
  }

  const cron = await section<Health["cron"]>("Cron", { last: null, last_finished: null, runs_7d: 0, failed_7d: 0 }, async () => {
    const last = cronRow((await q("SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1"))[0]);
    const lastFinished = cronRow((await q("SELECT * FROM cron_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1"))[0]);
    const week = await one(
      "SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('failed', 'errors') THEN 1 ELSE 0 END) AS bad FROM cron_runs WHERE started_at >= ?",
      [hoursAgo(now, 7 * 24)],
    );
    if (!last) warnings.push("No cron run recorded yet (the first runs at 03:00 UTC after this deploy).");
    else {
      if (!lastFinished || lastFinished.finished_at === null || lastFinished.finished_at < hoursAgo(now, CRON_STALE_HOURS))
        flags.push(`Cron: no run finished in the last ${CRON_STALE_HOURS} h (last started ${last.started_at})`);
      if (last.status === "running" && last.started_at < hoursAgo(now, 1)) flags.push(`Cron: the run started ${last.started_at} never finished`);
      if (lastFinished?.status === "failed") flags.push(`Cron: the last run failed: ${lastFinished.error ?? "unknown error"}`);
      if (lastFinished?.status === "errors") flags.push(`Cron: the last run had ${lastFinished.errors} failed vault task(s)`);
      if (lastFinished && lastFinished.deferred > 0) warnings.push(`Cron: ${lastFinished.deferred} vault task(s) deferred to the next night`);
    }
    return { last, last_finished: lastFinished, runs_7d: num(week.n), failed_7d: num(week.bad) };
  });

  const imports = await section("Imports", { staging_stuck: 0, running_stuck: 0, oldest_stuck: null as string | null }, async () => {
    const stuck = await one(
      `SELECT SUM(CASE WHEN status = 'staging' AND created_at < ?1 THEN 1 ELSE 0 END) AS staging,
              SUM(CASE WHEN status = 'running' AND created_at < ?2 THEN 1 ELSE 0 END) AS running,
              MIN(CASE WHEN (status = 'staging' AND created_at < ?1) OR (status = 'running' AND created_at < ?2) THEN created_at END) AS oldest
       FROM import_jobs`,
      [hoursAgo(now, IMPORT_STAGING_STUCK_HOURS), hoursAgo(now, IMPORT_RUNNING_STUCK_HOURS)],
    );
    return { staging_stuck: num(stuck.staging), running_stuck: num(stuck.running), oldest_stuck: str(stuck.oldest) };
  });
  if (imports.staging_stuck + imports.running_stuck)
    flags.push(`Imports: ${imports.staging_stuck} staging and ${imports.running_stuck} running job(s) stuck (oldest ${imports.oldest_stuck})`);

  const mail = async (since: string) => {
    const r = await one(
      "SELECT SUM(CASE WHEN metric = 'email_in' THEN value ELSE 0 END) AS m, SUM(CASE WHEN metric = 'email_attachments' THEN value ELSE 0 END) AS a FROM stats_daily WHERE day >= ? AND metric IN ('email_in', 'email_attachments')",
      [since],
    );
    return { messages: num(r.m), attachments: num(r.a) };
  };
  const email = await section("Email", { day1: { messages: 0, attachments: 0 }, day7: { messages: 0, attachments: 0 } }, async () => ({
    day1: await mail(dayOffset(now, 1)),
    day7: await mail(dayOffset(now, 6)),
  }));

  const applied = await section("D1 migrations", [] as string[], async () =>
    (await q("SELECT name FROM d1_migrations ORDER BY id")).map((r) => String(r.name)),
  );

  return { generated_at: now.toISOString(), counts, ai, cron, imports, email, migrations: { applied }, flags, warnings };
}
