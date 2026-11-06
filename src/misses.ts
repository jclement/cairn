// Misses: what a user expected Cairn to know and it didn't. A search that finds nothing (or whose
// results don't answer it), a find with no match, a note that isn't there, and an agent's explicit
// log_miss each record one row in D1 (they span projects): the query and its filters, never note
// text, secrets redacted. Repeats within MISS_DEDUPE_MS collapse into one row with a count; new
// rows are capped per user per hour; rows older than MISS_RETENTION_DAYS go in the nightly cron.
// A miss belongs to the user who asked: in a shared project the owner never sees a member's.

import type { Env } from "./env";
import { redactSecrets } from "./secrets";

export type MissKind = "empty" | "no_answer" | "not_found" | "explicit";

export const MISS_DEDUPE_MS = 10 * 60e3;
export const MISS_RETENTION_DAYS = 90;
/** New miss rows per user per hour (repeats of a recorded one only bump its count). */
export const MISS_ROWS_PER_HOUR = 60;
export const MISS_QUERY_MAX = 500;
export const MISS_FILTERS_MAX = 300;

export interface MissInput {
  userId: string;
  /** null: a search across several projects. */
  vaultId: string | null;
  vaultName: string;
  query: string;
  tool: string;
  kind: MissKind;
  /** The call's narrowing in brief (filters, types, tags, dates, path), as given. */
  filters?: Record<string, unknown>;
  /** log_miss: what the agent looked for. */
  expected?: string;
  client?: string;
}

export interface Miss {
  id: number;
  vault_id: string | null;
  vault_name: string;
  query: string;
  tool: string;
  kind: MissKind;
  filters: string | null;
  expected: string | null;
  client: string | null;
  count: number;
  first_at: string;
  last_at: string;
  dismissed_at: string | null;
}

