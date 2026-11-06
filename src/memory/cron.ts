// Nightly maintenance (Cron Trigger): expire due observations, write gardening reports, and on
// Mondays the weekly digest. Idle vaults are skipped at the D1 level; work fans out to vault DOs
// in small batches and is capped per run.

import { sweepAttachments } from "../capture/files";
import type { Env } from "../env";
import { pruneMisses } from "../misses";
import type { VaultRef } from "../vault/do";

const BATCH = 10;
const MAX_VAULTS_PER_TASK = 500;

/** ISO-8601 week label, e.g. 2026-W45, for the week containing `d` (UTC). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400e3 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

type Row = { id: string; name: string; owner_id: string };

/** Per-task wall-clock budget: later vaults wait for the next night rather than run late. */
export const TASK_DEADLINE_MS = 4 * 60e3;

class Unknown extends Error {}

/**
 * Run fn over vaults in batches, never past `deadline`: batches aren't started after it, and a
 * running batch is awaited only for the time left. Calls still running then are counted as
 * `unknown` (they may finish later; every task here is safe to repeat), the rest as `deferred`.
 */
export async function fanOut<T, R extends Row = Row>(
  rows: R[],
  fn: (ref: VaultRef, row: R) => Promise<T>,
  deadline = Date.now() + TASK_DEADLINE_MS,
): Promise<{ ok: number; failed: number; unknown: number; deferred: number; results: T[] }> {
  let ok = 0;
  let failed = 0;
  let unknown = 0;
  const results: T[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const left = deadline - Date.now();
    if (left <= 0) return { ok, failed, unknown, deferred: rows.length - i, results };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Unknown()), left);
    });
    const settled = await Promise.allSettled(
      // Started inside a promise: a task that throws synchronously counts as failed instead of aborting the run.
      rows.slice(i, i + BATCH).map((r) => Promise.race([Promise.resolve().then(() => fn({ id: r.id, name: r.name, ownerId: r.owner_id }, r)), expired])),
    );
    if (timer) clearTimeout(timer);
    for (const st of settled) {
      if (st.status === "fulfilled") {
        ok++;
        results.push(st.value);
      } else if (st.reason instanceof Unknown) unknown++;
      else failed++;
    }
  }
  return { ok, failed, unknown, deferred: 0, results };
}

export async function runNightly(env: Env, now: Date) {
  const today = now.toISOString().slice(0, 10);
  const stub = (ref: VaultRef) => env.VAULT.getByName(ref.id);
  const q = async (sql: string, ...bind: unknown[]) =>
    (
      await env.DB.prepare(sql)
        .bind(...bind)
        .all<Row>()
    ).results;

  const expiring = await q(
    "SELECT v.id, v.name, v.owner_id FROM vaults v JOIN users u ON u.id = v.owner_id WHERE u.disabled_at IS NULL AND u.deleting_at IS NULL AND v.next_expiry IS NOT NULL AND v.next_expiry <= ? LIMIT ?",
    today,
    MAX_VAULTS_PER_TASK,
  );
  const expired = await fanOut(expiring, (ref) => stub(ref).expireDue(ref, today));

  // Attachment recovery: roll back uploads that died mid-way, finish deletes R2 hadn't confirmed.
  await sweepAttachments(env, { now: now.getTime() }).catch(() => undefined);

  const dayAgo = new Date(now.getTime() - 86400e3).toISOString();
  const gardenRows = await q(
    `SELECT v.id, v.name, v.owner_id FROM vaults v JOIN users u ON u.id = v.owner_id
     WHERE u.garden_enabled = 1 AND u.disabled_at IS NULL AND u.deleting_at IS NULL AND v.last_activity_at >= ? ORDER BY v.last_activity_at DESC LIMIT ?`,
    dayAgo,
    MAX_VAULTS_PER_TASK,
  );
  const gardened = await fanOut(gardenRows, (ref) => stub(ref).garden(ref, today));

  let digests: Awaited<ReturnType<typeof fanOut>> | null = null;
  if (now.getUTCDay() === 1) {
    const weekAgo = new Date(now.getTime() - 7 * 86400e3).toISOString();
    const week = isoWeek(new Date(now.getTime() - 86400e3)); // the week that just ended
    const digestRows = await q(
      `SELECT v.id, v.name, v.owner_id FROM vaults v JOIN users u ON u.id = v.owner_id
       WHERE u.garden_enabled = 1 AND u.disabled_at IS NULL AND u.deleting_at IS NULL AND v.last_activity_at >= ? ORDER BY v.last_activity_at DESC LIMIT ?`,
      weekAgo,
      MAX_VAULTS_PER_TASK,
    );
    digests = await fanOut(digestRows, (ref) => stub(ref).digest(ref, week, weekAgo));
  }
  // Import jobs stuck in the directory (a vault that never ran its own TTL): abort them there.
  const stuck = (
    await env.DB.prepare(
      `SELECT j.id AS job, v.id, v.name, v.owner_id FROM import_jobs j JOIN vaults v ON v.id = j.vault_id
       WHERE (j.status = 'staging' AND j.created_at < ?1) OR (j.status = 'running' AND j.created_at < ?2) LIMIT 200`,
    )
      .bind(new Date(now.getTime() - 3600e3).toISOString(), new Date(now.getTime() - 7 * 86400e3).toISOString())
      .all<Row & { job: string }>()
  ).results;
  const aborted = await fanOut(stuck, (ref, row) => stub(ref).importAbort(ref, row.job));
  // Retention backstop: finished jobs beyond the newest 5 per account lose their report (in their
  // vault) and then their directory row; daily budget rows older than two days are dropped.
  const overflow = (
    await env.DB.prepare(
      `SELECT x.job, v.id, v.name, v.owner_id FROM (
         SELECT id AS job, vault_id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY finished_at DESC, id) AS rn
         FROM import_jobs WHERE status IN ('done', 'aborted')) x
       JOIN vaults v ON v.id = x.vault_id WHERE x.rn > 5 LIMIT 500`,
    ).all<Row & { job: string }>()
  ).results;
  const forgot = await fanOut(overflow, async (ref, row) => {
    await stub(ref).importForget(row.job);
    await env.DB.prepare("DELETE FROM import_jobs WHERE id = ? AND status IN ('done', 'aborted')").bind(row.job).run();
  });
  const day2 = new Date(now.getTime() - 2 * 86400e3).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM import_daily WHERE day < ?").bind(day2),
    // Directory rows whose vault no longer exists.
    env.DB.prepare("DELETE FROM import_jobs WHERE status IN ('done', 'aborted') AND vault_id NOT IN (SELECT id FROM vaults)"),
  ]);
  // Misses: keep 90 days (best effort).
  const misses = await pruneMisses(env, now.getTime()).catch(() => 0);
  // Health counts: keep 8 days of hourly AI calls (best effort).
  await env.DB.prepare("DELETE FROM ai_hourly WHERE hour < ?")
    .bind(new Date(now.getTime() - 8 * 86400e3).toISOString().slice(0, 13))
    .run()
    .catch(() => undefined);

  return {
    imports: { stuck: stuck.length, aborted: aborted.ok, pruned: forgot.ok },
    misses_pruned: misses,
    expired: { vaults: expiring.length, ...expired },
    gardened: { vaults: gardenRows.length, ...gardened },
    digests: digests ? { ...digests } : null,
  };
}

