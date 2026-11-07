// Capture in the browser: attachment upload/serve/list, Settings → Capture (email inbox key,
// sender allowlist, bookmarklet, phone sharing) and the clipper (/app/clip).
// Mounted inside createApp(), so the session, CSRF (Origin) and recovery-session middleware apply.

import type { Context, Hono } from "hono";
import { canWriteVault, isOwner, listVaults, type User, type Vault, vaultRef, vaultStub } from "../directory";
import { publicOrigin } from "../env";
import { importEnabled } from "../web/importer";
import { type H, html, icon, layout, noteHref, raw, when } from "../web/layout";
import { renderMarkdown } from "../web/render";
import type { AppEnv } from "../web/types";
import { emptyState, pageHeader, panel, settingsLayout, shellOpts } from "../web/ui";
import { newInboxKey } from "./email";
import { extractAttachment, extractionCounts, queueBackfill, retryExtraction, runExtractionQueue } from "./extract";
import { safeFetch } from "./fetch";
import { type AttachmentRow, deleteAttachment, getAttachment, isInlineImage, listAttachments, MAX_ATTACHMENT_BYTES, putAttachment } from "./files";
import { aiToMarkdown, extractMain, htmlTitle, htmlToMarkdown } from "./html";
import { handleUpload, resolveSignedLink } from "./links";

type C = Context<AppEnv>;

/** Run `p` after the response when the runtime allows (waitUntil), else before it. */
function background(c: C, p: Promise<unknown>): void {
  const q = p.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(q);
  } catch {
    // No execution context (tests calling app.request): the promise still runs; nothing awaits it.
  }
}
const MAX_CLIP_CHARS = 200_000;

