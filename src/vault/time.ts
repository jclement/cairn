// Edit-time windows ("since") as Basic Memory takes them: '7d', '24h', '3 days', '2 weeks ago',
// 'today', 'yesterday', 'last week', 'last month', or a date. Anything else is refused by the
// tools (rather than silently searching all time).

const UNIT_MS: Record<string, number> = {
  m: 60e3, // only as "min"/"minute" words; a bare "m" means months (Cairn's original grammar)
  h: 3600e3,
  d: 86400e3,
  w: 7 * 86400e3,
  mo: 30 * 86400e3,
  y: 365 * 86400e3,
};

function unitOf(word: string): number | null {
  const w = word.toLowerCase();
  if (/^(mins?|minutes?)$/.test(w)) return UNIT_MS.m;
  if (/^(h|hrs?|hours?)$/.test(w)) return UNIT_MS.h;
  if (/^(d|days?)$/.test(w)) return UNIT_MS.d;
  if (/^(w|wks?|weeks?)$/.test(w)) return UNIT_MS.w;
  if (/^(m|mos?|months?)$/.test(w)) return UNIT_MS.mo;
  if (/^(y|yrs?|years?)$/.test(w)) return UNIT_MS.y;
  return null;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** An instant as ISO, or undefined when it is out of Date's range (e.g. "99999999999 years"). */
function iso(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** ISO instant for a window, null for none (empty), undefined when it doesn't read as one. */
export function parseSince(since: string | null | undefined, nowMs = Date.now()): string | null | undefined {
  if (since === undefined || since === null || !since.trim()) return null;
  const s = since.trim().toLowerCase();
  if (s === "today") return new Date(startOfDay(nowMs)).toISOString();
  if (s === "yesterday") return new Date(startOfDay(nowMs) - UNIT_MS.d).toISOString();
  const last = /^(?:last|past)\s+(\w+)$/.exec(s);
  if (last) {
    const u = unitOf(last[1]);
    return u ? iso(nowMs - u) : undefined;
  }
  const rel = /^(\d+)\s*([a-z]+?)(?:\s+ago)?$/.exec(s);
  if (rel) {
    const u = unitOf(rel[2]);
    return u ? iso(nowMs - Number(rel[1]) * u) : undefined;
  }
  if (/^\d{4}-\d{2}(-\d{2})?([t ][\d:.]+(z|[+-]\d{2}:?\d{2})?)?$/i.test(s)) {
    return iso(new Date(since.trim()).getTime());
  }
  return undefined;
}

export const SINCE_HELP = "Use e.g. '7d', '24h', '3 days', '2 weeks ago', 'today', 'yesterday', 'last week' or a date (2026-10-01).";
