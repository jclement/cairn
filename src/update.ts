// "Is there a newer Cairn?" for Settings → Admin. Asks GitHub (jclement/cairn) at most once a day,
// caches the answer in D1 (site_settings.update_check) and stays quiet when GitHub can't be reached.
// The running build is known from CAIRN_COMMIT / CAIRN_COMMIT_TIME (passed by scripts/deploy.mjs)
// and VERSION.

import { type Env, VERSION } from "./env";

export const UPSTREAM = "jclement/cairn";
const DAY_MS = 86400e3;
/** After a failed check, try again sooner than a day. */
const RETRY_MS = 3600e3;

export interface UpstreamInfo {
  at: number;
  ok: boolean;
  release?: string | null;
  mainSha?: string | null;
  mainTime?: number | null;
}

export interface UpdateStatus {
  version: string;
  commit: string | null;
  available: boolean;
  release: string | null;
  checkedAt: number | null;
  reason?: string;
}

function semverNewer(a: string, b: string): boolean {
  const p = (s: string) =>
    s
      .replace(/^v/i, "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** Pure: is `info` newer than this build? */
export function compareBuild(env: Pick<Env, "CAIRN_COMMIT" | "CAIRN_COMMIT_TIME">, info: UpstreamInfo | null): UpdateStatus {
  const commit = env.CAIRN_COMMIT || null;
  const base: UpdateStatus = { version: VERSION, commit, available: false, release: info?.release ?? null, checkedAt: info?.at ?? null };
  if (!info?.ok) return base;
  if (info.release && semverNewer(info.release, VERSION)) return { ...base, available: true, reason: `release ${info.release}` };
  const builtAt = Number(env.CAIRN_COMMIT_TIME) || 0;
  // A copy's own commits (merges of upstream) are never on upstream, so compare by time: upstream
  // main has a commit newer than the one this build was made from.
  if (info.mainSha && info.mainTime && builtAt && commit !== info.mainSha && !info.mainSha.startsWith(commit ?? "-") && info.mainTime > builtAt + 60) {
    return { ...base, available: true, reason: "newer commits on main" };
  }
  return base;
}

async function fetchUpstream(fetcher: typeof fetch): Promise<UpstreamInfo> {
  const get = async (path: string) => {
    const res = await fetcher(`https://api.github.com/repos/${UPSTREAM}${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "cairn-update-check" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const [rel, main] = await Promise.all([get("/releases/latest"), get("/commits/main")]);
  const commitObj = main?.commit as { committer?: { date?: string } } | undefined;
  return {
    at: Date.now(),
    ok: true,
    release: typeof rel?.tag_name === "string" ? rel.tag_name : null,
    mainSha: typeof main?.sha === "string" ? main.sha : null,
    mainTime: commitObj?.committer?.date ? Math.floor(Date.parse(commitObj.committer.date) / 1000) : null,
  };
}

/** Cached (daily) upstream lookup; never throws. */
export async function updateStatus(env: Env, fetcher: typeof fetch = fetch): Promise<UpdateStatus> {
  let info: UpstreamInfo | null = null;
  try {
    const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'update_check'").first<{ value: string }>();
    info = row ? (JSON.parse(row.value) as UpstreamInfo) : null;
  } catch {
    info = null;
  }
  if (env.CAIRN_UPDATE_CHECK === "off") return compareBuild(env, info);
  const stale = !info || Date.now() - info.at > (info.ok ? DAY_MS : RETRY_MS);
  if (stale) {
    let fresh: UpstreamInfo;
    try {
      fresh = await fetchUpstream(fetcher);
    } catch {
      // Offline or rate-limited: keep the last good answer, retry in an hour.
      fresh = { ...(info ?? {}), at: Date.now(), ok: info?.ok ?? false };
    }
    info = fresh;
    try {
      await env.DB.prepare(
        "INSERT INTO site_settings (key, value, updated_at) VALUES ('update_check', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
        .bind(JSON.stringify(fresh), new Date().toISOString())
        .run();
    } catch {
      // cache is best-effort
    }
  }
  return compareBuild(env, info);
}
