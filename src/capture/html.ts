// HTML -> markdown for clipped pages and HTML-only emails.
//
// extractMain() trims a page to its likely content (article/main/body, minus nav, footers,
// scripts, forms). htmlToMarkdown() is a small, dependency-free converter for that HTML: good
// enough for articles and email bodies, deterministic for tests, and free; clipped HTML always
// uses it. PDFs convert through Workers AI's toMarkdown (aiToMarkdown), and only when a clip is
// saved. Output is markdown, which the viewer renders inertly.

import type { Env } from "../env";
import { spendAiBudget } from "../stats/budget";
import { recordAi } from "../stats/record";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlTitle(html: string): string {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const t = og?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  return decodeEntities(t.replace(/\s+/g, " ").trim()).slice(0, 200);
}

const DROP = ["script", "style", "noscript", "template", "svg", "iframe", "object", "nav", "footer", "aside", "form", "button", "select", "canvas", "head"];

export function extractMain(html: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of DROP) h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
  const pick = (tag: string) => {
    const all = [...h.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi"))].map((m) => m[1]);
    return all.sort((a, b) => b.length - a.length)[0];
  };
  return pick("article") ?? pick("main") ?? /<body[^>]*>([\s\S]*)<\/body>/i.exec(h)?.[1] ?? h;
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : null;
}

function absolute(href: string, base?: string): string | null {
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const NEVER_TEXT = ["script", "style", "noscript", "template", "head", "title", "svg", "iframe", "object"];

export function htmlToMarkdown(input: string, base?: string): string {
  let html = input.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of NEVER_TEXT) html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
  const out: string[][] = [[]];
  const push = (s: string) => out[out.length - 1].push(s);
  const lists: ("ul" | "ol")[] = [];
  const counters: number[] = [];
  const links: (string | null)[] = [];
  let pre = 0;
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[3] !== undefined) {
      const t = decodeEntities(m[3]);
      push(pre ? t : t.replace(/\s+/g, " "));
      continue;
    }
    const tag = m[1].toLowerCase();
    const close = m[0][1] === "/";
    const attrs = m[2] ?? "";
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        push(close ? "\n\n" : `\n\n${"#".repeat(Number(tag[1]))} `);
        break;
      case "p":
      case "div":
      case "section":
      case "article":
      case "main":
      case "header":
      case "figure":
      case "table":
      case "dl":
        push("\n\n");
        break;
      case "tr":
        push("\n");
        break;
      case "td":
      case "th":
        if (!close) push(" | ");
        break;
      case "br":
        push("  \n");
        break;
      case "hr":
        push("\n\n---\n\n");
        break;
      case "ul":
      case "ol":
        if (close) {
          lists.pop();
          counters.pop();
          push("\n\n");
        } else {
          lists.push(tag);
          counters.push(0);
        }
        break;
      case "li":
        if (!close) {
          const depth = Math.max(lists.length - 1, 0);
          const kind = lists[lists.length - 1] ?? "ul";
          counters[counters.length - 1] = (counters[counters.length - 1] ?? 0) + 1;
          push(`\n${"  ".repeat(depth)}${kind === "ol" ? `${counters[counters.length - 1]}.` : "-"} `);
        }
        break;
      case "strong":
      case "b":
        push("**");
        break;
      case "em":
      case "i":
        push("_");
        break;
      case "code":
        if (!pre) push("`");
        break;
      case "pre":
        if (close) {
          pre = Math.max(0, pre - 1);
          push("\n```\n\n");
        } else {
          pre++;
          push("\n\n```\n");
        }
        break;
      case "blockquote":
        if (close) {
          const inner = (out.pop() ?? []).join("").trim();
          push(
            `\n\n${inner
              .replace(/\n{3,}/g, "\n\n")
              .split("\n")
              .map((l) => `> ${l}`.trimEnd())
              .join("\n")}\n\n`,
          );
        } else out.push([]);
        break;
      case "a":
        if (close) {
          const href = links.pop();
          push(href ? `](${href})` : "");
        } else {
          const href = attr(attrs, "href");
          const abs = href && !href.startsWith("#") ? absolute(href, base) : null;
          links.push(abs);
          if (abs) push("[");
        }
        break;
      case "img": {
        const src = attr(attrs, "src");
        const abs = src ? absolute(src, base) : null;
        if (abs?.startsWith("http")) push(`![${(attr(attrs, "alt") ?? "").replace(/[[\]]/g, "")}](${abs})`);
        break;
      }
      default:
        break;
    }
  }
  while (out.length > 1) {
    const inner = out.pop() ?? [];
    out[out.length - 1].push(...inner);
  }
  // Tidy whitespace outside fenced code (odd segments of a split on ``` are code).
  return out[0]
    .join("")
    .split("```")
    .map((seg, i) =>
      i % 2
        ? seg
        : seg
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+(?=[^\s-\d])/g, "\n")
            .replace(/\[\s*\]\([^)]*\)/g, "")
            .replace(/\n{3,}/g, "\n\n"),
    )
    .join("```")
    .trim();
}

