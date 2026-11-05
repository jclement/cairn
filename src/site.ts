// Site identity: the canonical URL (passkeys' rpID, OAuth metadata, links) and the first-run claim.
//
// PUBLIC_URL, when set, is the canonical URL, as before. When it is empty (the Deploy to
// Cloudflare template), the origin the first admin claims the site at is recorded in D1 and used
// from then on; requests that arrive on another host the Worker answers on (workers.dev vs a custom
// domain) are redirected there or refused, never served with that host's origin. Before the claim
// the request's own origin stands in, because the claim has to happen somewhere.
//
// The claim: with no users and no CAIRN_SETUP_TOKEN, every route but the claim page answers "not
// claimed yet". The claim page writes a one-time code to the Worker's log (console.log: Worker →
// Logs, or `wrangler tail`); whoever enters it and registers a passkey becomes the admin.

import type { Env } from "./env";
import { sha256Hex } from "./vault/embed";

export const CLAIM_TTL_MS = 30 * 60e3;
/** Minimum gap between new claim codes (instance-wide). */
export const CLAIM_COOLDOWN_MS = 60e3;
/** Live codes kept at once: a stranger requesting codes can't push the owner's out for ~10 minutes. */
export const CLAIM_LIVE_MAX = 10;
const CACHE_MS = 30e3;

export type UrlSource = "env" | "db" | "request";

/** PUBLIC_URL as configured, normalised to an origin; null when unset or empty. */
export function configuredOrigin(env: Pick<Env, "PUBLIC_URL">): string | null {
  const v = (env.PUBLIC_URL ?? "").trim();
  if (!v) return null;
  try {
    return new URL(v).origin;
  } catch {
    return null;
  }
}

interface SiteRow {
  canonical: string | null;
  claimed: boolean;
}
let cache: { at: number; row: SiteRow } | null = null;

/** Forget the per-isolate cache (after a claim or a URL change, and in tests). */
export function resetSiteCache(): void {
  cache = null;
}

/** Recorded canonical origin and claim state. Claimed is cached (it never reverts); unclaimed is re-read. */
export async function loadSite(env: Env): Promise<SiteRow> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.row;
  const rows = await env.DB.prepare("SELECT key, value FROM site_settings WHERE key IN ('canonical_url', 'claimed_at')").all<{ key: string; value: string }>();
  const get = (k: string) => rows.results.find((r) => r.key === k)?.value ?? null;
  let claimed = !!get("claimed_at");
  if (!claimed) claimed = !!(await env.DB.prepare("SELECT 1 AS x FROM users LIMIT 1").first());
  const row = { canonical: get("canonical_url"), claimed };
  if (claimed) cache = { at: Date.now(), row };
  return row;
}

/** True while the site waits for its first admin's claim. */
export function claimOpen(env: Env, site: SiteRow): boolean {
  return !site.claimed && !env.CAIRN_SETUP_TOKEN;
}

export async function recordCanonical(env: Env, origin: string, overwrite = false): Promise<void> {
  const ts = new Date().toISOString();
  await env.DB.prepare(
    overwrite
      ? "INSERT INTO site_settings (key, value, updated_at) VALUES ('canonical_url', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      : "INSERT INTO site_settings (key, value, updated_at) VALUES ('canonical_url', ?, ?) ON CONFLICT(key) DO NOTHING",
  )
    .bind(origin, ts)
    .run();
  resetSiteCache();
}

/** Paths a not-yet-claimed site answers (the claim itself, health, static files). */
const OPEN_BEFORE_CLAIM = ["/claim", "/claim/new", "/auth/signup/options", "/auth/signup/verify", "/health"];
const STATIC_PREFIXES = ["/app/owg/", "/app/cairn/", "/app/dist/", "/app/viewer/", "/app/ui/", "/app/fonts/"];

export type Resolved = { env: Env; response?: undefined } | { env?: undefined; response: Response };

/**
 * Per request: the env every handler sees (PUBLIC_URL = the canonical origin, CAIRN_URL_SOURCE =
 * where it came from), or a response that ends the request (wrong host, or not claimed yet).
 */
export async function resolveSite(request: Request, env: Env): Promise<Resolved> {
  const url = new URL(request.url);
  const configured = configuredOrigin(env);
  if (configured) {
    // Configured: the same env object as before this existed (the OAuth provider sets
    // OAUTH_PROVIDER on it, and later handlers rely on that).
    env.PUBLIC_URL = configured;
    env.CAIRN_URL_SOURCE = "env";
    return { env };
  }

  const site = await loadSite(env);
  let canonical = site.canonical;
  if (!canonical && site.claimed) {
    // Claimed (a setup-token sign-up, or users from before this existed) but nothing recorded yet:
    // the hosts that reach this Worker are all the owner's; the first one used is kept.
    await recordCanonical(env, url.origin);
    canonical = (await loadSite(env)).canonical ?? url.origin;
  }
  if (canonical && canonical !== url.origin) {
    if (request.method === "GET" || request.method === "HEAD") {
      return { response: new Response(null, { status: 308, headers: { Location: `${canonical}${url.pathname}${url.search}` } }) };
    }
    return {
      response: Response.json({ error: "misdirected_request", error_description: `This Cairn lives at ${canonical}; send requests there.` }, { status: 421 }),
    };
  }
  const resolved: Env = { ...env, PUBLIC_URL: canonical ?? url.origin, CAIRN_URL_SOURCE: canonical ? "db" : "request" };
  if (claimOpen(env, site)) {
    const p = url.pathname;
    if (!OPEN_BEFORE_CLAIM.includes(p) && !STATIC_PREFIXES.some((s) => p.startsWith(s))) {
      if (request.method === "GET" || request.method === "HEAD") return { response: new Response(null, { status: 303, headers: { Location: "/claim" } }) };
      return {
        response: Response.json(
          { error: "not_claimed", error_description: "This Cairn hasn't been claimed yet. Open /claim in a browser." },
          { status: 503, headers: { "Retry-After": "60" } },
        ),
      };
    }
  }
  return { env: resolved };
}