/** Keep this many cron_runs rows. */
export const CRON_RUNS_KEPT = 90;

type TaskCounts = { ok: number; failed: number; unknown: number; deferred: number };

/** Run the nightly job and record it in cron_runs (start, end, vault tasks done/failed, error). */
export async function recordNightly(env: Env, now: Date): Promise<Awaited<ReturnType<typeof runNightly>>> {
  const started = new Date().toISOString();
  const row = await env.DB.prepare("INSERT INTO cron_runs (started_at, status) VALUES (?, 'running') RETURNING id")
    .bind(started)
    .first<{ id: number }>()
    .catch(() => null);
  const finish = async (status: string, counts: TaskCounts, error: string | null, summary: unknown) => {
    if (!row) return;
    await env.DB.batch([
      env.DB.prepare("UPDATE cron_runs SET finished_at = ?, status = ?, vaults = ?, errors = ?, deferred = ?, error = ?, summary = ? WHERE id = ?").bind(
        new Date().toISOString(),
        status,
        counts.ok,
        counts.failed + counts.unknown,
        counts.deferred,
        error,
        summary === null ? null : JSON.stringify(summary),
        row.id,
      ),
      env.DB.prepare("DELETE FROM cron_runs WHERE id <= ?").bind(row.id - CRON_RUNS_KEPT),
    ]).catch(() => undefined);
  };
  try {
    const r = await runNightly(env, now);
    const tasks: TaskCounts[] = [r.expired, r.gardened, ...(r.digests ? [r.digests] : [])];
    const counts = tasks.reduce<TaskCounts>(
      (a, t) => ({ ok: a.ok + t.ok, failed: a.failed + t.failed, unknown: a.unknown + t.unknown, deferred: a.deferred + t.deferred }),
      { ok: 0, failed: 0, unknown: 0, deferred: 0 },
    );
    const { results: _e, ...expired } = r.expired;
    const { results: _g, ...gardened } = r.gardened;
    const digests = r.digests ? (({ results: _d, ...rest }) => rest)(r.digests) : null;
    await finish(counts.failed + counts.unknown ? "errors" : "ok", counts, null, {
      imports: r.imports,
      misses_pruned: r.misses_pruned,
      expired,
      gardened,
      digests,
    });
    return r;
  } catch (e) {
    await finish("failed", { ok: 0, failed: 0, unknown: 0, deferred: 0 }, String((e as Error)?.message ?? e).slice(0, 500), null);
    throw e;
  }
}
