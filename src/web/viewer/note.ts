// The note page: a reading column (rendered markdown) and a side panel (details, tags,
// outgoing links, backlinks, local graph, contents). Rendering is inert (see ../render.ts).

import type { Context, Hono } from "hono";
import { canWriteVault, getVault, vaultRef, vaultStub } from "../../directory";
import { folderHref, type H, html, icon, layout, noteHref, raw, when } from "../layout";
import { type RenderInfo, renderMarkdown } from "../render";
import { noteTools } from "../round3";
import type { AppEnv } from "../types";
import { clientBadge, emptyState, shellOpts } from "../ui";
import { editUrl } from "./shared";

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
