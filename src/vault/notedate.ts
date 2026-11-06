// A note's own date: when the thing it records happened, as distinct from when the row was written.
// Imported notes all carry their import time as created_at/updated_at, so only the note itself can
// say when it is from: a frontmatter date, or a date (or ISO week) in its title or path.

const DATE_KEYS = ["date", "created", "created_at", "day"] as const;
const YMD = /(?<![\d])(\d{4})-(\d{2})-(\d{2})(?![\d])/;
const ISO_WEEK = /(?<![\d])(\d{4})-w(\d{2})(?![\d])/i;

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? t.toISOString().slice(0, 10) : null;
}

function ymdIn(s: string): string | null {
  const m = YMD.exec(s);
  return m ? validYmd(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** Monday of ISO week `w` of `year` (YYYY-MM-DD), or null when the week doesn't exist. */
export function isoWeekMonday(year: number, w: number): string | null {
  if (w < 1 || w > 53) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7; // Monday = 0
  const monday = jan4 - dow * 86400e3 + (w - 1) * 7 * 86400e3;
  const d = new Date(monday);
  // Week 53 only exists in some years: it must still belong to `year` by its Thursday.
  if (new Date(monday + 3 * 86400e3).getUTCFullYear() !== year) return null;
  return d.toISOString().slice(0, 10);
}

export interface NoteDate {
  /** YYYY-MM-DD */
  date: string;
  /** Where it came from: a frontmatter key, the title or the path. */
  from: string;
  /** Set when the date is the Monday of an ISO week ("2026-W18"). */
  week?: string;
}

/**
 * The date a note is about: frontmatter date/created, else a YYYY-MM-DD or YYYY-Www in the title,
 * else in the permalink. Null when the note doesn't say (then only its write times are known).
 */
export function noteDate(n: { frontmatter?: string | Record<string, unknown> | null; title: string; permalink: string }): NoteDate | null {
  let fm: Record<string, unknown> = {};
  if (typeof n.frontmatter === "string") {
    try {
      fm = JSON.parse(n.frontmatter || "{}") as Record<string, unknown>;
    } catch {
      fm = {};
    }
  } else if (n.frontmatter) fm = n.frontmatter;
  for (const k of DATE_KEYS) {
    const v = fm[k];
    const s = v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;
    const d = s ? ymdIn(s) : null;
    if (d) return { date: d, from: k };
  }
  for (const [s, from] of [
    [n.title, "title"],
    [n.permalink.split("/").pop() ?? "", "path"],
  ] as const) {
    const d = ymdIn(s);
    if (d) return { date: d, from };
    const w = ISO_WEEK.exec(s);
    if (w) {
      const monday = isoWeekMonday(Number(w[1]), Number(w[2]));
      if (monday) return { date: monday, from, week: `${w[1]}-W${w[2]}` };
    }
  }
  return null;
}

/**
 * One short phrase for a result line: "dated 2026-07-15", "week 2026-W18 (from 2026-04-27)", plus
 * "edited 2026-11-05" when the note was changed on a later day than it was written. Empty when
 * there is nothing to say.
 */
export function dateLabel(n: {
  frontmatter?: string | Record<string, unknown> | null;
  title: string;
  permalink: string;
  created_at: string;
  updated_at: string;
}): string {
  const d = noteDate(n);
  const parts: string[] = [];
  if (d) parts.push(d.week ? `week ${d.week} (from ${d.date})` : `dated ${d.date}`);
  const edited = n.updated_at.slice(0, 10);
  if (edited > n.created_at.slice(0, 10)) parts.push(`edited ${edited}`);
  return parts.join(", ");
}

/**
 * Whether a note falls in a time window. A note with a date of its own (a daily note, a meeting)
 * is in it when that date is, or when it was edited inside it (since). A note without one is
 * placed by its write times for `since` (as Basic Memory) and kept for `until`: its date is
 * unknown, and an imported note's write time is only its import.
 * since: ISO instant; until: YYYY-MM-DD, inclusive.
 */
export function inWindow(
  n: { frontmatter?: string | Record<string, unknown> | null; title: string; permalink: string; created_at: string; updated_at: string },
  since: string | null,
  until: string | null,
): boolean {
  if (!since && !until) return true;
  const own = noteDate(n)?.date ?? null;
  if (since) {
    const day = since.slice(0, 10);
    const editedInside = n.updated_at >= since && n.updated_at.slice(0, 10) > n.created_at.slice(0, 10);
    if (own ? own < day && !editedInside : n.updated_at < since) return false;
  }
  if (until && own && own > until) return false;
  return true;
}
