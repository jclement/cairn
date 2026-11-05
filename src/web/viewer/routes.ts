// The viewer's search, editor and graph: JSON APIs under /app/api/* and the pages that use them.
// Mounted by createApp() after its session, CSRF (Origin) and recovery-session middleware, so
// every POST here has already passed the same-origin check.

import type { Context, Hono } from "hono";
import {
  canWriteVault,
  createSession,
  createUser,
  getUserByName,
  getVault,
  listVaults,
  sessionCookie,
  type User,
  type Vault,
  vaultRef,
  vaultStub,
} from "../../directory";
import type { Caller } from "../../env";
import { setFrontmatter, splitFrontmatter } from "../../markdown/parse";
import type { SearchArgs } from "../../vault/do";
import { folderHref, type H, html, icon, layout, noteHref, raw, when } from "../layout";
import { safeNext } from "../next";
import type { AppEnv } from "../types";
import { pageHeader, shellOpts } from "../ui";
import { registerNotePage } from "./note";
import { type ApiHit, type ApiSearch, editUrl, highlight, noteUrl, queryTerms, SINCE_OPTIONS } from "./shared";

type C = Context<AppEnv>;

const SINCE_RE = /^\d{1,4}[hdwmy]$/i;
const clip = (s: string | undefined, n = 200) => (s ?? "").trim().slice(0, n);

