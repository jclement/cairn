// The note page: a reading column (rendered markdown) and a side panel (details, tags,
// outgoing links, backlinks, local graph, contents). Rendering is inert (see ../render.ts).

import type { Context, Hono } from "hono";
import { type AttachmentRow, fileUrl } from "../../capture/files";
import { canWriteVault, getVault, vaultRef, vaultStub } from "../../directory";
import type { SourceView } from "../../vault/do";
import { folderHref, type H, html, icon, layout, noteHref, raw, when } from "../layout";
import { type RenderInfo, renderMarkdown } from "../render";
import { noteTools } from "../round3";
import type { AppEnv } from "../types";
import { clientBadge, emptyState, shellOpts } from "../ui";
import { editUrl } from "./shared";

const TEXT_STATE: Record<string, string> = { done: "text read", pending: "text pending", failed: "text failed", none: "no text" };
/** Characters of a file's text the note page shows (the rest: the file itself, or read_note file=). */
const VIEW_TEXT_MAX = 200_000;

/** The files a note links: each with its text's state, a toggle to view the text, and a re-read button. */
function noteFiles(project: string, permalink: string, files: AttachmentRow[], texts: Map<string, SourceView>, canWrite: boolean): H {
  return html`<section class="note-files mt-8 rounded-2xl bg-sunken p-4 ring-1 ring-line" aria-label="Files">
    <h2 class="m-0 text-sm font-semibold text-fg">Files <span class="count">${String(files.length)}</span></h2>
    <ul class="m-0 mt-2 list-none p-0">${files.map((f) => {
      const t = texts.get(f.id);
      const state = f.extract_state ? (TEXT_STATE[f.extract_state] ?? f.extract_state) : "text not read yet";
      return html`<li class="mt-3">
        <p class="m-0 flex flex-wrap items-center gap-2 text-sm"><a class="inline-flex items-center gap-2 font-medium" href="${fileUrl(project, f.id)}">${icon("file", "size-4 shrink-0 text-muted")}${f.name}</a>
          <span class="text-xs text-muted">${f.mime} · ${String(Math.ceil(f.bytes / 1024))} KB</span>
          <span class="badge" data-extract="${f.extract_state ?? "never"}">${state}${f.extract_state === "done" && f.extract_pages ? html` · ${String(f.extract_pages)} p.` : ""}</span>
          ${
            canWrite && f.extract_state !== "done" && f.extract_state !== "pending"
              ? html`<form method="post" action="/app/files/extract" class="inline"><input type="hidden" name="project" value="${project}"><input type="hidden" name="id" value="${f.id}"><input type="hidden" name="back" value="${noteHref(project, permalink)}"><button class="btn btn-ghost btn-sm" type="submit">${icon("history", "size-4")}Read text again</button></form>`
              : ""
          }</p>
        ${f.extract_error && f.extract_state !== "done" ? html`<p class="m-0 mt-1 text-xs text-muted">${f.extract_error}</p>` : ""}
        ${
          t
            ? html`<details class="mt-1"><summary class="cursor-pointer text-xs text-muted">View extracted text (${t.label ?? "from the file"}${t.redactions ? `; ${t.redactions} secret(s) redacted` : ""})</summary>
              <pre class="m-0 mt-1 max-h-96 overflow-auto rounded-xl bg-surface p-3 text-sm whitespace-pre-wrap break-words">${t.text.length > VIEW_TEXT_MAX ? `${t.text.slice(0, VIEW_TEXT_MAX)}\n[… cut here]` : t.text}</pre></details>`
            : ""
        }
      </li>`;
    })}</ul>
  </section>`;
}

type C = Context<AppEnv>;