/** For handlers without a request (email, cron): the configured or recorded origin, if any. */
export async function withCanonical(env: Env): Promise<Env> {
  const configured = configuredOrigin(env);
  if (configured) return { ...env, PUBLIC_URL: configured, CAIRN_URL_SOURCE: "env" };
  const site = await loadSite(env).catch(() => null);
  return site?.canonical ? { ...env, PUBLIC_URL: site.canonical, CAIRN_URL_SOURCE: "db" } : env;
}

// ---------------------------------------------------------------- claim codes

// Crockford base32 without the look-alikes: 10 characters ≈ 50 bits.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function normaliseClaimCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

const hashCode = (code: string) => sha256Hex(`claim:${normaliseClaimCode(code)}`);

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const s = [...bytes].map((b) => ALPHABET[b & 31]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Latest live code's creation time, or null. */
export async function liveClaimCode(env: Env): Promise<string | null> {
  const r = await env.DB.prepare("SELECT MAX(created_at) AS at FROM claim_codes WHERE expires_at > ?")
    .bind(new Date().toISOString())
    .first<{ at: string | null }>();
  return r?.at ?? null;
}

/**
 * Write a new claim code to the log. Refused (with the seconds to wait) within the cooldown of the
 * last one. Only the hash is stored.
 */
export async function issueClaimCode(env: Env, origin: string): Promise<{ ok: true; code: string } | { ok: false; retryAfter: number }> {
  const nowMs = Date.now();
  const last = await env.DB.prepare("SELECT MAX(created_at) AS at FROM claim_codes").first<{ at: string | null }>();
  if (last?.at && nowMs - Date.parse(last.at) < CLAIM_COOLDOWN_MS) {
    return { ok: false, retryAfter: Math.ceil((CLAIM_COOLDOWN_MS - (nowMs - Date.parse(last.at))) / 1000) };
  }
  const code = newCode();
  const ts = new Date(nowMs).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM claim_codes WHERE expires_at <= ?").bind(ts),
    env.DB.prepare(
      `DELETE FROM claim_codes WHERE code_hash IN (SELECT code_hash FROM claim_codes ORDER BY created_at DESC LIMIT -1 OFFSET ${CLAIM_LIVE_MAX - 1})`,
    ),
    env.DB.prepare("INSERT INTO claim_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").bind(
      await hashCode(code),
      ts,
      new Date(nowMs + CLAIM_TTL_MS).toISOString(),
    ),
  ]);
  // The one place the code appears: the Worker's log, which only the account owner can read.
  console.log(`Cairn claim code: ${code} (valid 30 minutes). Open ${origin}/claim, enter it and create your passkey to become this Cairn's admin.`);
  return { ok: true, code };
}

export async function claimCodeValid(env: Env, code: string): Promise<boolean> {
  if (!normaliseClaimCode(code)) return false;
  return !!(await env.DB.prepare("SELECT 1 AS x FROM claim_codes WHERE code_hash = ? AND expires_at > ?")
    .bind(await hashCode(code), new Date().toISOString())
    .first());
}

/**
 * Finish a claim: use up the code and take the one-time claimed_at lock. False if the code is no
 * longer live or the site was claimed meanwhile. The caller creates the admin, and calls
 * releaseClaim if that fails.
 */
export async function takeClaim(env: Env, code: string): Promise<boolean> {
  const ts = new Date().toISOString();
  const used = await env.DB.prepare("DELETE FROM claim_codes WHERE code_hash = ? AND expires_at > ? RETURNING code_hash")
    .bind(await hashCode(code), ts)
    .first();
  if (!used) return false;
  if (await env.DB.prepare("SELECT 1 AS x FROM users LIMIT 1").first()) return false;
  const lock = await env.DB.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('claimed_at', ?, ?) ON CONFLICT(key) DO NOTHING")
    .bind(ts, ts)
    .run();
  return (lock.meta.changes ?? 0) === 1;
}

export async function releaseClaim(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM site_settings WHERE key = 'claimed_at'").run();
  resetSiteCache();
}

export async function finishClaim(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM claim_codes").run();
  resetSiteCache();
}

/** A URL an admin may move the site to: an https origin (http only for localhost). */
export function parseSiteUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
  return u.origin;
}
