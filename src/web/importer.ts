// Settings → Import (form, works without JS) and the JSON API: upload a zip of a Basic Memory
// project or an Obsidian vault; progress and a skipped-files report.

import type { Context, Hono } from "hono";
import { getVault as getAnyVault, isOwner, listVaults, type User, type Vault, vaultRef, vaultStub } from "../directory";
import type { Caller } from "../env";
import { IMPORT_LIMITS, startImport } from "../import";
import { admitWrites } from "../stats/limits";
import { type H, html, when } from "./layout";
import type { AppEnv } from "./types";
import { settingsLayout } from "./ui";

type Page = (c: never, title: string, body: H, extra?: { vault?: string; q?: string }) => H;
type C = Context<AppEnv>;
const webCaller = (user: User): Caller => ({ userId: user.id, username: user.username, client: "web", tool: "web:rederive-permalinks" });

/**
 * Import and permalink re-derivation are the owner's: they are bulk changes whose staging is
 * accounted to the owner's import reservation. A shared project is "not found" here for members.
 */
async function getVault(env: AppEnv["Bindings"], userId: string, name?: string): Promise<Vault | null> {
  const v = await getAnyVault(env, userId, name);
  return v && isOwner(v) ? v : null;
}

/** One upload costs one write from the per-user limiter; the notes inside don't. */
async function uploadLimited(c: C, user: User) {
  if (!c.env.RL_WRITE) return false;
  return !(await c.env.RL_WRITE.limit({ key: `write:${user.id}` })).success;
}

async function handleUpload(
  c: C,
  user: User,
): Promise<{ ok: true; job: string; project: string; strippedPrefix: string | null } | { ok: false; status: 400 | 404 | 411 | 413 | 429; error: string }> {
  // Cap the whole request body before anything parses it.
  const declared = Number(c.req.header("content-length") ?? "NaN");
  if (!Number.isFinite(declared)) return { ok: false, status: 411, error: "Send the upload with a Content-Length." };
  if (declared > IMPORT_LIMITS.requestBytes) return { ok: false, status: 413, error: `Zips up to ${IMPORT_LIMITS.uploadBytes / 1024 / 1024} MB.` };
  if (await uploadLimited(c, user)) return { ok: false, status: 429, error: "Too many writes. Wait a minute." };
  const f = await c.req.formData().catch(() => null);
  const file = f?.get("file");
  if (!f || !file || typeof file === "string") return { ok: false, status: 400, error: "Choose a .zip file." };
  if (file.size > IMPORT_LIMITS.uploadBytes) return { ok: false, status: 413, error: `Zips up to ${IMPORT_LIMITS.uploadBytes / 1024 / 1024} MB.` };
  const vault = await getVault(c.env, user.id, String(f.get("project") ?? "") || undefined);
  if (!vault) return { ok: false, status: 404, error: "No such project." };
  const r = await startImport(c.env, vault, user, new Uint8Array(await file.arrayBuffer()), f.get("overwrite") === "1");
  if (!r.ok) return r;
  return { ok: true, job: r.job, project: vault.name, strippedPrefix: r.strippedPrefix };
}

/** Import is off unless IMPORT_ENABLED is "true" (routes 404, Settings hides it). MCP is unaffected. */
export function importEnabled(env: AppEnv["Bindings"]): boolean {
  return env.IMPORT_ENABLED === "true";
}

