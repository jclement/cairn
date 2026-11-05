// Helpers shared by the viewer's server routes and its browser bundles (no Worker or DOM APIs here).

/** Plain search terms from a query: drops tag:/type: filters, quotes and FTS operators. */
export function queryTerms(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/^[-+]|["()*^]/g, ""))
    .filter((t) => t && !/^(tag|type|in|path):/i.test(t) && !/^(AND|OR|NOT|NEAR)$/.test(t) && t.length > 1)
    .map((t) => t.toLowerCase());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** HTML-escape `text` and wrap every occurrence of a term in <mark>. Safe to insert as HTML. */
export function highlight(text: string, terms: string[]): string {
  if (!terms.length) return escapeHtml(text);
  const re = new RegExp(
    `(${[...terms]
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join("|")})`,
    "gi",
  );
  return text
    .split(re)
    .map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join("");
}

export function noteUrl(project: string, permalink: string): string {
  return `/app/v/${encodeURIComponent(project)}/n/${permalink.split("/").map(encodeURIComponent).join("/")}`;
}

export function editUrl(project: string, permalink: string): string {
  return `/app/v/${encodeURIComponent(project)}/edit/${permalink.split("/").map(encodeURIComponent).join("/")}`;
}

export interface ApiHit {
  title: string;
  permalink: string;
  href: string;
  type: string;
  tags: string[];
  updated_at: string;
  updated_by_client: string | null;
  score: number;
  /** A keyword hit (title, line or observation), not only a semantic neighbour. */
  strong: boolean;
  matches: { line: number; text: string }[];
  observations: { category: string; content: string; context: string | null }[];
}

export interface ApiSearch {
  project: string;
  q: string;
  total: number;
  has_more: boolean;
  modes_used: string[];
  strong: boolean;
  hits: ApiHit[];
  error?: string;
}

export const SINCE_OPTIONS: [string, string][] = [
  ["", "any time"],
  ["1d", "past day"],
  ["7d", "past week"],
  ["30d", "past month"],
  ["1y", "past year"],
];

/** Common observation categories and relation types, offered as editor hints. */
export const OBS_CATEGORIES = ["fact", "idea", "decision", "preference", "technique", "requirement", "question", "issue", "insight", "todo"];
export const RELATION_TYPES = [
  "relates_to",
  "implements",
  "requires",
  "extends",
  "part_of",
  "depends_on",
  "contrasts_with",
  "inspired_by",
  "supersedes",
  "see_also",
];
