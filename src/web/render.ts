// Markdown -> HTML for the viewer (server) and the editor preview (browser). Notes are written by
// users *and agents*, so rendering must be inert: raw HTML is disabled (escaped), and
// validateLink refuses javascript:, vbscript:, file: and non-image data: URLs.
//
// GFM: tables, strikethrough, autolinks (markdown-it core), task lists, footnotes, heading
// anchors, Obsidian callouts (> [!note]). [[Wiki Links]] become internal links (unresolved ones
// offer to create the note). Code is highlighted here with highlight.js, which emits classes
// (themed in CSS for light/dark): Shiki emits inline style attributes, which the app's CSP
// (style-src 'self', no 'unsafe-inline') would drop. ```mermaid fences render as escaped source
// in a <pre class="mermaid-src">; /app/dist/mermaid.js turns them into diagrams client-side.

import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import { splitFrontmatter, wikiTarget } from "../markdown/parse";
import { highlightCode } from "./highlight.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const SAFE_PROTOCOL = /^(https?:|mailto:|memory:|#|\/(?!\/)|\.{0,2}\/|[^:/?#]*(?:[/?#]|$))/i;

const CALLOUTS: Record<string, string> = {
  note: "Note",
  info: "Info",
  tip: "Tip",
  hint: "Tip",
  important: "Important",
  success: "Success",
  check: "Success",
  done: "Done",
  question: "Question",
  faq: "Question",
  warning: "Warning",
  caution: "Caution",
  attention: "Warning",
  danger: "Danger",
  error: "Error",
  bug: "Bug",
  failure: "Failure",
  example: "Example",
  quote: "Quote",
  abstract: "Summary",
  summary: "Summary",
  todo: "To do",
};

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "section"
  );
}

export function noteHrefFor(vault: string, permalink: string): string {
  return `/app/v/${encodeURIComponent(vault)}/n/${permalink.split("/").map(encodeURIComponent).join("/")}`;
}

export interface RenderInfo {
  /** The body contains a ```mermaid fence (load the mermaid bundle). */
  mermaid: boolean;
  /** Headings, for a table of contents. */
  headings: { level: number; text: string; id: string }[];
}