type ToMarkdown = { toMarkdown(files: { name: string; blob: Blob }[]): Promise<{ data?: string; format?: string; tokens?: number }[]> };

/** Workers AI document conversion (HTML, PDF, …). Null when unavailable or it fails. */
/** Per-isolate cap on conversions running at once for one user (a best-effort concurrency limit). */
const converting = new Map<string, number>();
export const CONVERT_LIMITS = { perUser: 2, timeoutMs: 20_000 };

/**
 * Workers AI document conversion (used for PDFs, on Save only). Admitted against the user's daily
 * AI budget (estimated from the size), limited to CONVERT_LIMITS.perUser at once, and abandoned
 * after CONVERT_LIMITS.timeoutMs. Null when refused, unavailable or failed: callers fall back to
 * keeping just the file.
 */
export async function aiToMarkdown(env: Env, userId: string, name: string, bytes: Uint8Array, mime: string): Promise<string | null> {
  // Take the slot synchronously, before any await, so concurrent calls can't all pass the check.
  if ((converting.get(userId) ?? 0) >= CONVERT_LIMITS.perUser) return null;
  converting.set(userId, (converting.get(userId) ?? 0) + 1);
  try {
    return await convert(env, userId, name, bytes, mime);
  } finally {
    const n = (converting.get(userId) ?? 1) - 1;
    if (n > 0) converting.set(userId, n);
    else converting.delete(userId);
  }
}

/** Number of conversions this isolate is running for a user (tests). */
export function convertingNow(userId: string): number {
  return converting.get(userId) ?? 0;
}

async function convert(env: Env, userId: string, name: string, bytes: Uint8Array, mime: string): Promise<string | null> {
  const estimate = Math.min(Math.ceil(bytes.byteLength / 8), 200_000);
  if (env.CAIRN_FAKE_CAPTURE_AI !== "1") {
    const ai = env.AI as unknown as Partial<ToMarkdown> | undefined;
    if (!ai?.toMarkdown) return null;
  }
  if (!(await spendAiBudget(env, userId, estimate).catch(() => false))) return null;
  const started = Date.now();
  let ok = false;
  let out: string | null = null;
  let tokens = 0;
  try {
    if (env.CAIRN_FAKE_CAPTURE_AI === "1") {
      out = `(converted ${name})`;
      ok = true;
    } else {
      // The 20 s race bounds this request; it does not cancel the conversion itself.
      const ai = env.AI as unknown as ToMarkdown;
      const run = ai.toMarkdown([{ name, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }) }]);
      const [r] = (await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), CONVERT_LIMITS.timeoutMs))])) as Awaited<
        ReturnType<ToMarkdown["toMarkdown"]>
      >;
      if (r?.format === "markdown" && r.data) {
        out = r.data;
        tokens = r.tokens ?? 0;
        ok = true;
      }
    }
  } catch {
    out = null;
  }
  await recordAi(env.DB, {
    userId,
    model: "toMarkdown",
    purpose: "to_markdown",
    ok,
    latencyMs: Date.now() - started,
    inputTokens: tokens || estimate,
    outputTokens: 0,
    estimated: !tokens,
  }).catch(() => {});
  return out;
}
