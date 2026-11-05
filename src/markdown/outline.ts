// A note's outline: its headings with the line each starts on and how many list items and table
// rows sit directly under it. Shown at the top of a whole-note read and with the top search hits, so
// an answer can see every section a note enumerates (decisions, things retired, steps) before it
// summarises. Pure and linear in the note's length.

export interface OutlineEntry {
  /** 1-based line in the whole file (frontmatter included), as read_note's start_line counts. */
  line: number;
  level: number;
  heading: string;
  /** List items (any depth) until the next heading. */
  items: number;
  /** Table body rows (header and separator rows not counted) until the next heading. */
  rows: number;
}

/** Most entries an outline carries; longer notes say how many headings were left out. */
export const OUTLINE_MAX = 40;

export function outlineOf(markdown: string): { entries: OutlineEntry[]; omitted: number } {
  const lines = markdown.split("\n");
  const entries: OutlineEntry[] = [];
  let i = 0;
  // Skip YAML frontmatter.
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (end > 0) i = end + 1;
  }
  let fence: string | null = null;
  let current: OutlineEntry | null = null;
  let tableLines = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) {
      fence = fence === null ? f[1] : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) {
      current = { line: i + 1, level: h[1].length, heading: h[2].trim(), items: 0, rows: 0 };
      entries.push(current);
      tableLines = 0;
      continue;
    }
    if (!current) continue;
    if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)) current.items++;
    if (/^\s*\|.*\|\s*$/.test(l)) {
      tableLines++;
      // The first table line is the header; a separator row (|---|) is not data.
      if (tableLines > 1 && !/^\s*\|[\s:|-]+\|\s*$/.test(l)) current.rows++;
    } else if (l.trim() === "") tableLines = 0;
  }
  return { entries: entries.slice(0, OUTLINE_MAX), omitted: Math.max(0, entries.length - OUTLINE_MAX) };
}

/** One line: "L12 ## Plan (6 items) · L30 ### Retire (2 items) · L41 ## Costs (table, 5 rows)". */
export function outlineLine(o: { entries: OutlineEntry[]; omitted: number }): string {
  const parts = o.entries.map((e) => {
    const what = [e.items ? `${e.items} item${e.items === 1 ? "" : "s"}` : "", e.rows ? `table, ${e.rows} row${e.rows === 1 ? "" : "s"}` : ""]
      .filter(Boolean)
      .join("; ");
    return `L${e.line} ${"#".repeat(e.level)} ${e.heading}${what ? ` (${what})` : ""}`;
  });
  if (o.omitted) parts.push(`+${o.omitted} more headings`);
  return parts.join(" · ");
}
