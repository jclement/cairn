// Basic Memory-compatible note parsing. The markdown bytes are the authority; everything here is
// a projection rebuilt on every write. Written from Basic Memory's NOTE-FORMAT documentation (as
// summarised in docs/research/basic-memory.md), not from its AGPL source.

import { isMap, isNode, isScalar, parseDocument, stringify } from "yaml";

export interface Observation {
  category: string;
  content: string;
  tags: string[];
  context: string | null;
  line: number; // 1-based line in the full document
  /** Nearest heading above the line ("" if none). */
  section: string;
  /** From the context: "since YYYY-MM-DD", "until YYYY-MM-DD", "expires YYYY-MM-DD". */
  validFrom: string | null;
  validTo: string | null;
  expires: string | null;
  /** Under a "Superseded" heading. */
  superseded: boolean;
  /** Basic Memory authored-time qualifier (`@due:2026-10-20`, `@effective[2026-06-10,)`): kind and [start, end). */
  timeKind: TimeKind | null;
  timeStart: string | null;
  timeEnd: string | null;
}

export const TIME_KINDS = ["valid", "effective", "occurred", "due", "mentioned"] as const;
export type TimeKind = (typeof TIME_KINDS)[number];

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * One authored date as a [start, end) span of calendar days, following Basic Memory's note
 * format: a year or a month covers that span; a day point runs from that day onward (end null).
 * Relative words ("yesterday", "March") are not dates. Returns null when it doesn't read as one.
 */
export function readAuthoredPoint(token: string): { start: string; end: string | null } | null {
  const t = token.trim();
  let m = /^(\d{4})$/.exec(t);
  if (m) return { start: `${m[1]}-01-01`, end: `${Number(m[1]) + 1}-01-01` };
  m = /^(\d{4})-(\d{2})$/.exec(t);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return { start: `${m[1]}-${m[2]}-01`, end: mo === 12 ? `${y + 1}-01-01` : `${m[1]}-${pad2(mo + 1)}-01` };
  }
  m = /^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(t);
  if (m) return Number.isNaN(Date.parse(m[1])) ? null : { start: m[1], end: null };
  // Quoted long forms ("June 10, 2026", "June 2026"): only absolute dates with a 4-digit year.
  if (/\b\d{4}\b/.test(t) && /[a-z]/i.test(t)) {
    const d = new Date(`${t} UTC`);
    if (Number.isNaN(d.getTime())) return null;
    const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    if (/^\s*[a-z]+\s+\d{4}\s*$/i.test(t)) return readAuthoredPoint(day.slice(0, 7));
    return { start: day, end: null };
  }
  return null;
}

const QUALIFIER_RE = /(?:^|\s)@(?:(valid|effective|occurred|due|mentioned)(?=[:[]))?:?(?:\[([^,\]\s]*)\s*,\s*([^)\]\s]*)\)|"([^"\n]+)"|([^\s"[\]]+))/gi;

/**
 * The first authored-time qualifier in an observation's text, as Basic Memory writes them:
 * `@due:2026-10-20`, `@2026-06` (kind valid), `@effective[2026-06-10,2026-10-14)`, `@occurred:"June 10, 2026"`.
 * An @-mention or a relative date ("@occurred:yesterday") is not a qualifier and stays plain text.
 */
export function parseQualifier(text: string): { kind: TimeKind; start: string | null; end: string | null; ranged: boolean; raw: string; index: number } | null {
  for (const m of text.matchAll(QUALIFIER_RE)) {
    const kind = (m[1] ?? "valid").toLowerCase() as TimeKind;
    const raw = m[0].trimStart();
    const index = (m.index ?? 0) + (m[0].length - raw.length);
    if (m[2] !== undefined || m[3] !== undefined) {
      const a = m[2] ? readAuthoredPoint(m[2]) : null;
      const b = m[3] ? readAuthoredPoint(m[3]) : null;
      if ((m[2] && !a) || (m[3] && !b) || (!a && !b)) continue;
      return { kind, start: a?.start ?? null, end: b?.start ?? null, ranged: true, raw, index };
    }
    const p = readAuthoredPoint(m[4] ?? m[5] ?? "");
    if (p) return { kind, start: p.start, end: p.end, ranged: false, raw, index };
  }
  return null;
}

