// Small DOM helpers shared by the viewer bundles.

export function currentProject(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="cairn-project"]')?.content ?? "";
}

type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

/** Create an element. Text children are set as text (never parsed as HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export interface TitleEntry {
  title: string;
  permalink: string;
  folder: string;
  type: string;
  href: string;
}

const titleCache = new Map<string, Promise<TitleEntry[]>>();

/** The project's note titles (ETag-revalidated by the browser cache). */
export function loadTitles(project: string): Promise<TitleEntry[]> {
  let p = titleCache.get(project);
  if (!p) {
    p = fetch(`/app/api/titles${project ? `?project=${encodeURIComponent(project)}` : ""}`, { cache: "no-cache", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : { notes: [] }))
      .then((j: { notes: TitleEntry[] }) => j.notes)
      .catch(() => []);
    titleCache.set(project, p);
  }
  return p;
}

/** Fuzzy match: every query character in order. Higher is better; -1 = no match. */
export function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx === 0) return 1000 - t.length;
  if (idx > 0) return 800 - idx - t.length / 10 + (/[\s/_-]/.test(t[idx - 1]) ? 100 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    score += found === prev + 1 ? 8 : 1;
    if (found === 0 || /[\s/_-]/.test(t[found - 1])) score += 5;
    prev = found;
    ti = found + 1;
  }
  return score - t.length / 20;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