export function registerNotePage(app: Hono<AppEnv>) {
  const page = (c: C, title: string, body: H, extra: { vault?: string; scripts?: string[] } = {}) => layout({ title, body, ...shellOpts(c), ...extra });

  app.get("/app/v/:vault/n/*", async (c) => {
    const user = c.get("user");
    if (!user) {
      const u = new URL(c.req.url);
      return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`);
    }
    const v = await getVault(c.env, user.id, decodeURIComponent(c.req.param("vault")));
    if (!v) return c.html(page(c, "Not found", html`<h1>Not found</h1>`), 404);
    const marker = "/n/";
    const permalink = c.req.path
      .slice(c.req.path.indexOf(marker) + marker.length)
      .split("/")
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .join("/");
    const stub = vaultStub(c.env, v);
    const r = await stub.noteView(vaultRef(v), permalink);
    if (!r.ok) {
      return c.html(
        page(
          c,
          "Not found",
          html`<div class="card mt-4">${emptyState(
            "note",
            "Not found",
            html`No note <code>${permalink}</code> in ${v.name}.`,
            html`<a class="btn btn-primary" href="/app/new?project=${encodeURIComponent(v.name)}&title=${encodeURIComponent(permalink.split("/").pop() ?? "")}">${icon("plus", "size-4")}Create it</a>`,
          )}</div>`,
          { vault: v.name },
        ),
        404,
      );
    }
    const { note, content, observations, relations, backlinks, links } = r.value;
    // Original text the note was written from, apart from files' text (shown with the files below).
    const sources = r.value.sources.filter((x) => !x.attachment_id);
    const fileTexts = new Map(r.value.sources.filter((x) => x.attachment_id).map((x) => [x.attachment_id as string, x]));
    const fileIds = [...new Set([...content.matchAll(/\/app\/files\/[^/\s)"']+\/([a-z0-9]{12})/g)].map((m) => m[1]))].slice(0, 50);
    const files = fileIds.length
      ? (
          await c.env.DB.prepare(`SELECT * FROM attachments WHERE vault_id = ? AND state = 'ready' AND id IN (${fileIds.map(() => "?").join(",")})`)
            .bind(v.id, ...fileIds)
            .all<AttachmentRow>()
        ).results
      : [];
    const revs = await stub.revisions(vaultRef(v), note.permalink);
    const info: RenderInfo = { mermaid: false, headings: [] };
    const bodyHtml = renderMarkdown(content, { vault: v.name, links }, info);
    const parts = note.folder ? note.folder.split("/") : [];
    const toc = info.headings.filter((h) => h.level <= 3);
    const obsCats = [...observations.reduce((m, o) => m.set(o.category, (m.get(o.category) ?? 0) + 1), new Map<string, number>())];
    const scripts = ["/app/dist/graph.js", ...(info.mermaid ? ["/app/dist/mermaid.js"] : [])];
    const searchTag = (t: string) => `/app/search?project=${encodeURIComponent(v.name)}&tag=${encodeURIComponent(t)}`;

    return c.html(
      page(
        c,
        note.title,
        html`<nav class="crumbs" aria-label="Breadcrumb"><a href="${folderHref(v.name, "")}">${v.name}</a>${parts.map(
          (p, i) => html`<span aria-hidden="true">/</span><a href="${folderHref(v.name, parts.slice(0, i + 1).join("/"))}">${p}</a>`,
        )}</nav>
        <div class="note-layout">
          <article class="note">
            <header class="note-head">
              <h1>${note.title}</h1>
              <p class="note-meta">
                <span class="type-chip">${note.type}</span>
                <span class="text-sm text-muted">Updated <time datetime="${note.updated_at}">${when(note.updated_at)}</time> by ${clientBadge(note.updated_by_client ?? "?")}</span>
              </p>
              ${note.tags.length ? html`<p class="note-tags">${note.tags.map((t) => html`<a class="tag" href="${searchTag(t)}">${t}</a> `)}</p>` : ""}
              <div class="note-toolbar">
                ${canWriteVault(v) ? html`<a class="btn btn-primary btn-sm" href="${editUrl(v.name, note.permalink)}" accesskey="e">${icon("pencil", "size-4")}Edit</a>` : html`<span class="badge">read only</span>`}
                ${noteTools(v.name, note.permalink, note.pinned, canWriteVault(v))}
                <a class="btn btn-ghost btn-sm" href="/app/v/${encodeURIComponent(v.name)}/raw/${note.permalink.split("/").map(encodeURIComponent).join("/")}" title="Download the markdown file">${icon("code", "size-4")}.md</a>
              </div>
            </header>
            <div class="note-body prose">${raw(bodyHtml)}</div>
            ${
              sources.length
                ? html`<details class="note-sources mt-8 rounded-2xl bg-sunken p-4 ring-1 ring-line">
                  <summary class="cursor-pointer text-sm font-semibold text-fg">Original text <span class="count">${String(sources.length)}</span>
                    <span class="font-normal text-muted">: the words this note was written from, kept as they were</span></summary>
                  ${sources.map(
                    (x) => html`<section class="mt-4">
                      <p class="m-0 mb-1 text-xs text-muted"><time datetime="${x.created_at}">${when(x.created_at)}</time>${x.label ? html` · ${x.label}` : ""}${x.client ? html` · ${clientBadge(x.client)}` : ""}${x.redactions ? html` · ${String(x.redactions)} secret(s) redacted` : ""}</p>
                      <pre class="m-0 max-h-96 overflow-auto rounded-xl bg-surface p-3 text-sm whitespace-pre-wrap break-words">${x.text}</pre>
                    </section>`,
                  )}
                </details>`
                : ""
            }
            ${files.length ? noteFiles(v.name, note.permalink, files, fileTexts, canWriteVault(v)) : ""}
          </article>
          <div class="note-side" role="complementary" aria-label="About this note">
            ${
              toc.length >= 3
                ? html`<section class="side-card"><h2>On this page</h2><ol class="toc">${toc.map(
                    (h) => html`<li class="toc-${h.level}"><a href="#${h.id}">${h.text}</a></li>`,
                  )}</ol></section>`
                : ""
            }
            <section class="side-card">
              <h2>Links out <span class="count">${relations.length}</span></h2>
              ${
                relations.length
                  ? html`<ul class="side-links">${relations.map(
                      (rel) =>
                        html`<li><span class="rel-badge">${rel.type}</span> ${
                          rel.resolved
                            ? html`<a class="wikilink" href="${noteHref(v.name, rel.resolved.permalink)}">${rel.target}</a>`
                            : html`<a class="wikilink unresolved" href="/app/new?project=${encodeURIComponent(v.name)}&title=${encodeURIComponent(rel.target)}" title="No note yet: create it">${rel.target}</a>`
                        }</li>`,
                    )}</ul>`
                  : html`<p class="muted small">No links yet. Add <code>- relates_to [[Note]]</code>.</p>`
              }
            </section>
            <section class="side-card">
              <h2>Backlinks <span class="count">${backlinks.length}</span></h2>
              ${
                backlinks.length
                  ? html`<ul class="side-links">${backlinks.map(
                      (b) => html`<li><a href="${noteHref(v.name, b.permalink)}">${b.title}</a> <span class="muted small">${b.type}</span></li>`,
                    )}</ul>`
                  : html`<p class="muted small">Nothing links here yet.</p>`
              }
            </section>
            <section class="graph local side-card" data-graph="local" data-project="${v.name}" data-permalink="${note.permalink}" aria-label="Local graph"></section>
            ${
              obsCats.length
                ? html`<section class="side-card"><h2>Observations <span class="count">${observations.length}</span></h2>
                  <p>${obsCats.map(([cat, n]) => html`<span class="obs-chip" data-cat="${cat.toLowerCase()}">${cat} ${n > 1 ? html`<b>${n}</b>` : ""}</span> `)}</p></section>`
                : ""
            }
            <section class="side-card">
              <h2>Details</h2>
              <dl class="details">
                <dt>Permalink</dt><dd><code>${note.permalink}</code></dd>
                <dt>File</dt><dd><code>${note.file_path}</code></dd>
                <dt>Created</dt><dd>${when(note.created_at)}${note.created_by_client ? html` · ${note.created_by_client}` : ""}</dd>
                <dt>Updated</dt><dd>${when(note.updated_at)} · ${note.updated_by_client ?? "?"}</dd>
                <dt>Revisions</dt><dd>${revs.length >= 50 ? "50+" : String(revs.length)}</dd>
                <dt>Size</dt><dd>${note.bytes < 1024 ? `${note.bytes} B` : `${(note.bytes / 1024).toFixed(1)} KB`} · rev <code>${note.checksum.slice(0, 8)}</code></dd>
              </dl>
            </section>
          </div>
        </div>
        <dialog class="img-zoom" id="img-zoom" aria-label="Image"><form method="dialog"><button class="secondary" aria-label="Close">×</button></form><img alt=""></dialog>`,
        { vault: v.name, scripts },
      ),
    );
  });
}