export const normaliseQuery = (q: string): string =>
  q
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'?.!,;:]+|[\s"'?.!,;:]+$/g, "");

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The filters part of a call, compact: only the keys that were given. */
export function briefFilters(args: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined && args[k] !== null && !(Array.isArray(args[k]) && !(args[k] as unknown[]).length)) out[k] = args[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * Record a miss (best effort: a failure here never fails the caller's tool). Returns the row's id,
 * whether it was a repeat, and how many secrets were redacted; null when nothing was recorded
 * (empty query, or the hourly cap reached).
 */
export async function recordMiss(env: Env, m: MissInput, now = Date.now()): Promise<{ id: number; repeat: boolean; redacted: number } | null> {
  try {
    const q = redactSecrets(m.query.trim());
    const query = clip(q.text, MISS_QUERY_MAX);
    const norm = normaliseQuery(query);
    if (!norm) return null;
    const f = m.filters ? redactSecrets(JSON.stringify(m.filters)) : null;
    const filters = f ? clip(f.text, MISS_FILTERS_MAX) : null;
    const e = m.expected?.trim() ? redactSecrets(m.expected.trim()) : null;
    const expected = e ? clip(e.text, MISS_QUERY_MAX) : null;
    const redacted = q.count + (f?.count ?? 0) + (e?.count ?? 0);
    const at = new Date(now).toISOString();
    const db = env.DB;
    // A repeat (same user, project and query, recently, not dismissed) bumps the existing row. An
    // explicit log upgrades an automatic one: the agent has now said the notes don't answer it.
    const repeat = await db
      .prepare(
        `UPDATE misses SET count = count + 1, last_at = ?1, client = COALESCE(?2, client),
           kind = CASE WHEN ?3 = 'explicit' THEN 'explicit' ELSE kind END, tool = CASE WHEN ?3 = 'explicit' THEN ?8 ELSE tool END,
           expected = COALESCE(?4, expected)
         WHERE id = (SELECT id FROM misses WHERE user_id = ?5 AND norm = ?6 AND COALESCE(vault_id, '') = COALESCE(?7, '')
           AND last_at > ?9 AND dismissed_at IS NULL ORDER BY last_at DESC LIMIT 1)
         RETURNING id`,
      )
      .bind(at, m.client ?? null, m.kind, expected, m.userId, norm, m.vaultId, m.tool, new Date(now - MISS_DEDUPE_MS).toISOString())
      .first<{ id: number }>();
    if (repeat) return { id: repeat.id, repeat: true, redacted };
    const row = await db
      .prepare(
        `INSERT INTO misses (user_id, vault_id, vault_name, query, norm, tool, kind, filters, expected, client, count, first_at, last_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11
         WHERE (SELECT COUNT(*) FROM misses WHERE user_id = ?1 AND first_at > ?12) < ?13
         RETURNING id`,
      )
      .bind(
        m.userId,
        m.vaultId,
        clip(m.vaultName, 200),
        query,
        norm,
        m.tool.slice(0, 40),
        m.kind,
        filters,
        expected,
        m.client ? m.client.slice(0, 100) : null,
        at,
        new Date(now - 3600e3).toISOString(),
        MISS_ROWS_PER_HOUR,
      )
      .first<{ id: number }>();
    return row ? { id: row.id, repeat: false, redacted } : null;
  } catch {
    return null;
  }
}

/** A user's misses, newest first. vaultId: one project's (null = cross-project searches). */
export async function listMisses(
  env: Env,
  userId: string,
  opts: { vaultId?: string | null; since?: string; limit?: number; offset?: number; dismissed?: boolean } = {},
): Promise<Miss[]> {
  const where = ["user_id = ?"];
  const bind: unknown[] = [userId];
  if (opts.vaultId !== undefined) {
    where.push(opts.vaultId === null ? "vault_id IS NULL" : "vault_id = ?");
    if (opts.vaultId !== null) bind.push(opts.vaultId);
  }
  if (opts.since) {
    where.push("last_at >= ?");
    bind.push(opts.since);
  }
  if (!opts.dismissed) where.push("dismissed_at IS NULL");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return (
    await env.DB.prepare(
      `SELECT id, vault_id, vault_name, query, tool, kind, filters, expected, client, count, first_at, last_at, dismissed_at
       FROM misses WHERE ${where.join(" AND ")} ORDER BY last_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bind, limit, Math.max(opts.offset ?? 0, 0))
      .all<Miss>()
  ).results;
}

/** Mark one of the user's misses dismissed (resolved). False: no such miss of theirs. */
export async function dismissMiss(env: Env, userId: string, id: number): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE misses SET dismissed_at = ? WHERE id = ? AND user_id = ? AND dismissed_at IS NULL")
    .bind(new Date().toISOString(), id, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Delete the user's misses (one project's, when vaultId is given). Returns how many. */
export async function clearMisses(env: Env, userId: string, vaultId?: string | null): Promise<number> {
  const r =
    vaultId === undefined
      ? await env.DB.prepare("DELETE FROM misses WHERE user_id = ?").bind(userId).run()
      : vaultId === null
        ? await env.DB.prepare("DELETE FROM misses WHERE user_id = ? AND vault_id IS NULL").bind(userId).run()
        : await env.DB.prepare("DELETE FROM misses WHERE user_id = ? AND vault_id = ?").bind(userId, vaultId).run();
  return r.meta.changes ?? 0;
}

/** Nightly retention: drop misses not seen for MISS_RETENTION_DAYS. */
export async function pruneMisses(env: Env, now = Date.now()): Promise<number> {
  const r = await env.DB.prepare("DELETE FROM misses WHERE last_at < ?")
    .bind(new Date(now - MISS_RETENTION_DAYS * 86400e3).toISOString())
    .run();
  return r.meta.changes ?? 0;
}

const KIND_TEXT: Record<MissKind, string> = {
  empty: "no results",
  no_answer: "results, none answered",
  not_found: "not found",
  explicit: "agent said the notes don't say",
};

export const missKindText = (k: MissKind | string): string => KIND_TEXT[k as MissKind] ?? k;

/** One line per miss, for MCP text output. */
export function missLine(m: Miss): string {
  return `${m.last_at.slice(0, 16)} [${m.vault_name}] "${m.query}" — ${m.tool}, ${missKindText(m.kind)}${m.count > 1 ? ` ×${m.count}` : ""}${m.expected ? `; expected: ${m.expected}` : ""}${m.client ? ` (${m.client})` : ""}`;
}