export function renderMarkdown(markdown: string, opts: { vault: string; links: Record<string, string | null> }, info?: RenderInfo): string {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
    highlight: (code, lang) => highlightCode(code, lang),
  });
  md.use(footnote);
  const defaultValidate = md.validateLink.bind(md);
  md.validateLink = (url: string) => defaultValidate(url) && SAFE_PROTOCOL.test(url.trim());

  // [[Wiki Links]]
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner.trim() || inner.includes("\n") || inner.includes("[")) return false;
    if (!silent) {
      const target = wikiTarget(inner);
      const pipe = inner.indexOf("|");
      const label = pipe >= 0 ? inner.slice(pipe + 1).trim() || target : target;
      const permalink = opts.links[target] ?? null;
      const open = state.push("wikilink_open", "a", 1);
      if (permalink) {
        open.attrSet("href", noteHrefFor(opts.vault, permalink));
        open.attrSet("class", "wikilink");
      } else {
        open.attrSet("href", `/app/new?project=${encodeURIComponent(opts.vault)}&title=${encodeURIComponent(target)}`);
        open.attrSet("class", "wikilink unresolved");
        open.attrSet("title", "No note with this title yet: click to create it");
      }
      const t = state.push("text", "", 0);
      t.content = label;
      state.push("wikilink_close", "a", -1);
    }
    state.pos = end + 2;
    return true;
  });

  // Task lists: "- [ ] x" / "- [x] x" -> disabled checkboxes. (Not "- [category] x": that is an observation.)
  md.core.ruler.after("inline", "task_lists", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inl = tokens[i];
      if (inl.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
      const first = inl.children?.[0];
      if (first?.type !== "text") continue;
      // Observations ("- [category] text") and relations ("- type [[Target]]") get chips/badges.
      const obs = /^\[([^\]\s][^\]]*)\] /.exec(first.content);
      if (obs && !/^[ xX]$/.test(obs[1])) {
        first.content = first.content.slice(obs[0].length);
        const chip = new state.Token("html_inline", "", 0);
        chip.content = `<span class="obs-chip" data-cat="${escapeHtml(obs[1].toLowerCase())}">${escapeHtml(obs[1])}</span> `;
        inl.children?.unshift(chip);
        tokens[i - 2].attrJoin("class", "obs-item");
        continue;
      }
      const rel = /^([A-Za-z][\w-]*(?: [\w-]+){0,2}) $/.exec(first.content);
      if (rel && inl.children?.[1]?.type === "wikilink_open") {
        first.content = "";
        const badge = new state.Token("html_inline", "", 0);
        badge.content = `<span class="rel-badge">${escapeHtml(rel[1])}</span> `;
        inl.children?.unshift(badge);
        tokens[i - 2].attrJoin("class", "rel-item");
        continue;
      }
      const m = /^\[([ xX])\] /.exec(first.content);
      if (!m) continue;
      first.content = first.content.slice(4);
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" class="task" disabled${m[1] === " " ? "" : " checked"} aria-label="${m[1] === " " ? "to do" : "done"}"> `;
      inl.children?.unshift(box);
      tokens[i - 2].attrJoin("class", "task-item");
      for (let j = i - 3; j >= 0; j--) {
        if (tokens[j].type === "bullet_list_open" || tokens[j].type === "ordered_list_open") {
          if (tokens[j].level === tokens[i - 2].level - 1) {
            tokens[j].attrSet("class", "task-list");
            break;
          }
        }
      }
    }
  });

  // Callouts: a blockquote whose first line is [!type] Optional title
  md.core.ruler.after("task_lists", "callouts", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "blockquote_open") continue;
      const inl = tokens[i + 2];
      if (tokens[i + 1]?.type !== "paragraph_open" || inl?.type !== "inline") continue;
      const m = /^\[!([a-z]+)\]([+-]?)[ \t]*([^\n]*)(\n|$)/i.exec(inl.content);
      if (!m) continue;
      const kind = m[1].toLowerCase();
      const known = CALLOUTS[kind] ? kind : "note";
      tokens[i].attrSet("class", `callout callout-${known}`);
      tokens[i].attrSet("data-callout", known);
      const title = m[3].trim() || CALLOUTS[kind] || kind;
      // Drop the marker line from the paragraph's inline children (up to the first softbreak).
      const kids = inl.children ?? [];
      const br = kids.findIndex((k) => k.type === "softbreak");
      const rest = br >= 0 ? kids.slice(br + 1) : [];
      const head = new state.Token("html_inline", "", 0);
      head.content = `<span class="callout-title">${escapeHtml(title)}</span>`;
      inl.children = rest.length ? [head, new state.Token("softbreak", "br", 0), ...rest] : [head];
    }
  });

  // Heading ids + anchor links
  md.core.ruler.push("anchors", (state) => {
    const used = new Map<string, number>();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "heading_open") continue;
      const text = tokens[i + 1]?.children?.map((c) => (c.type === "text" || c.type === "code_inline" ? c.content : "")).join("") ?? "";
      let id = slug(text);
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      tokens[i].attrSet("id", id);
      info?.headings.push({ level: Number(tokens[i].tag.slice(1)), text, id });
      const a = new state.Token("html_inline", "", 0);
      a.content = `<a class="anchor" href="#${escapeHtml(id)}" aria-hidden="true" tabindex="-1">#</a>`;
      tokens[i + 1]?.children?.push(a);
    }
  });

  // Fences: mermaid -> source placeholder; others -> highlighted with a language label.
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const tok = tokens[idx];
    const lang = tok.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "mermaid") {
      if (info) info.mermaid = true;
      return `<figure class="mermaid-block"><pre class="mermaid-src"><code>${escapeHtml(tok.content)}</code></pre></figure>\n`;
    }
    const out = defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
    return `<div class="code-block">${label}${out.replace("<pre><code", '<pre><code tabindex="0"').replace(/class="language-/, 'class="hljs language-')}</div>`;
  };

  // Images: lazy, async decode, zoomable.
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet("loading", "lazy");
    tokens[idx].attrSet("decoding", "async");
    tokens[idx].attrSet("class", "zoomable");
    return defaultImage ? defaultImage(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };

  // Links: external open safely in a new tab; memory:// resolves to the note page.
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const tok = tokens[idx];
    const href = String(tok.attrGet("href") ?? "");
    if (/^https?:/i.test(href)) {
      tok.attrSet("rel", "noopener noreferrer nofollow");
      tok.attrSet("target", "_blank");
      tok.attrJoin("class", "external");
    } else if (/^memory:\/\//i.test(href)) {
      let path = href.replace(/^memory:\/\//i, "").replace(/^\/+|\/+$/g, "");
      if (path.startsWith(`${opts.vault}/`)) path = path.slice(opts.vault.length + 1);
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        // keep as written
      }
      tok.attrSet("href", noteHrefFor(opts.vault, decoded));
      tok.attrJoin("class", "wikilink");
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  const { body } = splitFrontmatter(markdown);
  return md.render(body);
}