export function registerViewer(app: Hono<AppEnv>) {
  registerNotePage(app);
  const page = (c: C, title: string, body: H, extra: { vault?: string; q?: string; scripts?: string[] } = {}) =>
    layout({ title, body, ...shellOpts(c), ...extra });

  const loginRedirect = (c: C) => {
    const u = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`);
  };
  const unauthorized = (c: C) => c.json({ error: "Sign in first." }, 401);
  const READ_ONLY = "You have read-only access to this project (reader).";
  const readOnlyPage = (c: C, v: Vault) =>
    c.html(page(c, "Read only", html`<h1>Read only</h1><p class="error">${READ_ONLY} Ask its owner for editor access.</p>`, { vault: v.name }), 403);

  /** The named project (vault) if the user has it; else their default; null if named but not theirs. */
  async function pickVault(c: C, user: User, name: string | undefined): Promise<{ vault: Vault | null; vaults: Vault[] }> {
    const vaults = await listVaults(c.env, user.id);
    if (name) return { vault: vaults.find((v) => v.name === name) ?? null, vaults };
    return { vault: vaults.find((v) => v.is_default) ?? vaults[0] ?? null, vaults };
  }

  const webCaller = (user: User, tool: string): Caller => ({ userId: user.id, username: user.username, client: "web", tool });

  async function writeLimited(c: C, user: User): Promise<boolean> {
    if (!c.env.RL_WRITE) return false;
    const { success } = await c.env.RL_WRITE.limit({ key: `write:${user.id}` });
    return !success;
  }

  // ---------------------------------------------------------------- search

  interface Filters {
    q: string;
    type: string;
    tag: string;
    folder: string;
    since: string;
  }

  const readFilters = (c: C): Filters => ({
    q: clip(c.req.query("q"), 500),
    type: clip(c.req.query("type"), 64),
    tag: clip(c.req.query("tag"), 64).replace(/^#/, ""),
    folder: clip(c.req.query("folder"), 300).replace(/^\/+|\/+$/g, ""),
    since: SINCE_RE.test(c.req.query("since") ?? "") ? (c.req.query("since") as string) : "",
  });

  async function runSearch(c: C, v: Vault, f: Filters, pageSize = 30): Promise<ApiSearch> {
    const base = { project: v.name, q: f.q, total: 0, has_more: false, modes_used: [] as string[], strong: false, hits: [] as ApiHit[] };
    const hasFilter = !!(f.type || f.tag || f.folder || f.since);
    if (!f.q && !hasFilter) return base;
    const stub = vaultStub(c.env, v);
    const terms = queryTerms(f.q);
    if (!f.q) {
      // Filters only: list matching notes, most recently updated first.
      const { notes } = await stub.catalog(vaultRef(v));
      const sinceIso = f.since ? sinceToIso(f.since) : "";
      const rows = notes
        .filter(
          (n) =>
            (!f.type || n.type === f.type) &&
            (!f.tag || n.tags.some((t) => t.toLowerCase() === f.tag.toLowerCase())) &&
            (!f.folder || n.folder === f.folder || n.folder.startsWith(`${f.folder}/`)) &&
            (!sinceIso || n.updated_at >= sinceIso),
        )
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return {
        ...base,
        total: rows.length,
        has_more: rows.length > pageSize,
        modes_used: ["filter"],
        strong: rows.length > 0,
        hits: rows.slice(0, pageSize).map((n) => ({
          title: n.title,
          permalink: n.permalink,
          href: noteUrl(v.name, n.permalink),
          type: n.type,
          tags: n.tags,
          updated_at: n.updated_at,
          updated_by_client: null,
          score: 0,
          strong: true,
          matches: [],
          observations: [],
        })),
      };
    }
    const args: SearchArgs = { query: f.q, page_size: pageSize };
    if (f.type) args.note_types = [f.type];
    if (f.tag) args.tags = [f.tag];
    if (f.folder) args.path = f.folder;
    if (f.since) args.since = f.since;
    const r = await stub.search(vaultRef(v), args);
    if (!r.ok) return { ...base, error: r.message };
    const hits: ApiHit[] = r.value.hits.map((h) => {
      const titleHit = terms.some((t) => h.title.toLowerCase().includes(t));
      return {
        title: h.title,
        permalink: h.permalink,
        href: noteUrl(v.name, h.permalink),
        type: h.type,
        tags: h.tags,
        updated_at: h.updated_at,
        updated_by_client: h.updated_by_client,
        score: h.score,
        strong: titleHit || h.matches.length > 0 || h.observations.length > 0,
        matches: h.matches,
        // An observation is also a body line: don't show it twice.
        observations: h.observations.filter((o) => !h.matches.some((m) => m.text.includes(o.content))),
      };
    });
    return {
      ...base,
      total: r.value.total,
      has_more: r.value.has_more,
      modes_used: r.value.modes_used,
      strong: hits.some((h) => h.strong),
      hits,
    };
  }

  app.get("/app/api/search", async (c) => {
    const user = c.get("user");
    if (!user) return unauthorized(c);
    const { vault } = await pickVault(c, user, c.req.query("project"));
    if (!vault) return c.json({ error: "No such project." }, 404);
    const res = await runSearch(c, vault, readFilters(c), Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 50));
    return c.json(res, res.error ? 400 : 200, { "Cache-Control": "private, no-store" });
  });

  const renderHit = (h: ApiHit, terms: string[]) =>
    html`<li class="hit${h.strong ? "" : " weak"}" data-href="${h.href}">
      <a class="hit-title" href="${h.href}">${raw(highlight(h.title, terms))}</a>
      <span class="muted small">${h.permalink} · ${h.type}${h.updated_at ? ` · ${when(h.updated_at)}` : ""}</span>
      ${h.matches.map((m) => html`<div class="hit-line small"><span class="faint">L${m.line}</span> ${raw(highlight(m.text, terms))}</div>`)}
      ${h.observations.map((o) => html`<div class="hit-line small"><span class="obs-cat">[${o.category}]</span> ${raw(highlight(o.content, terms))}</div>`)}
      ${h.tags.length ? html`<div class="small">${h.tags.map((t) => html`<span class="tag">${t}</span> `)}</div>` : ""}
    </li>`;

  app.get("/app/search", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const f = readFilters(c);
    const projectName = c.req.query("project") ?? c.req.query("v");
    const { vault: v, vaults } = await pickVault(c, user, projectName);
    if (!v) return c.html(page(c, "Search", html`<h1>Search</h1><p class="error">No such project.</p>`), 404);
    const { notes } = await vaultStub(c.env, v).catalog(vaultRef(v));
    const types = [...new Set(notes.map((n) => n.type))].sort();
    const tags = [...new Set(notes.flatMap((n) => n.tags))].sort();
    const folders = [...new Set(notes.map((n) => n.folder).filter(Boolean))].sort();
    const res = await runSearch(c, v, f);
    const terms = queryTerms(f.q);
    const opt = (value: string, label: string, sel: string) => html`<option value="${value}" ${value === sel ? "selected" : ""}>${label}</option>`;
    const results = res.error
      ? html`<p class="error">${res.error}</p>`
      : !f.q && !(f.type || f.tag || f.folder || f.since)
        ? html`<p class="muted" data-state="idle">Type to search ${v.name}: titles, text and observations, by keyword and by meaning. <kbd>Ctrl</kbd> <kbd>K</kbd> jumps to a note from anywhere.</p>`
        : res.hits.length
          ? html`${res.strong ? "" : html`<p class="card warn small" data-state="weak">No strong match. These notes are only loosely related (by meaning).</p>`}
            <ol class="plain hits" id="hits" role="listbox" aria-label="Results">${res.hits.map((h) => renderHit(h, terms))}</ol>`
          : html`<p class="muted" data-state="empty">No matches${f.q ? html` for “${f.q}”` : ""}${f.type || f.tag || f.folder || f.since ? " with these filters" : ""}.
              <a href="/app/new?project=${encodeURIComponent(v.name)}${f.q ? `&title=${encodeURIComponent(f.q)}` : ""}">Create a note</a>?</p>`;
    return c.html(
      page(
        c,
        f.q ? `Search: ${f.q}` : "Search",
        html`${pageHeader("Search", html`Titles, text and observations in <strong class="text-fg">${v.name}</strong>, by keyword and by meaning.`)}
        <form method="get" action="/app/search" class="search-form" id="search-form" role="search">
          <div class="search-row">
            <input type="search" name="q" value="${f.q}" aria-label="Search query" placeholder="Search notes, observations, #tags" autocomplete="off" autofocus id="search-q"
              aria-controls="hits" aria-describedby="search-count">
            <button type="submit" class="btn btn-primary h-11 px-5">${icon("search", "size-4")}<span class="hidden sm:inline">Search</span><span class="sr-only sm:hidden">Search</span></button>
          </div>
          <div class="chips" role="group" aria-label="Filters">
            <label class="chip">project <select name="project">${vaults.map((x) => opt(x.name, x.name, v.name))}</select></label>
            <label class="chip">type <select name="type">${opt("", "any", f.type)}${types.map((t) => opt(t, t, f.type))}</select></label>
            <label class="chip">tag <select name="tag">${opt("", "any", f.tag)}${tags.map((t) => opt(t, `#${t}`, f.tag))}</select></label>
            <label class="chip">folder <select name="folder">${opt("", "anywhere", f.folder)}${folders.map((t) => opt(t, t, f.folder))}</select></label>
            <label class="chip">updated <select name="since">${SINCE_OPTIONS.map(([val, label]) => opt(val, label, f.since))}</select></label>
          </div>
        </form>
        <p class="muted small" id="search-count" aria-live="polite">${
          f.q || res.total ? html`${res.total} result${res.total === 1 ? "" : "s"}${res.modes_used.length ? html` · ${res.modes_used.join(" + ")}` : ""}` : ""
        }</p>
        <div id="results">${results}</div>`,
        { vault: v.name, q: f.q, scripts: ["/app/dist/search.js"] },
      ),
    );
  });

  // ---------------------------------------------------------------- titles + graph

  app.get("/app/api/titles", async (c) => {
    const user = c.get("user");
    if (!user) return unauthorized(c);
    const { vault } = await pickVault(c, user, c.req.query("project"));
    if (!vault) return c.json({ error: "No such project." }, 404);
    const cat = await vaultStub(c.env, vault).catalog(vaultRef(vault));
    const etag = `W/"t-${vault.id}-${cat.version}"`;
    const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie" };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    return c.json(
      {
        project: vault.name,
        version: cat.version,
        notes: cat.notes.map((n) => ({ title: n.title, permalink: n.permalink, folder: n.folder, type: n.type, href: noteUrl(vault.name, n.permalink) })),
      },
      200,
      headers,
    );
  });

  app.get("/app/api/graph", async (c) => {
    const user = c.get("user");
    if (!user) return unauthorized(c);
    const { vault } = await pickVault(c, user, c.req.query("project"));
    if (!vault) return c.json({ error: "No such project." }, 404);
    const inm = c.req.header("if-none-match") ?? "";
    const prefix = `W/"g-${vault.id}-`;
    const known = inm.startsWith(prefix) ? inm.slice(prefix.length, -1) : undefined;
    const g = await vaultStub(c.env, vault).graph(vaultRef(vault), { ifVersion: known });
    const headers = { ETag: `${prefix}${g.version}"`, "Cache-Control": "private, no-cache", Vary: "Cookie" };
    if (g.notModified) return c.body(null, 304, headers);
    return c.json({ project: vault.name, version: g.version, nodes: g.nodes, edges: g.edges }, 200, headers);
  });

  app.get("/app/graph", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const { vault: v, vaults } = await pickVault(c, user, c.req.query("project") ?? c.req.query("v"));
    if (!v) return c.html(page(c, "Graph", html`<h1>Graph</h1><p class="error">No such project.</p>`), 404);
    return c.html(
      page(
        c,
        `Graph · ${v.name}`,
        html`${pageHeader(
          "Graph",
          "How your notes link to each other. Drag to move, scroll to zoom, click a note to open it.",
          html`<form method="get" action="/app/graph" class="m-0"><label class="chip">project
            <select name="project" data-autosubmit>${vaults.map((x) => html`<option value="${x.name}" ${x.id === v.id ? "selected" : ""}>${x.name}</option>`)}</select></label>
            <noscript><button type="submit" class="btn btn-secondary btn-sm">Go</button></noscript></form>`,
        )}
        <section class="graph" data-graph="global" data-project="${v.name}" aria-label="Graph of notes in ${v.name}">
          <noscript><p class="card">The graph needs JavaScript. <a href="${folderHref(v.name, "")}">Browse ${v.name}</a> or <a href="/app/search?project=${encodeURIComponent(v.name)}">search</a> instead.</p></noscript>
        </section>`,
        { vault: v.name, scripts: ["/app/dist/graph.js"] },
      ),
    );
  });

  // ---------------------------------------------------------------- editor

  const editorPage = (
    c: C,
    v: Vault,
    opts: { permalink?: string; title: string; folder: string; content: string; checksum: string; error?: string; status?: number },
  ) => {
    const isNew = !opts.permalink;
    const heading = isNew ? "New note" : `Edit ${opts.title}`;
    return c.html(
      page(
        c,
        heading,
        html`<div class="crumbs"><a href="${folderHref(v.name, "")}">${v.name}</a>${
          opts.permalink ? html`<span aria-hidden="true">/</span><a href="${noteHref(v.name, opts.permalink)}">${opts.title}</a>` : ""
        }</div>
        <form method="post" action="/app/editor/save" class="editor" id="editor-form" data-project="${v.name}" data-permalink="${opts.permalink ?? ""}">
          <div class="editor-bar">
            <h1>${heading}</h1>
            <span class="editor-status muted small" id="editor-status" aria-live="polite"></span>
            <span class="editor-actions">
              <button type="button" class="btn btn-secondary" id="editor-attach" hidden title="Attach files (or drop/paste them into the editor)">${icon("clip", "size-4")}Attach</button>
              <input type="file" id="editor-file" multiple hidden>
              <button type="button" class="btn btn-secondary editor-toggle" id="editor-toggle" hidden aria-pressed="false">Preview</button>
              ${opts.permalink ? html`<a class="btn btn-ghost" href="${noteHref(v.name, opts.permalink)}">Cancel</a>` : ""}
              <button type="submit" class="btn btn-primary" id="editor-save" title="Save (Ctrl/Cmd-S)">Save</button>
            </span>
          </div>
          ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
          <input type="hidden" name="project" value="${v.name}">
          <input type="hidden" name="permalink" value="${opts.permalink ?? ""}">
          <input type="hidden" name="expected_checksum" value="${opts.checksum}">
          <div class="editor-meta">
            <label>Title <input name="title" type="text" value="${opts.title}" maxlength="200" ${isNew ? "required" : ""} ${isNew ? "autofocus" : ""}
              placeholder="${isNew ? "Note title" : "(from frontmatter)"}"></label>
            <label>Folder <input name="folder" type="text" value="${opts.folder}" maxlength="300" placeholder="(top level)" list="folder-list"></label>
          </div>
          <div class="editor-panes" id="editor-panes">
            <div class="editor-pane"><label for="editor-text" class="sr-only">Markdown</label>
              <textarea name="content" id="editor-text" rows="24" spellcheck="true">${opts.content}</textarea></div>
            <div class="editor-preview note-body" id="editor-preview" aria-label="Preview" hidden></div>
          </div>
          <p class="muted small">Markdown. <code>- [category] text</code> is an observation, <code>- relation_type [[Note]]</code> a relation; type <code>[[</code> to link a note. Drop or paste files to attach them (10 MB each).</p>
        </form>
        ${
          opts.permalink
            ? html`<details class="danger-zone"><summary>${icon("trash", "size-4")}Delete this note…</summary>
              <form method="post" action="/app/editor/delete" id="delete-form">
                <input type="hidden" name="project" value="${v.name}"><input type="hidden" name="permalink" value="${opts.permalink}">
                <input type="hidden" name="expected_checksum" value="${opts.checksum}">
                <p class="small">It goes to the project's trash (kept as a revision) and its links become unresolved.</p>
                <button class="btn btn-danger" type="submit">Delete ${opts.title}</button></form></details>`
            : ""
        }
        <dialog id="conflict-dialog" aria-labelledby="conflict-title">
          <h2 id="conflict-title">Someone else changed this note</h2>
          <p class="small">It was saved by <strong id="conflict-who">another client</strong> after you opened it. Their version:</p>
          <pre id="conflict-theirs" class="conflict-theirs"></pre>
          <p class="editor-actions">
            <button type="button" class="btn btn-secondary" data-conflict="theirs">Discard mine, load theirs</button>
            <button type="button" class="btn btn-danger" data-conflict="mine">Overwrite with mine</button>
            <button type="button" class="btn btn-ghost" data-conflict="cancel">Keep editing</button>
          </p>
        </dialog>`,
        { vault: v.name, scripts: ["/app/dist/editor.js"] },
      ),
      (opts.status ?? 200) as 200,
    );
  };

  app.get("/app/new", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const { vault: v } = await pickVault(c, user, c.req.query("project") ?? c.req.query("v"));
    if (!v) return c.html(page(c, "New note", html`<p class="error">No such project.</p>`), 404);
    if (!canWriteVault(v)) return readOnlyPage(c, v);
    return editorPage(c, v, { title: clip(c.req.query("title")), folder: clip(c.req.query("folder"), 300), content: "", checksum: "" });
  });

  app.get("/app/v/:vault/edit/*", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const v = await getVault(c.env, user.id, decodeURIComponent(c.req.param("vault")));
    if (!v) return c.html(page(c, "Not found", html`<h1>Not found</h1>`), 404);
    if (!canWriteVault(v)) return readOnlyPage(c, v);
    const marker = "/edit/";
    const permalink = c.req.path
      .slice(c.req.path.indexOf(marker) + marker.length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const r = await vaultStub(c.env, v).readNote(vaultRef(v), { identifier: permalink });
    if (!r.ok || r.value.content === null) return c.html(page(c, "Not found", html`<h1>Not found</h1>`, { vault: v.name }), 404);
    const n = r.value.note;
    return editorPage(c, v, { permalink: n.permalink, title: n.title, folder: n.folder, content: r.value.content, checksum: n.checksum });
  });

  interface SaveInput {
    project?: string;
    permalink?: string;
    title?: string;
    folder?: string;
    content?: string;
    expected_checksum?: string;
  }

  type SaveOutcome =
    | { ok: true; status: 200 | 201; body: Record<string, unknown> }
    | { ok: false; status: 400 | 401 | 403 | 404 | 409 | 413 | 429; body: Record<string, unknown> };

  async function save(c: C, user: User, input: SaveInput): Promise<SaveOutcome> {
    const { vault: v } = await pickVault(c, user, input.project || undefined);
    if (!v) return { ok: false, status: 404, body: { error: "No such project.", code: "NOT_FOUND" } };
    if (!canWriteVault(v)) return { ok: false, status: 403, body: { error: READ_ONLY, code: "FORBIDDEN" } };
    if (typeof input.content !== "string") return { ok: false, status: 400, body: { error: "content is required.", code: "INVALID" } };
    if (await writeLimited(c, user)) return { ok: false, status: 429, body: { error: "Too many writes. Wait a minute.", code: "RATE_LIMITED" } };
    const stub = vaultStub(c.env, v);
    const ref = vaultRef(v);
    const folder = input.folder?.trim();
    const title = input.title?.trim() || undefined;
    let content = input.content.replace(/\r\n/g, "\n");
    if (title && input.permalink) {
      // The Title field wins over a frontmatter title (writeNote prefers frontmatter), so renaming works either way.
      const fm = splitFrontmatter(content);
      if (typeof fm.data.title === "string" && fm.data.title.trim() !== title) content = setFrontmatter(content, { ...fm.data, title });
    }
    const r = input.permalink
      ? await stub.writeNote(ref, webCaller(user, "web_edit"), {
          identifier: input.permalink,
          content,
          title,
          directory: folder,
          // Without a checksum the browser had no base revision: refuse rather than clobber.
          expected_checksum: input.expected_checksum || "missing",
        })
      : await stub.writeNote(ref, webCaller(user, "web_create"), { title, directory: folder ?? "", content });
    if (!r.ok) {
      if (r.code === "REVISION_CONFLICT" && input.permalink) {
        const cur = await stub.readNote(ref, { identifier: input.permalink });
        return {
          ok: false,
          status: 409,
          body: {
            error: "This note changed since you opened it.",
            code: r.code,
            current: cur.ok
              ? {
                  content: cur.value.content,
                  checksum: cur.value.note.checksum,
                  updated_at: cur.value.note.updated_at,
                  updated_by_client: cur.value.note.updated_by_client,
                }
              : null,
          },
        };
      }
      const status = r.code === "NOT_FOUND" ? 404 : r.code === "ALREADY_EXISTS" ? 409 : r.code === "TOO_LARGE" || r.code === "QUOTA" ? 413 : 400;
      return { ok: false, status, body: { error: r.message, code: r.code } };
    }
    const n = r.value.note;
    const stored = await stub.readNote(ref, { identifier: n.permalink });
    return {
      ok: true,
      status: r.value.created ? 201 : 200,
      body: {
        ok: true,
        created: r.value.created,
        note: { title: n.title, permalink: n.permalink, folder: n.folder, checksum: n.checksum, updated_at: n.updated_at },
        // As stored (writeNote normalises frontmatter), so the editor can adopt it.
        content: stored.ok ? stored.value.content : null,
        href: noteUrl(v.name, n.permalink),
        edit_href: editUrl(v.name, n.permalink),
        unresolved: r.value.unresolved,
        similar: r.value.similar.map((s) => ({ ...s, href: noteUrl(v.name, s.permalink) })),
      },
    };
  }

  app.post("/app/api/notes", async (c) => {
    const user = c.get("user");
    if (!user) return unauthorized(c);
    let input: SaveInput;
    try {
      input = (await c.req.json()) as SaveInput;
    } catch {
      return c.json({ error: "Send JSON.", code: "INVALID" }, 400);
    }
    const out = await save(c, user, input);
    return c.json(out.body, out.status);
  });

  app.post("/app/api/notes/delete", async (c) => {
    const user = c.get("user");
    if (!user) return unauthorized(c);
    const input = (await c.req.json().catch(() => ({}))) as SaveInput;
    const { vault: v } = await pickVault(c, user, input.project || undefined);
    if (!v || !input.permalink) return c.json({ error: "No such note.", code: "NOT_FOUND" }, 404);
    if (!canWriteVault(v)) return c.json({ error: READ_ONLY, code: "FORBIDDEN" }, 403);
    if (await writeLimited(c, user)) return c.json({ error: "Too many writes. Wait a minute.", code: "RATE_LIMITED" }, 429);
    // Deletes are always checksum-guarded: without the revision the user saw, refuse.
    if (!input.expected_checksum) return c.json({ error: "Reload the note before deleting it (no revision given).", code: "REVISION_CONFLICT" }, 409);
    const r = await vaultStub(c.env, v).deleteNote(vaultRef(v), webCaller(user, "web_delete"), {
      identifier: input.permalink,
      expected_checksum: input.expected_checksum,
    });
    if (!r.ok) return c.json({ error: r.message, code: r.code }, r.code === "NOT_FOUND" ? 404 : r.code === "REVISION_CONFLICT" ? 409 : 400);
    return c.json({ ok: true, href: folderHref(v.name, r.value.note.folder) });
  });

  // No-JS form fallbacks for the editor.
  app.post("/app/editor/save", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const f = await c.req.formData();
    const input: SaveInput = {
      project: String(f.get("project") ?? ""),
      permalink: String(f.get("permalink") ?? ""),
      title: String(f.get("title") ?? ""),
      folder: String(f.get("folder") ?? ""),
      content: String(f.get("content") ?? ""),
      expected_checksum: String(f.get("expected_checksum") ?? ""),
    };
    const out = await save(c, user, input);
    if (out.ok) return c.redirect(String(out.body.href), 303);
    const { vault: v } = await pickVault(c, user, input.project || undefined);
    if (!v) return c.html(page(c, "Error", html`<p class="error">${String(out.body.error)}</p>`), 404);
    if (!canWriteVault(v)) return readOnlyPage(c, v);
    const cur = out.body.current as { content: string; checksum: string } | null | undefined;
    return editorPage(c, v, {
      permalink: input.permalink || undefined,
      title: input.title ?? "",
      folder: input.folder ?? "",
      content: input.content ?? "",
      // On a conflict, keep the user's text but arm the form with the new checksum: saving again overwrites knowingly.
      checksum: cur?.checksum ?? input.expected_checksum ?? "",
      error: cur ? "Someone else changed this note since you opened it. Saving again will overwrite their version with yours." : String(out.body.error),
      status: out.status,
    });
  });

  app.post("/app/editor/delete", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const f = await c.req.formData();
    const { vault: v } = await pickVault(c, user, String(f.get("project") ?? "") || undefined);
    if (!v) return c.html(page(c, "Not found", html`<h1>Not found</h1>`), 404);
    if (!canWriteVault(v)) return readOnlyPage(c, v);
    if (await writeLimited(c, user))
      return c.html(page(c, "Not deleted", html`<h1>Not deleted</h1><p class="error">Too many writes. Wait a minute.</p>`, { vault: v.name }), 429);
    const expected = String(f.get("expected_checksum") ?? "");
    if (!expected) {
      return c.html(
        page(c, "Not deleted", html`<h1>Not deleted</h1><p class="error">Reload the note before deleting it (no revision given).</p>`, { vault: v.name }),
        409,
      );
    }
    const r = await vaultStub(c.env, v).deleteNote(vaultRef(v), webCaller(user, "web_delete"), {
      identifier: String(f.get("permalink") ?? ""),
      expected_checksum: expected,
    });
    if (!r.ok) return c.html(page(c, "Not deleted", html`<h1>Not deleted</h1><p class="error">${r.message}</p>`, { vault: v.name }), 409);
    return c.redirect(folderHref(v.name, r.value.note.folder), 303);
  });

  // ---------------------------------------------------------------- dev-only sign-in

  // For driving the UI from a headless browser in `mise run dev`. DEV_LOGIN is set only in
  // wrangler's `local` env; production config never sets it, and then this route does not exist.
  app.get("/app/dev-login", async (c) => {
    if (c.env.DEV_LOGIN !== "1") return c.notFound();
    const username = (c.req.query("u") ?? "dev").toLowerCase();
    let u = await getUserByName(c.env, username);
    if (!u) {
      const created = await createUser(c.env, username, false);
      if (!created.ok) return c.text(`Could not create ${username}: ${created.reason}`, 400);
      u = created.user;
    }
    const token = await createSession(c.env, u.id, { userAgent: "dev-login" });
    return new Response(null, { status: 303, headers: { Location: safeNext(c.req.query("next")), "Set-Cookie": sessionCookie(token) } });
  });
}

function sinceToIso(since: string): string {
  const m = /^(\d+)([hdwmy])$/i.exec(since);
  if (!m) return "";
  const n = Number(m[1]);
  const ms = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[m[2].toLowerCase() as "h"] * n;
  return new Date(Date.now() - ms).toISOString();
}