/** The text without its authored-time qualifier. */
export function stripQualifier(text: string): string {
  const q = parseQualifier(text);
  if (!q) return text;
  return `${text.slice(0, q.index)}${text.slice(q.index + q.raw.length)}`.replace(/\s{2,}/g, " ").trim();
}

/** Write an authored range back as text: `@kind[start,end)` (either end may be open). */
export function formatQualifier(kind: TimeKind, start: string | null, end: string | null): string {
  if (start && !end) return `@${kind}:${start}`;
  return `@${kind}[${start ?? ""},${end ?? ""})`;
}

const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

/** Parse Cairn's small temporal grammar out of an observation's (context). */
export function parseTemporal(context: string | null): { validFrom: string | null; validTo: string | null; expires: string | null } {
  const out = { validFrom: null as string | null, validTo: null as string | null, expires: null as string | null };
  if (!context) return out;
  for (const part of context.split(/[;,]/)) {
    const p = part.trim().toLowerCase();
    const d = DATE.exec(p)?.[1] ?? null;
    if (!d) continue;
    if (/^(since|from)\b/.test(p)) out.validFrom = d;
    else if (/^(until|till|to)\b/.test(p)) out.validTo = d;
    else if (/^(expires|expiry|expiring)\b/.test(p)) out.expires = d;
    else if (/\u2192|->/.test(p)) {
      const ds = p.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
      out.validFrom ??= ds[0] ?? null;
      out.validTo ??= ds[1] ?? null;
    }
  }
  return out;
}

export interface Relation {
  type: string;
  target: string; // the author's text inside [[...]] (before any |alias)
  context: string | null;
  line: number;
}