export function registerCapture(app: Hono<AppEnv>) {
  const page = (c: C, title: string, body: H, extra: { vault?: string; scripts?: string[] } = {}) => layout({ title, body, ...shellOpts(c), ...extra });
  const loginRedirect = (c: C) => {
    const u = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`);
  };
  async function pickVault(c: C, user: User, name: string | undefined | null): Promise<{ vault: Vault | null; vaults: Vault[] }> {
    const vaults = await listVaults(c.env, user.id);
    if (name) return { vault: vaults.find((v) => v.name === name) ?? null, vaults };
    return { vault: vaults.find((v) => v.is_default) ?? vaults[0] ?? null, vaults };
  }
  /** As pickVault, for a change: only projects the user may write (owner or editor) count. */
  async function pickWritable(c: C, user: User, name: string | undefined | null): Promise<{ vault: Vault | null; vaults: Vault[]; readOnly: boolean }> {
    const r = await pickVault(c, user, name);
    const vaults = r.vaults.filter(canWriteVault);
    if (r.vault && !canWriteVault(r.vault)) return { vault: null, vaults, readOnly: true };
    return { vault: r.vault, vaults, readOnly: false };
  }
  async function writeLimited(c: C, user: User): Promise<boolean> {
    if (!c.env.RL_WRITE) return false;
    const { success } = await c.env.RL_WRITE.limit({ key: `write:${user.id}` });
    return !success;
  }

  // ---------------------------------------------------------------- serve

  async function serveFile(c: C, row: AttachmentRow | null, signed: boolean): Promise<Response> {
    if (!row || !c.env.FILES) return c.text("Not found", 404);
    const etag = `"${row.sha256}"`;
    const common: Record<string, string> = {
      ETag: etag,
      // A signed link is a bearer credential with an expiry: nothing may keep the file past it.
      "Cache-Control": signed ? "private, no-store" : "private, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      Vary: "Cookie",
    };
    if (!signed && c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: common });
    const obj = await c.env.FILES.get(row.r2_key);
    if (!obj) return c.text("Not found", 404);
    const inline = isInlineImage(row.mime);
    return new Response(obj.body, {
      headers: {
        ...common,
        // Only sniffed raster images render inline. Everything else (SVG included) downloads.
        "Content-Type": inline ? row.mime : row.mime === "image/svg+xml" || row.mime.includes("html") ? "application/octet-stream" : row.mime,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        "Content-Length": String(row.bytes),
      },
    });
  }

  app.get("/app/files/:project/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.text("Not found", 404);
    const { vault } = await pickVault(c, user, decodeURIComponent(c.req.param("project")));
    return serveFile(c, vault ? await getAttachment(c.env, vault, c.req.param("id")) : null, false);
  });

  // A signed, expiring link an agent hands the user (read_note file=…): no sign-in. Dies with the file.
  app.get("/files/s/:token", async (c) => serveFile(c, await resolveSignedLink(c.env, c.req.param("token")), true));

  // One-time upload URL from attach_file upload=true: the token is the credential (no session, no CSRF: PUT).
  app.put("/files/upload/:token", (c) => handleUpload(c.env, c.req.raw, c.req.param("token")));

  // ---------------------------------------------------------------- upload / delete

  app.post("/app/api/files", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Sign in first." }, 401);
    if (Number(c.req.header("content-length") ?? 0) > MAX_ATTACHMENT_BYTES + 64 * 1024) {
      return c.json({ error: "File is larger than 10 MB.", code: "TOO_LARGE" }, 413);
    }
    if (await writeLimited(c, user)) return c.json({ error: "Too many writes. Wait a minute.", code: "RATE_LIMITED" }, 429);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "Send multipart/form-data with a file field.", code: "INVALID" }, 400);
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return c.json({ error: "No file.", code: "INVALID" }, 400);
    const { vault, readOnly } = await pickWritable(c, user, String(form.get("project") ?? "") || undefined);
    if (readOnly) return c.json({ error: "You have read-only access to this project.", code: "FORBIDDEN" }, 403);
    if (!vault) return c.json({ error: "No such project.", code: "NOT_FOUND" }, 404);
    const r = await putAttachment(c.env, vault, { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, mime: file.type, source: "upload" });
    if (!r.ok)
      return c.json(
        { error: r.message, code: r.code },
        r.code === "TOO_LARGE" || r.code === "QUOTA" ? 413 : r.code === "UNAVAILABLE" ? 503 : r.code === "BUSY" ? 409 : 400,
      );
    const a = r.attachment;
    // Read its text after answering (the editor needs the link now); the queue retries what doesn't finish.
    if (r.created && a.extract_state === "pending") background(c, extractAttachment(c.env, vault, a.id));
    return c.json(
      {
        id: a.id,
        url: r.url,
        markdown: r.markdown,
        name: a.name,
        mime: a.mime,
        bytes: a.bytes,
        caption: a.caption,
        created: r.created,
        extract_state: a.extract_state ?? null,
      },
      r.created ? 201 : 200,
    );
  });

  const del = async (c: C, user: User, project: string, id: string) => {
    const { vault } = await pickWritable(c, user, project || undefined);
    return vault ? { vault, ok: await deleteAttachment(c.env, vault, id) } : { vault: null, ok: false };
  };
  app.post("/app/api/files/delete", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Sign in first." }, 401);
    const j = (await c.req.json().catch(() => ({}))) as { project?: string; id?: string };
    const r = await del(c, user, j.project ?? "", j.id ?? "");
    return r.ok ? c.json({ ok: true }) : c.json({ error: "No such file.", code: "NOT_FOUND" }, 404);
  });
  app.post("/app/files/delete", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const f = await c.req.formData();
    const project = String(f.get("project") ?? "");
    await del(c, user, project, String(f.get("id") ?? ""));
    return c.redirect(`/app/files?project=${encodeURIComponent(project)}`, 303);
  });

  // ---------------------------------------------------------------- files' text: re-read one, backfill a project

  const backTo = (back: string, fallback: string) => (/^\/app\/[^\s\\]*$/.test(back) && !back.startsWith("//") ? back : fallback);
  app.post("/app/files/extract", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const f = await c.req.formData();
    const project = String(f.get("project") ?? "");
    const id = String(f.get("id") ?? "");
    const { vault } = await pickWritable(c, user, project || undefined);
    const fallback = `/app/files?project=${encodeURIComponent(project)}`;
    if (!vault) return c.redirect(fallback, 303);
    if (await writeLimited(c, user)) return c.text("Too many writes. Wait a minute.", 429);
    if (await retryExtraction(c.env, vault, id)) background(c, extractAttachment(c.env, vault, id));
    return c.redirect(backTo(String(f.get("back") ?? ""), fallback), 303);
  });
  app.post("/app/files/backfill", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const f = await c.req.formData();
    const project = String(f.get("project") ?? "");
    const { vault } = await pickVault(c, user, project || undefined);
    const fallback = `/app/files?project=${encodeURIComponent(project)}`;
    // The owner's call: it spends their AI budget on every file the project holds.
    if (!vault || !isOwner(vault)) return c.redirect(fallback, 303);
    const q = await queueBackfill(c.env, vault);
    // A first batch now; the 15-minute queue reads the rest.
    if (q.queued) background(c, runExtractionQueue(c.env, { vaultId: vault.id, limit: 3 }));
    return c.redirect(`${fallback}&queued=${q.queued}`, 303);
  });

  // ---------------------------------------------------------------- files page

  app.get("/app/files", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const { vault: v, vaults } = await pickVault(c, user, c.req.query("project"));
    if (!v) return c.html(page(c, "Files", html`${pageHeader("Files")}<p class="callout warning">No such project.</p>`), 404);
    const rows = await listAttachments(c.env, v);
    const total = rows.reduce((n, r) => n + r.bytes, 0);
    const counts = await extractionCounts(c.env, v);
    const queued = c.req.query("queued");
    const textCell = (r: AttachmentRow) => {
      const label =
        r.extract_state === "done"
          ? `read${r.extract_pages ? ` · ${r.extract_pages} p.` : ""}`
          : r.extract_state === "pending"
            ? "pending"
            : r.extract_state === "failed"
              ? "failed"
              : r.extract_state === "none"
                ? "none"
                : "not read";
      const again =
        canWriteVault(v) && (r.extract_state === "failed" || r.extract_state === "none" || !r.extract_state)
          ? html`<form method="post" action="/app/files/extract" class="inline"><input type="hidden" name="project" value="${v.name}"><input type="hidden" name="id" value="${r.id}"><button class="btn btn-ghost btn-sm" type="submit">Read again</button></form>`
          : "";
      return html`<span class="badge" data-extract="${r.extract_state ?? "never"}">${label}</span>${r.extract_error && r.extract_state !== "done" ? html`<br><span class="muted small">${r.extract_error}</span>` : ""}${again}`;
    };
    return c.html(
      page(
        c,
        `Files · ${v.name}`,
        html`${pageHeader(
          "Files",
          `${rows.length} file${rows.length === 1 ? "" : "s"} · ${(total / 1024 / 1024).toFixed(1)} MB. Drop or paste files into the editor to attach them; images get an AI caption so search can find them.`,
          html`<form method="get" action="/app/files" class="m-0"><label class="chip">project <select name="project" data-autosubmit>${vaults.map(
            (x) => html`<option value="${x.name}" ${x.id === v.id ? "selected" : ""}>${x.name}</option>`,
          )}</select></label><noscript><button class="btn btn-secondary btn-sm" type="submit">Go</button></noscript></form>`,
        )}
        ${!c.env.FILES ? html`<p class="callout warning">Attachments are not configured on this server (no <code>FILES</code> R2 binding).</p>` : ""}
        ${queued !== undefined ? html`<p class="callout">Queued ${queued} file(s) to have their text read; Cairn works through them every 15 minutes.</p>` : ""}
        ${
          counts.never && isOwner(v)
            ? html`<form method="post" action="/app/files/backfill" class="callout flex flex-wrap items-center gap-3"><input type="hidden" name="project" value="${v.name}">
              <span>${String(counts.never)} file(s) were stored before Cairn read files' text. Read them now so search finds what's inside (PDF pages, text in images; uses your daily AI budget).</span>
              <button class="btn btn-secondary btn-sm" type="submit">Read their text</button></form>`
            : ""
        }
        ${counts.pending ? html`<p class="muted small">${String(counts.pending)} file(s) waiting to have their text read.</p>` : ""}
        ${
          rows.length
            ? html`<table class="files"><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Added</th><th>Text</th><th></th></tr></thead><tbody>${rows.map(
                (r) => html`<tr>
                  <td><a class="inline-flex items-center gap-2 font-medium" href="/app/files/${encodeURIComponent(v.name)}/${r.id}">${icon("file", "size-4 shrink-0 text-muted")}${r.name}</a>${r.caption ? html`<br><span class="muted small">${r.caption}</span>` : ""}</td>
                  <td class="small">${r.mime}</td><td class="small">${Math.ceil(r.bytes / 1024)} KB</td><td class="small">${when(r.created_at)} · ${r.source}</td><td class="small">${textCell(r)}</td>
                  <td>${
                    canWriteVault(v)
                      ? html`<form method="post" action="/app/files/delete" class="inline"><input type="hidden" name="project" value="${v.name}"><input type="hidden" name="id" value="${r.id}">
                    <button class="btn btn-ghost btn-sm text-danger" type="submit" aria-label="Delete ${r.name}">${icon("trash", "size-4")}<span class="max-sm:sr-only">Delete</span></button></form>`
                      : ""
                  }</td></tr>`,
              )}</tbody></table>`
            : html`<div class="card">${emptyState("clip", "No files yet.", "Drop or paste files into the editor to attach them to a note. Email attachments land here too.", html`<a class="btn btn-secondary" href="/app/new?project=${encodeURIComponent(v.name)}">${icon("plus", "size-4")}New note</a>`)}</div>`
        }`,
        { vault: v.name },
      ),
    );
  });

  // ---------------------------------------------------------------- settings → capture

  app.get("/app/settings/capture", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const row = await c.env.DB.prepare("SELECT inbox_key, inbox_allow FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ inbox_key: string | null; inbox_allow: string }>();
    const key = row?.inbox_key ?? null;
    const allow = JSON.parse(row?.inbox_allow || "[]") as string[];
    const inbound = c.env.INBOUND_EMAIL_ADDRESS ?? "";
    const [local, domain] = inbound.split("@");
    const origin = publicOrigin(c.env);
    const bookmarklet = `javascript:(()=>{const e=encodeURIComponent,s=String(getSelection()).slice(0,6000);window.open('${origin}/app/clip?url='+e(location.href)+'&title='+e(document.title)+(s?'&sel='+e(s):''),'cairnclip','width=760,height=820')})()`;
    return c.html(
      page(
        c,
        "Capture",
        settingsLayout(
          "capture",
          { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) },
          html`${c.req.query("saved") ? html`<p class="callout tip">Saved.</p>` : ""}
        ${panel(
          "Email to your memory",
          "Forward or send mail and it becomes a note in your default project’s inbox/ folder.",
          html`${
            !inbound
              ? html`<p class="callout warning m-0">Email capture is off on this server (set <code>INBOUND_EMAIL_ADDRESS</code> and an Email Routing rule).</p>`
              : key
                ? html`<p class="mt-0">Mail becomes a note in your default project's <code>inbox/</code> folder; attachments are saved as files. Use any of:</p>
                  <ol class="ml-5 list-decimal space-y-1.5 text-sm">
                    <li>Send to <code class="copy">${local}+${key}@${domain}</code> <span class="muted small">(needs subaddressing on the mail domain)</span></li>
                    <li>Send to <code>${inbound}</code> with the subject starting <code>[k:${key}]</code></li>
                    <li>Send to <code>${inbound}</code> from an address on your allowlist below (it must pass DMARC or DKIM)</li>
                  </ol>
                  <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sunken px-4 py-3">
                    <p class="m-0 text-xs text-muted">Your key is a password for your inbox: anyone with it can add notes. Rotate it if it leaks.</p>
                    <form method="post" action="/app/settings/capture/key" class="m-0"><button class="btn btn-secondary btn-sm" type="submit">${icon("key", "size-4")}Rotate key</button></form>
                  </div>`
                : html`<form method="post" action="/app/settings/capture/key" class="m-0"><p class="mt-0">Create your private inbox key to start emailing notes to <code>${inbound}</code>.</p><button class="btn btn-primary" type="submit">Create inbox key</button></form>`
          }
          ${
            inbound
              ? html`<form method="post" action="/app/settings/capture/allow" class="mt-6 border-t border-line pt-5">
              <label for="allow">Trusted sender addresses (one per line, up to 10)</label>
              <textarea id="allow" name="allow" rows="4" placeholder="you@example.com">${allow.join("\n")}</textarea>
              <p class="mb-0"><button class="btn btn-secondary" type="submit">Save senders</button></p></form>`
              : ""
          }`,
          { id: "email" },
        )}
        ${panel(
          "Bookmarklet",
          "Clip any web page from your browser’s bookmarks bar.",
          html`<p class="mt-0 flex flex-wrap items-center gap-3">Drag this to your bookmarks bar: <a class="button bookmarklet" href="${bookmarklet}" title="Drag me to your bookmarks bar">${icon("clip", "size-4")}Clip to ${c.env.APP_NAME || "Cairn"}</a></p>
          <p class="mb-0 text-sm text-muted">On any page, click it to open a small ${c.env.APP_NAME || "Cairn"} window with the link (and your selection, if any). Save it as is, or fetch the page's text first. Nothing is injected into the page, and nothing is saved until you press Save.</p>`,
          { id: "clipper" },
        )}
        ${panel(
          "Share from your phone",
          "Install Cairn as an app and share links or text into it.",
          html`<p class="m-0">Open ${origin} in your phone's browser and choose <em>Install app</em> / <em>Add to Home Screen</em>. Then <em>Share → ${c.env.APP_NAME || "Cairn"}</em> from any app saves a link or text as a note.</p>`,
          { id: "share" },
        )}
        ${panel("Files", "Attachments from the editor and from email.", html`<a class="btn btn-secondary" href="/app/files">${icon("file", "size-4")}See and delete attached files</a>`)}`,
        ),
      ),
    );
  });

  app.post("/app/settings/capture/key", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    await c.env.DB.prepare("UPDATE users SET inbox_key = ? WHERE id = ?").bind(newInboxKey(), user.id).run();
    return c.redirect("/app/settings/capture?saved=1#email", 303);
  });

  app.post("/app/settings/capture/allow", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const f = await c.req.formData();
    const list = [
      ...new Set(
        String(f.get("allow") ?? "")
          .split(/[\s,;]+/)
          .map((s) => s.trim().toLowerCase())
          .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)),
      ),
    ].slice(0, 10);
    await c.env.DB.prepare("UPDATE users SET inbox_allow = ? WHERE id = ?").bind(JSON.stringify(list), user.id).run();
    return c.redirect("/app/settings/capture?saved=1#email", 303);
  });

  // ---------------------------------------------------------------- clipper
  //
  // GET /app/clip (bookmarklet, phone share target, any link) only pre-fills the form: it never
  // fetches, converts, stores or charges anything, because a cross-site link can trigger it with
  // the user's cookie. Fetching the page (POST action=fetch) and storing files or converting PDFs
  // (POST action=save) happen only on an explicit same-origin POST (the app's Origin check),
  // rate-limited per user, with fetches limited to two at once per user.

  interface ClipForm {
    project: string;
    url: string;
    title: string;
    folder: string;
    tags: string;
    comment: string;
    content: string;
    /** Save should fetch `url` and store it as an attachment (a file, not a page). */
    attach?: boolean;
    note?: string;
    error?: string;
  }

  const fetching = new Map<string, number>();
  async function admitFetch(c: C, user: User): Promise<string | null> {
    if (c.env.RL_WRITE) {
      const { success } = await c.env.RL_WRITE.limit({ key: `clip:${user.id}` });
      if (!success) return "Too many clips in the last minute. Wait a minute.";
    }
    if ((fetching.get(user.id) ?? 0) >= 2) return "Another clip is still being fetched. Try again in a moment.";
    return null;
  }

  const clipPage = (c: C, vaults: Vault[], f: ClipForm, status = 200) =>
    c.html(
      page(
        c,
        "Clip",
        html`${pageHeader("Clip", f.url ? hostOf(f.url) : "Save a link or some text as a note.")}
        ${f.error ? html`<p class="callout warning" role="alert">${f.error}</p>` : ""}
        ${f.note ? html`<p class="muted small">${f.note}</p>` : ""}
        <form method="post" action="/app/clip" class="clip-form">
          <input type="hidden" name="url" value="${f.url}">
          ${f.attach ? html`<input type="hidden" name="attach" value="1">` : ""}
          <label>Title <input name="title" type="text" value="${f.title}" required maxlength="200"></label>
          <div class="clip-meta">
            <label>Project <select name="project">${vaults.map((v) => html`<option value="${v.name}" ${v.name === f.project ? "selected" : ""}>${v.name}</option>`)}</select></label>
            <label>Folder <input name="folder" type="text" value="${f.folder}" maxlength="300"></label>
            <label>Tags <input name="tags" type="text" value="${f.tags}" placeholder="comma, separated" maxlength="300"></label>
          </div>
          <label>Your comment <textarea name="comment" rows="3" placeholder="Why this matters (optional)">${f.comment}</textarea></label>
          <label>Content (markdown) <textarea name="content" rows="14">${f.content}</textarea></label>
          <p class="editor-actions"><button type="submit" name="action" value="save" class="btn btn-primary">Save note</button>
            ${
              /^https?:\/\//i.test(f.url) && !f.attach
                ? html`<button type="submit" name="action" value="fetch" class="btn btn-secondary" formnovalidate>Fetch page text</button>`
                : ""
            }
            <button type="submit" name="action" value="preview" class="btn btn-ghost" formnovalidate>Preview</button></p>
        </form>
        <h2>Preview</h2>
        <article class="note-body prose clip-preview">${raw(renderMarkdown(composeClip(f), { vault: f.project, links: {} }))}</article>`,
        { vault: f.project },
      ),
      status as 200,
    );

  app.get("/app/clip", async (c) => {
    const user = c.get("user");
    if (!user) return loginRedirect(c);
    const { vault, vaults, readOnly } = await pickWritable(c, user, c.req.query("project"));
    if (!vault)
      return c.html(
        page(c, "Clip", html`<p class="error">${readOnly ? "You have read-only access to this project." : "No such project."}</p>`),
        readOnly ? 403 : 404,
      );
    // Share targets put the link in `text` on many phones; find it.
    const text = (c.req.query("text") ?? "").trim().slice(0, 10_000);
    let url = (c.req.query("url") ?? "").trim().slice(0, 2000);
    let sel = (c.req.query("sel") ?? "").trim().slice(0, 10_000);
    if (!url) {
      const m = /https?:\/\/\S+/.exec(text);
      if (m) url = m[0];
      if (!sel) sel = text.replace(url, "").trim();
    } else if (!sel && text && text !== url) sel = text;
    if (url && !/^https?:\/\//i.test(url)) url = "";
    const f: ClipForm = {
      project: vault.name,
      url,
      title: (c.req.query("title") ?? "").trim().slice(0, 200),
      folder: "clips",
      tags: "",
      comment: "",
      content: "",
    };
    const link = url ? `[${f.title || hostOf(url)}](${url})` : "";
    if (sel) {
      f.content = `${sel
        .slice(0, 8000)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}${link ? `\n\n— ${link}` : ""}\n`;
      if (!f.title) f.title = sel.slice(0, 60).replace(/\s+/g, " ");
      f.note = url ? "Saving your selection. Fetch the page instead to clip all of its text." : undefined;
    } else if (url) {
      f.content = `${link}\n`;
      f.title ||= hostOf(url);
      f.note = "Save keeps the link. Fetch the page to clip its text first.";
    } else {
      f.error = "Nothing to clip: open this from the bookmarklet or Share, or paste content below.";
    }
    return clipPage(c, vaults, f);
  });

  app.post("/app/clip", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const form = await c.req.formData();
    const g = (k: string, n = 300) => String(form.get(k) ?? "").slice(0, n);
    const { vault, vaults, readOnly } = await pickWritable(c, user, g("project", 100) || undefined);
    if (!vault)
      return c.html(
        page(c, "Clip", html`<p class="error">${readOnly ? "You have read-only access to this project." : "No such project."}</p>`),
        readOnly ? 403 : 404,
      );
    const url = g("url", 2000).trim();
    const f: ClipForm = {
      project: vault.name,
      url: /^https?:\/\//i.test(url) ? url : "",
      title: g("title", 200).trim(),
      folder: g("folder").trim(),
      tags: g("tags"),
      comment: g("comment", 20_000),
      content: g("content", MAX_CLIP_CHARS).replace(/\r\n/g, "\n"),
      attach: form.get("attach") === "1",
    };
    const action = form.get("action");
    if (action === "preview") return clipPage(c, vaults, f);
    if (action === "fetch") {
      if (!f.url) return clipPage(c, vaults, { ...f, error: "No page to fetch." }, 400);
      const refused = await admitFetch(c, user);
      if (refused) return clipPage(c, vaults, { ...f, error: refused }, 429);
      const got = await clipPreview(c, user, f.url);
      return clipPage(c, vaults, {
        ...f,
        title: f.title || got.title || hostOf(f.url),
        content: got.markdown,
        attach: got.attach,
        note: got.note,
        error: got.error,
      });
    }
    if (!f.title) return clipPage(c, vaults, { ...f, error: "Give the note a title." }, 400);
    if (await writeLimited(c, user)) return clipPage(c, vaults, { ...f, error: "Too many writes. Wait a minute." }, 429);
    if (f.attach && f.url) {
      // The page was a file: fetch it again now and store it (and convert a PDF), as part of Save.
      const refused = await admitFetch(c, user);
      if (refused) return clipPage(c, vaults, { ...f, error: refused }, 429);
      const stored = await storeClipFile(c, user, vault, f.url);
      if (!stored.ok) return clipPage(c, vaults, { ...f, error: stored.error }, 409);
      f.content = `${stored.markdown}\n\n${f.content}`;
      f.attach = false;
    }
    const tags = f.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
    const metadata: Record<string, unknown> = { source: "clip" };
    if (f.url) metadata.source_url = f.url;
    const r = await vaultStub(c.env, vault).writeNote(
      vaultRef(vault),
      { userId: user.id, username: user.username, client: "web", tool: "web_clip" },
      { title: f.title, directory: f.folder, content: composeClip(f), tags: tags.length ? tags : undefined, metadata },
    );
    if (!r.ok) {
      const msg =
        r.code === "ALREADY_EXISTS" ? `A note called "${f.title}" already exists in ${f.folder || "this folder"}. Change the title or folder.` : r.message;
      return clipPage(c, vaults, { ...f, error: msg }, 409);
    }
    const href = noteHref(vault.name, r.value.note.permalink);
    return c.html(
      page(
        c,
        "Clipped",
        html`<div class="card mt-4">${emptyState(
          "sparkle",
          "Saved",
          html`Saved <a href="${href}" target="_blank" rel="noopener">${r.value.note.title}</a> to ${vault.name}/${r.value.note.permalink}.`,
          html`<div class="flex flex-wrap justify-center gap-2"><button type="button" data-close-window class="btn btn-secondary">Close window</button> <a class="btn btn-primary" href="${href}">Open the note</a></div>`,
        )}</div>`,
        { vault: vault.name },
      ),
    );
  });

  async function withFetchSlot<T>(user: User, fn: () => Promise<T>): Promise<T> {
    fetching.set(user.id, (fetching.get(user.id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (fetching.get(user.id) ?? 1) - 1;
      if (n > 0) fetching.set(user.id, n);
      else fetching.delete(user.id);
    }
  }

  /** Fetch a URL for the preview: page text via the built-in converter; files are only described. Stores nothing. */
  async function clipPreview(c: C, user: User, url: string): Promise<{ title?: string; markdown: string; attach?: boolean; error?: string; note?: string }> {
    const link = `[${hostOf(url)}](${url})`;
    const got = await withFetchSlot(user, () => safeFetch(url, { fetcher: c.env.CAPTURE_FETCH }));
    if (!got.ok) return { markdown: `${link}\n`, error: `Couldn't fetch the page (${got.message}). Saving the link; paste content if you like.` };
    const type = got.contentType.split(";")[0].trim().toLowerCase();
    const note = got.truncated ? "The page was larger than 5 MB; only the first part was used." : undefined;
    if (type.includes("html")) {
      const html = new TextDecoder().decode(got.bytes);
      const md = htmlToMarkdown(extractMain(html), got.url);
      return { title: htmlTitle(html), markdown: `${md.slice(0, MAX_CLIP_CHARS)}\n\n— ${link}\n`, note };
    }
    if (type.startsWith("text/")) return { markdown: `${new TextDecoder().decode(got.bytes).slice(0, MAX_CLIP_CHARS)}\n\n— ${link}\n`, note };
    const kb = Math.ceil(got.bytes.byteLength / 1024);
    return {
      markdown: `— ${link}\n`,
      attach: true,
      title: fileNameFromUrl(url, hostOf(url)),
      note: `This is a file (${type || "unknown type"}, ${kb} KB${got.truncated ? "+" : ""}). Save stores it as an attachment${type === "application/pdf" ? " and adds its text" : ""}; it counts toward your storage.`,
    };
  }

  /** On Save: fetch the file again and store it; a PDF also gets its text (Workers AI, budgeted). */
  async function storeClipFile(c: C, user: User, vault: Vault, url: string): Promise<{ ok: true; markdown: string } | { ok: false; error: string }> {
    const got = await withFetchSlot(user, () => safeFetch(url, { accept: "*/*", maxBytes: MAX_ATTACHMENT_BYTES, fetcher: c.env.CAPTURE_FETCH }));
    if (!got.ok) return { ok: false, error: `Couldn't fetch the file (${got.message}).` };
    if (got.truncated) return { ok: false, error: "The file is larger than 10 MB." };
    const type = got.contentType.split(";")[0].trim().toLowerCase();
    const att = await putAttachment(c.env, vault, { bytes: got.bytes, name: fileNameFromUrl(url, "file"), mime: type, source: "url" });
    if (!att.ok) return { ok: false, error: `Couldn't store the file: ${att.message}` };
    const text = att.attachment.mime === "application/pdf" ? await aiToMarkdown(c.env, user.id, att.attachment.name, got.bytes, "application/pdf") : null;
    return { ok: true, markdown: text ? `${att.markdown}\n\n${text.slice(0, MAX_CLIP_CHARS)}` : att.markdown };
  }
}

function composeClip(f: { comment: string; content: string }): string {
  const comment = f.comment.trim();
  return comment ? `${comment}\n\n---\n\n${f.content.trim()}\n` : `${f.content.trim()}\n`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
}

function fileNameFromUrl(url: string, fallback: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || fallback;
  } catch {
    return fallback;
  }
}