export function registerImport(app: Hono<AppEnv>, page: Page, loginRedirect: (url: string) => string) {
  app.get("/app/settings/import", async (c) => {
    if (!importEnabled(c.env)) return c.notFound();
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const jobId = c.req.query("job");
    const vaults = (await listVaults(c.env, user.id)).filter(isOwner);
    if (jobId) {
      const v = await getVault(c.env, user.id, c.req.query("project") || undefined);
      const st = v ? await vaultStub(c.env, v).importStatus(vaultRef(v), jobId) : null;
      if (!v || !st) return c.html(page(c as never, "Import", html`<h1>No such import</h1><p><a href="/app/settings/import">Back</a></p>`), 404);
      const done = st.status === "done" || st.status === "aborted";
      const processed = st.total - (st.counts.pending ?? 0);
      const body = settingsLayout(
        "import",
        { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) },
        html`<h2 class="mt-0 mb-4 text-xl">Import into ${v.name}</h2>
        <p>${st.source === "obsidian" ? "Obsidian vault" : "Basic Memory / markdown"} · ${
          done
            ? "finished"
            : st.status === "aborted"
              ? "stopped"
              : st.deferred_until
                ? html`paused: daily import limit reached; continues ${when(st.deferred_until)}`
                : "importing…"
        }</p>
        <p><progress max="${st.total}" value="${processed}">${processed} of ${st.total}</progress> ${processed} of ${st.total} files</p>
        <p>${st.counts.imported ?? 0} imported · ${st.counts.updated ?? 0} updated · ${st.counts.unchanged ?? 0} unchanged · ${st.counts.attached ?? 0} files attached · ${st.counts.skipped ?? 0} skipped · ${st.counts.failed ?? 0} failed</p>
        ${
          st.skipped.length
            ? html`<h2>Skipped</h2><table><tr><th>File</th><th>Why</th></tr>${st.skipped.map((s) => html`<tr><td><code>${s.path}</code></td><td>${s.message ?? s.status}</td></tr>`)}</table>`
            : ""
        }
        <p><a href="/app/v/${encodeURIComponent(v.name)}">Open ${v.name}</a> · <a href="/app/settings/import">Import more</a></p>`,
      );
      // While running, the page refreshes itself (no script needed).
      return c.html(page(c as never, "Import", body, { vault: v.name }), 200, done ? {} : { Refresh: "2" });
    }
    return c.html(
      page(
        c as never,
        "Import",
        settingsLayout(
          "import",
          { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) },
          html`<h2 class="mt-0 mb-4 text-xl">Import notes</h2>
        <p>Upload a <strong>.zip</strong> of a Basic Memory project or an Obsidian vault (up to ${IMPORT_LIMITS.uploadBytes / 1024 / 1024} MB). Folders, frontmatter, <code>[category]</code> observations, relations and <code>[[wiki links]]</code> come across as they are. Importing the same zip again skips notes that haven't changed.</p>
        <p class="small muted">Images and other files in the zip become attachments, and the notes' links to them are kept working. Notes keep the permalinks Basic Memory gave them. Imports count toward your storage limit.</p>
        <form method="post" action="/app/settings/import" enctype="multipart/form-data" class="card">
          <label for="file">Zip file</label><input id="file" name="file" type="file" accept=".zip,application/zip" required>
          <label for="project">Into project</label>
          <select id="project" name="project">${vaults.map((v) => html`<option value="${v.name}" ${v.is_default ? "selected" : ""}>${v.name}</option>`)}</select>
          <label><input type="checkbox" name="overwrite" value="1"> Replace existing notes that differ (otherwise they're skipped)</label>
          <p><button type="submit">Import</button></p>
        </form>
        <h2 class="mt-8 mb-2 text-lg">Re-derive permalinks from file names</h2>
        <p class="small muted">Notes imported before imports kept Basic Memory's permalinks got one made from their title instead. This gives each imported note the permalink Basic Memory derives from its file name, so <code>memory://</code> URLs from Basic Memory work; the old permalink keeps working as an alias. You'll see the list before anything changes.</p>
        <form method="get" action="/app/settings/import/permalinks" class="card">
          <label for="rp">Project</label>
          <select id="rp" name="project">${vaults.map((v) => html`<option value="${v.name}" ${v.is_default ? "selected" : ""}>${v.name}</option>`)}</select>
          <p><button type="submit" class="btn btn-secondary">Preview</button></p>
        </form>
        <p><a href="/app/settings">Back to settings</a></p>`,
        ),
      ),
    );
  });

  // Re-derive Basic Memory permalinks for imported notes: preview, then apply (one write per note).
  const permalinkPage = (c: C, user: User, title: string, body: H) =>
    c.html(page(c as never, title, settingsLayout("import", { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) }, body)));
  app.get("/app/settings/import/permalinks", async (c) => {
    if (!importEnabled(c.env)) return c.notFound();
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const v = await getVault(c.env, user.id, c.req.query("project") || undefined);
    if (!v) return c.notFound();
    const plan = await vaultStub(c.env, v).rederivePermalinks(vaultRef(v), webCaller(user), { apply: false, max: 0 });
    return permalinkPage(
      c,
      user,
      "Re-derive permalinks",
      html`<h2 class="mt-0 mb-4 text-xl">Re-derive permalinks in ${v.name}</h2>
      ${
        plan.planned.length
          ? html`<p>${plan.planned.length} imported note(s) will get Basic Memory's permalink. Their current permalink keeps working as an alias, and each change is a revision.</p>
            <table><tr><th>Note</th><th>Now</th><th>Becomes</th></tr>${plan.planned
              .slice(0, 500)
              .map((p) => html`<tr><td>${p.title}</td><td><code>${p.from}</code></td><td><code>${p.to}</code></td></tr>`)}</table>
            <form method="post" action="/app/settings/import/permalinks"><input type="hidden" name="project" value="${v.name}"><p><button type="submit">Re-derive ${plan.planned.length} permalink(s)</button></p></form>`
          : html`<p>Every imported note in ${v.name} already has Basic Memory's permalink.</p>`
      }
      ${plan.skipped.length ? html`<h3>Left alone</h3><table><tr><th>Now</th><th>Would be</th><th>Why</th></tr>${plan.skipped.map((p) => html`<tr><td><code>${p.from}</code></td><td><code>${p.to}</code></td><td>${p.why}</td></tr>`)}</table>` : ""}
      <p><a href="/app/settings/import">Back to import</a></p>`,
    );
  });

  app.post("/app/settings/import/permalinks", async (c) => {
    if (!importEnabled(c.env)) return c.notFound();
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const v = await getVault(c.env, user.id, String((await c.req.formData()).get("project") ?? "") || undefined);
    if (!v) return c.notFound();
    const stub = vaultStub(c.env, v);
    const plan = await stub.rederivePermalinks(vaultRef(v), webCaller(user), { apply: false, max: 0 });
    // One write token per note, as other bulk changes; the same button continues where this stopped.
    const max = plan.planned.length ? await admitWrites(c.env, user.id, Math.min(plan.planned.length, 500), 0) : 0;
    const r = await stub.rederivePermalinks(vaultRef(v), webCaller(user), { apply: true, max });
    return permalinkPage(
      c,
      user,
      "Permalinks re-derived",
      html`<h2 class="mt-0 mb-4 text-xl">Permalinks in ${v.name}</h2>
      <p>${r.renamed.length} renamed${r.remaining ? html`; ${r.remaining} still to do (write limit for this minute): <a href="/app/settings/import/permalinks?project=${encodeURIComponent(v.name)}">continue</a>` : ""}. The old permalinks keep working.</p>
      ${r.renamed.length ? html`<table><tr><th>Was</th><th>Now</th></tr>${r.renamed.map((p) => html`<tr><td><code>${p.from}</code></td><td><code>${p.to}</code></td></tr>`)}</table>` : ""}
      ${r.skipped.length ? html`<h3>Left alone</h3><table><tr><th>Now</th><th>Would be</th><th>Why</th></tr>${r.skipped.map((p) => html`<tr><td><code>${p.from}</code></td><td><code>${p.to}</code></td><td>${p.why}</td></tr>`)}</table>` : ""}
      <p><a href="/app/settings/import">Back to import</a></p>`,
    );
  });

  app.post("/app/settings/import", async (c) => {
    if (!importEnabled(c.env)) return c.notFound();
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const r = await handleUpload(c, user);
    if (!r.ok) return c.html(page(c as never, "Import", html`<p class="error">${r.error}</p><p><a href="/app/settings/import">Back</a></p>`), r.status);
    return c.redirect(`/app/settings/import?job=${r.job}&project=${encodeURIComponent(r.project)}`, 303);
  });

  app.post("/app/api/import", async (c) => {
    if (!importEnabled(c.env)) return c.notFound();
    const user = c.get("user");
    if (!user) return c.json({ error: "Sign in first." }, 401);
    const r = await handleUpload(c, user);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json(
      { job: r.job, project: r.project, stripped_prefix: r.strippedPrefix, status_url: `/app/api/import/${r.job}?project=${encodeURIComponent(r.project)}` },
      202,
    );
  });

  app.get("/app/api/import/:job", async (c) => {
    if (!importEnabled(c.env)) return c.notFound();
    const user = c.get("user");
    if (!user) return c.json({ error: "Sign in first." }, 401);
    const v = await getVault(c.env, user.id, c.req.query("project") || undefined);
    const st = v ? await vaultStub(c.env, v).importStatus(vaultRef(v), c.req.param("job")) : null;
    if (!st) return c.json({ error: "No such import." }, 404);
    return c.json(st);
  });
}