export interface Section {
  heading: string;
  level: number;
  line: number; // 1-based line of the heading
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  body: string; // markdown after the frontmatter block
  bodyStartLine: number; // 1-based line where body starts
  title: string | null;
  type: string;
  tags: string[];
  permalink: string | null; // from frontmatter, project prefix stripped
  observations: Observation[];
  relations: Relation[];
  sections: Section[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(markdown: string): {
  raw: string | null;
  data: Record<string, unknown>;
  body: string;
  bodyStartLine: number;
} {
  const m = FRONTMATTER_RE.exec(markdown);
  if (!m) return { raw: null, data: {}, body: markdown, bodyStartLine: 1 };
  let data: Record<string, unknown> = {};
  try {
    const doc = parseDocument(m[1], { merge: false, uniqueKeys: false });
    const js = doc.toJS();
    if (js && typeof js === "object" && !Array.isArray(js)) data = js as Record<string, unknown>;
  } catch {
    data = {};
  }
  const consumed = m[0];
  const bodyStartLine = consumed.split("\n").length - (consumed.endsWith("\n") ? 0 : 1);
  return { raw: m[1], data, body: markdown.slice(consumed.length), bodyStartLine };
}

export function normaliseTags(value: unknown): string[] {
  let list: string[] = [];
  if (Array.isArray(value)) list = value.map((v) => String(v));
  else if (typeof value === "string") list = value.split(",");
  return [...new Set(list.map((t) => t.trim().replace(/^#/, "")).filter(Boolean))];
}

export function normaliseType(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "note";
  return toSnake(value);
}

export function toSnake(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .replace(/[^\p{L}\p{N}_]/gu, "")
    .toLowerCase();
}

/** URL/permalink slug: lower-case, ASCII-folded, non-alphanumerics to '-'. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function normaliseFolder(folder: string | null | undefined): string {
  if (!folder) return "";
  return folder
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .join("/");
}

/** Project-relative permalink for a folder + title. */
export function permalinkFor(folder: string, title: string): string {
  const parts = normaliseFolder(folder).split("/").filter(Boolean).map(slugify).filter(Boolean);
  const leaf = slugify(title) || "untitled";
  return [...parts, leaf].join("/");
}

/** Strip a leading `<project>/` from a permalink that Basic Memory wrote into frontmatter. */
export function stripProjectPrefix(permalink: string, project: string): string {
  const p = permalink.replace(/^\/+|\/+$/g, "");
  const prefix = `${slugify(project)}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** A filename-safe version of a title (keeps spaces and case, like Basic Memory's files). */
export function fileNameFor(title: string): string {
  const cleaned = [...title]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? "-" : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return `${cleaned || "untitled"}.md`;
}

const CHECKBOX_RE = /^\s*[-*+]\s+\[[ xX-]\]\s/;
const OBS_RE = /^\s*[-*+]\s+\[([^\]\n]+)\](?!\()\s+(.+?)\s*$/;
// A relation line: "- relation_type [[Target]] (context)". The type is at most three words;
// a longer lead-in is prose and yields an inline links_to instead.
const REL_RE = /^\s*[-*+]\s+(?:([\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+){0,2})\s+)?\[\[([^\]\n]+)\]\](?:\s+\(([^)]*)\))?\s*$/u;
const BULLET_RE = /^\s*[-*+]\s+(.+?)\s*$/;
const TAG_RE = /(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const WIKI_RE = /\[\[([^\]\n]+)\]\]/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

function timeOf(content: string, context: string | null) {
  const q = parseQualifier(content);
  const t = parseTemporal(context);
  if (q && (q.kind === "valid" || q.kind === "effective")) {
    t.validFrom ??= q.start;
    // Only an explicit range ends a fact's validity; a point (even a month) says when it started.
    if (q.ranged && q.end) t.validTo ??= q.end;
  }
  return { ...t, timeKind: q?.kind ?? null, timeStart: q?.start ?? null, timeEnd: q?.end ?? null };
}

/** A relative markdown link to a note (`[x](../people/Dana.md)`): its project-relative path without `.md`. */
export function mdLinkTarget(href: string, folder: string): string | null {
  let h = href.trim().replace(/^<|>$/g, "");
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("/") || h.startsWith("#")) return null;
  h = h.replace(/[?#].*$/, "");
  if (!/\.md$/i.test(h)) return null;
  try {
    h = decodeURIComponent(h);
  } catch {
    return null;
  }
  const out = folder ? folder.split("/").filter(Boolean) : [];
  for (const seg of h.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  const path = out.join("/").replace(/\.md$/i, "");
  return path || null;
}

const MD_LINK_RE = /(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function extractTags(text: string): string[] {
  const tags: string[] = [];
  for (const m of text.matchAll(TAG_RE)) tags.push(m[2]);
  return [...new Set(tags)];
}

/** Split a trailing "(context)" group off an observation, respecting nesting. */
export function splitContext(text: string): { content: string; context: string | null } {
  if (!text.endsWith(")")) return { content: text, context: null };
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) {
        // must be preceded by whitespace, otherwise it's part of the text e.g. "f(x)"
        if (i === 0 || !/\s/.test(text[i - 1])) return { content: text, context: null };
        const content = text.slice(0, i).trim();
        if (!content) return { content: text, context: null };
        return { content, context: text.slice(i + 1, -1).trim() || null };
      }
    }
  }
  return { content: text, context: null };
}

export function wikiTarget(inner: string): string {
  const pipe = inner.indexOf("|");
  return (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
}

export function parseNote(markdown: string, project = "", folder = ""): ParsedNote {
  const fm = splitFrontmatter(markdown);
  const lines = fm.body.split("\n");
  const observations: Observation[] = [];
  const relations: Relation[] = [];
  const sections: Section[] = [];
  let inFence = false;
  let fenceMarker = "";
  let section = "";

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const lineNo = fm.bodyStartLine + i;
    const fence = FENCE_RE.exec(raw);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (fence[1] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const h = HEADING_RE.exec(raw);
    if (h) {
      sections.push({ heading: h[2], level: h[1].length, line: lineNo });
      section = h[2].trim();
      continue;
    }

    const lineNoCode = raw.replace(/`[^`]*`/g, "");

    if (!CHECKBOX_RE.test(raw)) {
      const rel = REL_RE.exec(lineNoCode);
      if (rel) {
        relations.push({
          type: rel[1] ? toSnake(rel[1]) : "relates_to",
          target: wikiTarget(rel[2]),
          context: rel[3]?.trim() || null,
          line: lineNo,
        });
        continue;
      }
      const obs = OBS_RE.exec(lineNoCode);
      if (obs) {
        const { content, context } = splitContext(obs[2]);
        const time = timeOf(content, context);
        observations.push({
          category: obs[1].trim(),
          // As Basic Memory: the qualifier is indexed as time, not kept in the fact's text.
          content: time.timeKind ? stripQualifier(content) : content,
          tags: extractTags(content),
          context,
          line: lineNo,
          section,
          ...time,
          superseded: /^superseded$/i.test(section),
        });
        for (const w of content.matchAll(WIKI_RE)) {
          relations.push({ type: "links_to", target: wikiTarget(w[1]), context: null, line: lineNo });
        }
        for (const l of content.matchAll(MD_LINK_RE)) {
          const target = mdLinkTarget(l[1], folder);
          if (target) relations.push({ type: "links_to", target, context: null, line: lineNo });
        }
        continue;
      }
      const bullet = BULLET_RE.exec(lineNoCode);
      if (bullet && !/^\[[^\]]*\]\(/.test(bullet[1])) {
        const tags = extractTags(bullet[1]);
        if (tags.length) {
          const { content, context } = splitContext(bullet[1]);
          const time = timeOf(content, context);
          observations.push({
            category: "Note",
            content: time.timeKind ? stripQualifier(content) : content,
            tags,
            context,
            line: lineNo,
            section,
            ...time,
            superseded: /^superseded$/i.test(section),
          });
        }
      }
    }

    for (const w of lineNoCode.matchAll(WIKI_RE)) {
      relations.push({ type: "links_to", target: wikiTarget(w[1]), context: null, line: lineNo });
    }
    for (const l of lineNoCode.matchAll(MD_LINK_RE)) {
      const target = mdLinkTarget(l[1], folder);
      if (target) relations.push({ type: "links_to", target, context: null, line: lineNo });
    }
  }

  const data = fm.data;
  const fmPermalink = typeof data.permalink === "string" && data.permalink.trim() ? stripProjectPrefix(data.permalink, project) : null;
  return {
    frontmatter: data,
    hasFrontmatter: fm.raw !== null,
    body: fm.body,
    bodyStartLine: fm.bodyStartLine,
    title: typeof data.title === "string" && data.title.trim() ? data.title.trim() : data.title != null ? String(data.title) : null,
    type: normaliseType(data.type),
    tags: normaliseTags(data.tags),
    permalink: fmPermalink,
    observations,
    relations,
    sections,
  };
}

/** Serialise a frontmatter object + body back to markdown. */
export function composeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter).filter((k) => frontmatter[k] !== undefined);
  if (!keys.length) return body;
  const ordered: Record<string, unknown> = {};
  for (const k of ["title", "type", "permalink", "tags"]) if (k in frontmatter && frontmatter[k] !== undefined) ordered[k] = frontmatter[k];
  for (const k of keys) if (!(k in ordered)) ordered[k] = frontmatter[k];
  const yaml = stringify(ordered, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Set a note's frontmatter to `desired`, touching only the keys that change: each changed key's
 * text is replaced in place, removed keys lose their lines, new keys are added (title and type at
 * the top, others at the end). Comments, order, quoting and every untouched byte stay as written.
 * Falls back to rewriting the block when the YAML can't be edited safely (not a plain mapping,
 * parse errors), or when the spliced text wouldn't read back as `desired`.
 */
export function setFrontmatter(markdown: string, desired: Record<string, unknown>): string {
  const fm = splitFrontmatter(markdown);
  const want: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(desired)) if (v !== undefined) want[k] = v;
  if (fm.raw === null) return Object.keys(want).length ? composeMarkdown(want, markdown) : markdown;
  const current = fm.data;
  const changed = Object.keys(want).filter((k) => !(k in current) || !sameValue(current[k], want[k]));
  const removed = Object.keys(current).filter((k) => !(k in want));
  if (!changed.length && !removed.length) return markdown;
  const rawStart = markdown.indexOf("\n") + 1;
  const raw = fm.raw;
  const rawEnd = rawStart + raw.length;
  const rewrite = () => composeMarkdown(want, fm.body);
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(raw, { merge: false, uniqueKeys: false });
  } catch {
    return rewrite();
  }
  if (doc.errors.length || !isMap(doc.contents)) return rewrite();
  const pairs = new Map<string, { start: number; valueEnd: number; lineEnd: number }>();
  for (const p of doc.contents.items) {
    const key = isScalar(p.key) ? String(p.key.value) : null;
    const kr = isNode(p.key) ? p.key.range : null;
    if (key === null || !kr || pairs.has(key)) return rewrite(); // complex or duplicate keys
    const vr = isNode(p.value) ? p.value.range : null;
    pairs.set(key, { start: kr[0], valueEnd: vr ? vr[1] : kr[1], lineEnd: vr ? vr[2] : kr[2] });
  }
  const one = (k: string) => stringify({ [k]: want[k] }, { lineWidth: 0 }).trimEnd();
  const edits: { from: number; to: number; text: string }[] = [];
  for (const k of changed) {
    const at = pairs.get(k);
    // Replace the key through its value; a trailing comment on that line is kept.
    if (at) edits.push({ from: at.start, to: at.valueEnd, text: one(k) });
  }
  for (const k of removed) {
    const at = pairs.get(k);
    if (!at) return rewrite();
    const lineStart = raw.lastIndexOf("\n", at.start - 1) + 1;
    edits.push({ from: lineStart, to: Math.max(at.lineEnd, at.valueEnd), text: "" });
  }
  const added = changed.filter((k) => !pairs.has(k));
  const top = ["title", "type"].filter((k) => added.includes(k));
  const tail = added.filter((k) => !top.includes(k));
  if (top.length) edits.push({ from: 0, to: 0, text: `${top.map(one).join("\n")}\n` });
  if (tail.length) edits.push({ from: raw.length, to: raw.length, text: `${raw.endsWith("\n") || !raw.length ? "" : "\n"}${tail.map(one).join("\n")}` });
  edits.sort((a, b) => b.from - a.from || b.to - a.to);
  let out = raw;
  for (const e of edits) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  out = out.replace(/\n+$/, raw.endsWith("\n") ? "\n" : "");
  const result = markdown.slice(0, rawStart) + out + markdown.slice(rawEnd);
  const back = splitFrontmatter(result);
  if (back.raw === null || back.body !== fm.body || !sameValue(sortKeys(back.data), sortKeys(want))) return rewrite();
  return result;
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
}

export interface SectionRange {
  start: number; // 0-based index into body lines of the heading line
  end: number; // exclusive
  level: number;
}

/**
 * Find a section in a body by heading name. Supports "Parent/Child" paths and "Name[1]"
 * (0-based occurrence: the second "Name") like Basic Memory. Matching is case-insensitive and ignores leading #.
 */
export function findSection(body: string, path: string): SectionRange | null {
  const lines = body.split("\n");
  const heads: { idx: number; level: number; text: string }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = HEADING_RE.exec(lines[i]);
    if (h) heads.push({ idx: i, level: h[1].length, text: h[2].trim().toLowerCase() });
  }
  const parts = path
    .replace(/^#+\s*/, "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  let lo = 0;
  let hi = lines.length;
  let parentLevel = 0;
  let found: SectionRange | null = null;
  for (const part of parts) {
    const m = /^(.*?)\[(\d+)\]$/.exec(part);
    const name = (m ? m[1] : part)
      .replace(/^#+\s*/, "")
      .trim()
      .toLowerCase();
    // "Name[1]" is the second heading called Name: Basic Memory counts from 0.
    let nth = m ? Number(m[2]) + 1 : 1;
    found = null;
    for (let k = 0; k < heads.length; k++) {
      const hd = heads[k];
      if (hd.idx < lo || hd.idx >= hi || hd.level <= parentLevel) continue;
      if (hd.text !== name) continue;
      if (--nth > 0) continue;
      let end = hi;
      for (let j = k + 1; j < heads.length; j++) {
        if (heads[j].idx >= hi) break;
        if (heads[j].level <= hd.level) {
          end = heads[j].idx;
          break;
        }
      }
      found = { start: hd.idx, end, level: hd.level };
      break;
    }
    if (!found) return null;
    lo = found.start + 1;
    hi = found.end;
    parentLevel = found.level;
  }
  return found;
}

/** Text chunks for embedding: one per observation/bullet, headers split prose, ~900 chars max. */
export function chunkNote(title: string, body: string): { kind: "observation" | "prose"; text: string }[] {
  const chunks: { kind: "observation" | "prose"; text: string }[] = [];
  let buf: string[] = [];
  let heading = "";
  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text) return;
    for (let i = 0; i < text.length; i += 900) {
      chunks.push({ kind: "prose", text: `${title}${heading ? ` / ${heading}` : ""}\n${text.slice(i, i + 900)}` });
    }
  };
  for (const line of body.split("\n")) {
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      heading = h[2];
      continue;
    }
    const b = BULLET_RE.exec(line);
    if (b) {
      flush();
      chunks.push({ kind: "observation", text: `${title}: ${b[1]}` });
      continue;
    }
    buf.push(line);
    if (buf.join("\n").length > 900) flush();
  }
  flush();
  return chunks;
}
