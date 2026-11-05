// The Worker's default handler: viewer pages, passkey auth, OAuth /authorize + consent, export.

import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { authRoutes } from "../auth/routes";
import { simpleWebAuthnVerifier, type WebAuthnVerifier } from "../auth/webauthn";
import { registerCapture } from "../capture/routes";
import {
  audit,
  canWriteVault,
  createPat,
  createVault,
  deletePat,
  GUIDE_TEMPLATES,
  getVault,
  guideSummary,
  inviterName,
  inviteValid,
  listPats,
  listVaults,
  loadSession,
  lookupShareLink,
  remainingRecoveryCodes,
  SESSION_COOKIE,
  safeEqual,
  setVaultGuide,
  type User,
  type Vault,
  vaultRef,
  vaultStub,
} from "../directory";
import { openSignup, publicOrigin, SCOPE_READ, SCOPE_WRITE, VERSION } from "../env";
import { registerSetupRoutes, setupLine } from "../setup";
import { admitWrite } from "../stats/limits";
import { needsReauth, registerAccount, safetyNag } from "./account";
import { accountJson, buildExportZip } from "./export";
import { isSerious, memoryScoreSection, registerFun, seriousModeSettings } from "./fun";
import { importEnabled, registerImport } from "./importer";
import { ago, folderHref, type H, html, icon, layout, noteHref, raw, when } from "./layout";
import { safeNext } from "./next";
import { escapeHtml, renderMarkdown } from "./render";
import { registerRound2 } from "./round2";
import { corePanel, registerRound3 } from "./round3";
import { registerSharing } from "./sharing";
import { registerSite } from "./site";
import type { AppEnv } from "./types";
import { clientBadge, copyLine, emptyState, pageHeader, panel, settingsLayout, shellOpts } from "./ui";
import { registerViewer } from "./viewer/routes";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const LANDING_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export function createApp(opts: { verifier?: WebAuthnVerifier } = {}) {
  const app = new Hono<AppEnv>();

  // A request body the route can't parse (JSON sent to a form route, a malformed form or JSON) is
  // the caller's mistake: 400, not a 500. Anything else is a real error and stays a 500.
  app.onError((err, c) => {
    const msg = String((err as Error)?.message ?? "");
    if (err instanceof SyntaxError || (err instanceof TypeError && /FormData|form-data|x-www-form-urlencoded|Content-Type|body/i.test(msg))) {
      return c.text("The request body could not be read.", 400);
    }
    console.error(err);
    return c.text("Internal Server Error", 500);
  });

  // ---- security headers, session, CSRF, rate limits ----
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "same-origin");
    if (!c.res.headers.has("Content-Security-Policy")) c.res.headers.set("Content-Security-Policy", CSP);
    if (!c.res.headers.has("X-Frame-Options")) c.res.headers.set("X-Frame-Options", "DENY");
  });

  // Public setup docs for assistants (no session needed, no user data).
  registerSetupRoutes(app);

  app.use("*", async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const s = await loadSession(c.env, token);
    if (s && token) {
      c.set("user", s.user);
      c.set("session", s.session);
      c.set("sessionToken", token);
    }
    await next();
  });

  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin !== publicOrigin(c.env)) return c.json({ error: "Cross-origin request refused." }, 403);
    }
    await next();
  });

  for (const path of ["/auth/signup/*", "/auth/login/*", "/auth/recover"]) {
    app.use(path, async (c, next) => {
      if (c.env.RL_AUTH && c.req.method === "POST") {
        const { success } = await c.env.RL_AUTH.limit({ key: `auth:${c.req.header("cf-connecting-ip") ?? "unknown"}` });
        if (!success) return c.json({ error: "Too many attempts. Wait a minute and try again." }, 429);
      }
      await next();
    });
  }

  // An account being deleted can only finish its deletion (or sign out).
  app.use("*", async (c, next) => {
    const u = c.get("user");
    if (u?.deleting_at) {
      const p = c.req.path;
      const allowed =
        p.startsWith("/app/owg/") ||
        p.startsWith("/app/cairn/") ||
        p.startsWith("/app/ui/") ||
        p.startsWith("/app/fonts/") ||
        p.startsWith("/app/dist/") ||
        p.startsWith("/app/settings/delete") ||
        p === "/app/reauth" ||
        p.startsWith("/auth/reauth/") ||
        p === "/auth/logout" ||
        p === "/health";
      if (!allowed) return c.redirect("/app/settings/delete", 303);
    }
    await next();
  });

  // A recovery session may only enrol a passkey (and sign out).
  app.use("*", async (c, next) => {
    const s = c.get("session");
    if (s?.restricted) {
      const p = c.req.path;
      const allowed =
        p.startsWith("/app/owg/") ||
        p.startsWith("/app/cairn/") ||
        p.startsWith("/app/ui/") ||
        p.startsWith("/app/fonts/") ||
        p === "/app/settings" ||
        p === "/auth/passkey/options" ||
        p === "/auth/passkey/verify" ||
        p === "/auth/logout" ||
        p === "/health";
      if (!allowed) return c.redirect("/app/settings?recovered=1", 303);
    }
    await next();
  });

  const page = (c: unknown, title: string, body: H, extra: { vault?: string; q?: string; auth?: boolean | string } = {}) =>
    layout({ title, body, ...shellOpts(c as Context<AppEnv>), ...extra });

  const requireUser = (c: { get: (k: "user") => User | undefined; req: { url: string } }) => c.get("user");
  const loginRedirect = (url: string) => {
    const u = new URL(url);
    return `/login?next=${encodeURIComponent(u.pathname + u.search)}`;
  };

  // ---- static + health ----
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

  app.route("/auth", authRoutes(opts.verifier ?? simpleWebAuthnVerifier));

  // ---- signed-out pages ----
  app.get("/signup", async (c) => {
    if (c.get("user")) return c.redirect("/app");
    const invite = c.req.query("invite") ?? "";
    const share = c.req.query("share") ?? "";
    const open = openSignup(c.env);
    const inviteOk = invite ? await inviteValid(c.env, invite) : false;
    const inviter = inviteOk ? await inviterName(c.env, invite) : null;
    // A share link works as an invite (while it may still create accounts).
    const shared = !inviteOk && share ? await lookupShareLink(c.env, share) : null;
    const shareOk = !!shared?.signupOpen;
    return c.html(
      page(
        c,
        "Sign up",
        html`<h1 class="text-center text-2xl">Create your account</h1>
        <p class="mt-1 mb-0 text-center text-sm text-muted">One passkey and you’re in. No password, no email.</p>
        ${inviter ? html`<p class="callout tip mt-6">${icon("sparkle", "size-5 shrink-0 text-ok")}<span><strong>${inviter}</strong> invited you.</span></p>` : ""}
        ${shareOk && shared ? html`<p class="callout tip mt-6">${icon("sparkle", "size-5 shrink-0 text-ok")}<span>You’ll join <strong>${shared.label}</strong> as ${shared.role === "editor" ? "an editor" : "a reader"}.</span></p>` : ""}
        ${invite && !inviteOk ? html`<p class="callout warning mt-6">This invite link has been used, revoked or has expired.${open ? " You can still sign up." : ""}</p>` : ""}
        ${share && !shareOk ? html`<p class="callout warning mt-6">This share link has been used, revoked or has expired.${open ? " You can still sign up." : ""}</p>` : ""}
        ${!open && !inviteOk && !shareOk ? html`<p class="callout warning mt-6">Sign-up here is by invitation. Ask someone with an account for an invite link.</p>` : ""}
        <form data-passkey="signup" data-next="${safeNext(c.req.query("next"))}" class="mt-6 space-y-4">
          <div><label for="username">Username</label>
          <input id="username" name="username" type="text" autocomplete="username webauthn" required minlength="2" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{1,31}" placeholder="e.g. ada" class="h-11"></div>
          <input type="hidden" name="invite" value="${invite}">
          ${shareOk ? html`<input type="hidden" name="share" value="${share}">` : ""}
          <details class="text-sm"><summary class="text-muted">Setup token (admins only)</summary>
            <div class="mt-3"><label for="setupToken">Setup token</label><input id="setupToken" name="setupToken" type="password" autocomplete="off"></div>
          </details>
          <button type="submit" class="btn btn-primary btn-lg w-full">${icon("fingerprint")} Create account with a passkey</button>
          <p data-status class="m-0 text-center text-xs text-muted">Your passkey is tied to ${new URL(c.env.PUBLIC_URL).hostname}. No passwords, no email.</p>
        </form>
        <div id="recovery" hidden class="mt-6">
          <h2 class="mt-0 mb-1 text-lg">Save your recovery codes</h2>
          <p class="mt-0 text-sm text-muted">Each code signs you in once if you lose your passkeys. They are shown only now: keep them somewhere that isn’t ${c.env.APP_NAME}.</p>
          <pre class="codes" id="signup-codes"></pre>
          <div class="flex gap-2">
            <button type="button" class="btn btn-secondary flex-1" data-copy-from="signup-codes" hidden>${icon("copy", "size-4")} Copy</button>
            <button type="button" class="btn btn-secondary flex-1" data-download-from="signup-codes" data-filename="cairn-recovery-codes.txt" data-download-head="Cairn recovery codes. Use one at /recover if you lose your passkeys; each works once.&#10;&#10;" hidden>${icon("download", "size-4")} Download</button>
          </div>
          <a class="button continue mt-4 w-full py-2.5" href="/">I saved them, continue</a>
        </div>
        <p class="mt-6 mb-0 border-t border-line pt-5 text-center text-sm text-muted">Already have an account? <a href="/login">Sign in</a></p>`,
        { auth: true },
      ),
    );
  });

  app.get("/login", async (c) => {
    if (c.get("user")) return c.redirect("/app");
    return c.html(
      page(
        c,
        "Sign in",
        html`<h1 class="text-center text-2xl">Welcome back</h1>
        <p class="mt-1 mb-0 text-center text-sm text-muted">Sign in with the passkey on this device, your phone or a security key.</p>
        <form data-passkey="login" data-next="${safeNext(c.req.query("next"))}" class="mt-6 space-y-3">
          <button type="submit" class="btn btn-primary btn-lg w-full">${icon("fingerprint")} Sign in with a passkey</button>
          <p data-status class="m-0 min-h-4 text-center text-xs text-muted"></p>
        </form>
        <div class="mt-6 space-y-1.5 border-t border-line pt-5 text-center text-sm text-muted">
          <p class="m-0">New here? <a href="/signup">Create an account</a></p>
          <p class="m-0">Lost your passkey? <a href="/recover">Use a recovery code</a></p>
        </div>`,
        { auth: true },
      ),
    );
  });

  app.get("/recover", (c) =>
    c.html(
      page(
        c,
        "Recover",
        html`<h1 class="text-center text-2xl">Use a recovery code</h1>
        <p class="mt-1 mb-0 text-center text-sm text-muted">Lost every passkey? One of your ten codes gets you back in.</p>
        <form method="post" action="/recover" class="mt-6 space-y-4">
          <div><label for="u">Username</label><input id="u" name="username" type="text" required autocomplete="username" class="h-11"></div>
          <div><label for="code">Recovery code</label><input id="code" name="code" type="text" required autocomplete="one-time-code" placeholder="xxxxx-xxxxx" class="h-11 font-mono tracking-wider"></div>
          <button type="submit" class="btn btn-primary btn-lg w-full">Continue</button>
        </form>
        <p class="mt-5 mb-0 text-center text-xs text-muted">A recovery code signs you in only to add a new passkey. Other sessions are signed out when you do.</p>
        <p class="mt-5 mb-0 border-t border-line pt-5 text-center text-sm text-muted"><a href="/login">Back to sign in</a></p>`,
        { auth: true },
      ),
    ),
  );

  // HTML form wrapper around the JSON /auth/recover endpoint
  app.post("/recover", async (c) => {
    const form = await c.req.formData();
    const res = await app.request(
      "/auth/recover",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: publicOrigin(c.env), "cf-connecting-ip": c.req.header("cf-connecting-ip") ?? "" },
        body: JSON.stringify({ username: form.get("username"), code: form.get("code") }),
      },
      c.env,
    );
    if (!res.ok) {
      const j = (await res.json()) as { error?: string };
      return c.html(
        page(
          c,
          "Recover",
          html`<h1 class="text-center text-2xl">That didn’t work</h1><p class="callout warning mt-6">${j.error ?? "Failed."}</p><a class="button mt-2 w-full py-2.5" href="/recover">Try again</a>`,
          { auth: true },
        ),
        400,
      );
    }
    return new Response(null, { status: 303, headers: { Location: "/app/settings?recovered=1", "Set-Cookie": res.headers.get("set-cookie") ?? "" } });
  });

  // ---- landing (static, from the marketing site in public/) and app home ----
  const staticPage = async (c: { env: AppEnv["Bindings"]; req: { url: string } }, path: string): Promise<Response | null> => {
    if (!c.env.ASSETS) return null;
    const res = await c.env.ASSETS.fetch(new Request(new URL(path, c.req.url)));
    if (!res.ok) return null;
    // Asset responses have immutable headers; copy so the security middleware can add its own.
    // The marketing pages are static (no user content) and use inline style attributes, so they
    // get a CSP that allows inline styles; the app keeps the strict CSP.
    const copy = new Response(res.body, res);
    copy.headers.set("Content-Security-Policy", LANDING_CSP);
    return copy;
  };

  app.get("/", async (c) => {
    if (c.get("user")) return c.redirect("/app");
    const landing = await staticPage(c, "/");
    if (landing) return landing;
    // Fallback until the marketing site (public/index.html) is present.
    return c.html(
      page(
        c,
        "Memory for your AI assistants",
        html`<h1>${c.env.APP_NAME}: memory for your AI assistants</h1>
        <p>Markdown notes with observations and links, searchable by keyword and meaning, that Claude and other MCP clients read and write for you. You can read, browse and export everything.</p>
        <p><a class="button" href="/signup">Create an account</a> <a class="button secondary" href="/login">Sign in</a> <a href="/connect">How to connect</a></p>`,
      ),
    );
  });

  app.get("/connect", async (c) => {
    const pageRes = await staticPage(c, "/connect");
    if (pageRes) return pageRes;
    const mcpUrl = `${publicOrigin(c.env)}/mcp`;
    return c.html(
      page(
        c,
        "Connect",
        html`<h1>Connect an assistant</h1>
        <p><strong>Quickest:</strong> paste this line into Claude or Codex and it will connect, ask how you want to use Cairn and set itself up:</p><pre class="cmd">${setupLine(publicOrigin(c.env))}</pre>
        <p><strong>claude.ai / Claude Desktop:</strong> Settings → Connectors → Add custom connector:</p><pre class="cmd">${mcpUrl}</pre>
        <p><strong>Claude Code:</strong></p><pre class="cmd">claude mcp add --transport http cairn ${mcpUrl}</pre>`,
      ),
    );
  });

  app.get("/app", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const vaults = await listVaults(c.env, user.id);
    const recents = await Promise.all(vaults.map(async (v) => ({ v, r: await vaultStub(c.env, v).recent(vaultRef(v), { limit: 10 }) })));
    const notes = recents
      .flatMap(({ v, r }) => r.notes.map((n) => ({ v, n })))
      .sort((a, b) => b.n.updated_at.localeCompare(a.n.updated_at))
      .slice(0, 12);
    const agentWrites = recents
      .flatMap(({ v, r }) => r.writes.filter((w) => w.client && w.client !== "web").map((w) => ({ v, w })))
      .sort((a, b) => b.w.at.localeCompare(a.w.at))
      .slice(0, 12);
    const totalNotes = vaults.reduce((t, v) => t + v.note_count, 0);
    // Storage counts against each project's owner: only this account's own projects add up here.
    const totalBytes = vaults.filter((v) => v.role === "owner").reduce((t, v) => t + v.bytes_used, 0);
    const defaultVault = vaults.find((v) => v.is_default) ?? vaults[0];
    const verb = (a: string) => ({ create: "Created", update: "Updated", edit: "Edited", delete: "Deleted", move: "Moved", revert: "Reverted" })[a] ?? a;
    return c.html(
      page(
        c,
        "Home",
        html`${pageHeader(
          "Your memory",
          html`Welcome back, <strong class="font-semibold text-fg">${user.username}</strong>. Here’s what you and your assistants have been remembering.`,
          html`<a class="btn btn-primary" href="/app/new">${icon("plus", "size-4")} New note</a>`,
        )}
        ${await safetyNag(c.env, user.id)}
        <dl class="mb-6 grid grid-cols-2 gap-3 lg:mb-8 lg:grid-cols-4">
          <div class="stat-tile"><dt>Notes</dt><dd>${totalNotes.toLocaleString("en-US")}</dd></div>
          <div class="stat-tile"><dt>Projects</dt><dd>${vaults.length}</dd></div>
          <div class="stat-tile"><dt>Storage used</dt><dd>${totalBytes < 1048576 ? `${Math.ceil(totalBytes / 1024)} KB` : `${(totalBytes / 1048576).toFixed(1)} MB`}</dd></div>
          <div class="stat-tile"><dt>Last agent write</dt><dd class="truncate">${agentWrites[0] ? ago(agentWrites[0].w.at) : "—"}</dd></div>
        </dl>
        <div class="grid gap-6 xl:grid-cols-3">
          <div class="min-w-0 space-y-6 xl:col-span-2">
            <section class="card overflow-hidden p-0" aria-labelledby="recent-h">
              <div class="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
                <h2 id="recent-h" class="m-0 text-base">Recently updated</h2>
                ${defaultVault ? html`<a class="text-sm font-medium" href="${folderHref(defaultVault.name, "")}">Browse all</a>` : ""}
              </div>
              ${
                notes.length
                  ? html`<ul class="grid gap-3 p-4 sm:grid-cols-2">${notes.map(
                      ({
                        v,
                        n,
                      }) => html`<li class="min-w-0"><a class="group flex h-full flex-col rounded-xl p-4 no-underline ring-1 ring-line transition hover:bg-raised hover:no-underline hover:ring-accent-2/40" href="${noteHref(v.name, n.permalink)}">
                        <span class="flex items-start gap-3"><span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-soft text-accent-2">${icon("note", "size-4")}</span>
                          <span class="min-w-0"><span class="block truncate font-semibold text-fg group-hover:text-accent">${n.title}</span>
                          <span class="block truncate font-mono text-xs text-muted">${v.name}/${n.permalink}</span></span></span>
                        <span class="mt-3 flex flex-wrap gap-1.5"><span class="badge">${n.type}</span>${n.tags.slice(0, 3).map((t) => html`<span class="tag">${t}</span>`)}</span>
                        <span class="mt-auto flex items-center justify-between gap-2 pt-3 text-xs text-muted">${clientBadge(n.updated_by_client)}<time datetime="${n.updated_at}" title="${when(n.updated_at)}">${ago(n.updated_at)}</time></span>
                      </a></li>`,
                    )}</ul>`
                  : html`<div class="p-4">${emptyState("note", "No notes yet", "Ask your assistant to remember something, or write the first note yourself.", html`<a class="btn btn-primary" href="/app/new">${icon("plus", "size-4")} New note</a>`)}</div>`
              }
            </section>
            <section class="card overflow-hidden p-0" aria-labelledby="agents-h">
              <div class="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
                <h2 id="agents-h" class="m-0 text-base">Recent agent writes</h2>
                <a class="text-sm font-medium" href="/app/activity">All activity</a>
              </div>
              ${
                agentWrites.length
                  ? html`<ul class="divide-y divide-line">${agentWrites.map(
                      ({ v, w }) => html`<li class="flex items-center gap-3 px-5 py-3">
                        <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">${icon("bolt", "size-4")}</span>
                        <div class="min-w-0 flex-1"><p class="m-0 truncate text-sm"><span class="text-muted">${verb(w.action)}</span> <a class="font-medium" href="${noteHref(v.name, w.permalink)}">${w.title}</a></p>
                          <p class="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">${clientBadge(w.client)}${w.username && w.username !== user.username ? html`<span>for ${w.username}</span>` : ""}<span>in ${v.name}</span>${w.tool ? html`<span class="font-mono">${w.tool}</span>` : ""}</p></div>
                        <time class="shrink-0 text-xs text-muted" datetime="${w.at}" title="${when(w.at)}">${ago(w.at)}</time>
                      </li>`,
                    )}</ul>`
                  : html`<div class="p-4">${emptyState("plug", "No agent has written anything yet", "Connect claude.ai or Claude Code and your assistants’ saves will show up here, each with a receipt.", html`<a class="btn btn-primary" href="/app/settings#connect">${icon("plug", "size-4")} Connect Claude</a>`)}
                    <div class="mx-auto mt-2 max-w-xl px-1"><p class="mt-0 mb-2 text-sm text-muted">Already connected, or want your assistant to do it? Paste this into Claude or Codex:</p>${copyLine("home-setup-line", setupLine(publicOrigin(c.env)))}</div></div>`
              }
            </section>
          </div>
          <div class="min-w-0 space-y-6">
            ${isSerious(c) ? "" : await memoryScoreSection(c.env, user)}
            ${await corePanel(c.env, user)}
            <section class="card" aria-labelledby="projects-h" id="new-project">
              <div class="card-head"><h2 id="projects-h" class="m-0 text-base">Projects</h2></div>
              <ul class="-mx-2 space-y-0.5">${vaults.map(
                (
                  v,
                ) => html`<li><a class="flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-fg no-underline hover:bg-sunken hover:no-underline" href="${folderHref(v.name, "")}">
                  <span class="flex size-8 items-center justify-center rounded-lg brand-grad text-xs font-bold text-white uppercase">${v.name.slice(0, 1)}</span>
                  <span class="min-w-0 flex-1"><span class="block truncate font-medium">${v.name}${v.is_default ? html` <span class="badge ml-1">default</span>` : ""}${v.role !== "owner" ? html` <span class="badge ml-1">${v.role}</span>` : ""}</span>
                  <span class="block text-xs text-muted">${v.note_count} notes · ${Math.ceil(v.bytes_used / 1024)} KB</span></span></a></li>`,
              )}</ul>
              <form method="post" action="/app/projects" class="mt-4 flex gap-2 border-t border-line pt-4">
                <label for="new-project-name" class="sr-only">New project name</label>
                <input id="new-project-name" name="name" type="text" placeholder="New project name" required maxlength="48" class="min-w-0 flex-1">
                <label for="new-project-template" class="sr-only">Starter guide</label>
                <select id="new-project-template" name="template" class="w-auto" title="A starter guide telling assistants what belongs in the project">${Object.entries(
                  GUIDE_TEMPLATES,
                ).map(([k, t]) => html`<option value="${k}">${k === "blank" ? "No guide" : `${t.label} guide`}</option>`)}</select>
                <button class="secondary" type="submit">Create</button>
              </form>
            </section>
          </div>
        </div>`,
      ),
    );
  });

  app.post("/app/projects", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect(loginRedirect(c.req.url), 303);
    if (!(await admitWrite(c.env, user.id)))
      return c.html(page(c, "Slow down", html`<p class="error">Too many changes at once; try again in a minute.</p>`), 429);
    const form = await c.req.formData();
    const r = await createVault(c.env, user.id, String(form.get("name") ?? ""));
    if (!r.ok) return c.html(page(c, "Error", html`<p class="error">${r.message}</p><p><a href="/app">Back</a></p>`), 400);
    // A starter guide for assistants, if one was picked (editable on the project's page).
    const starter = GUIDE_TEMPLATES[String(form.get("template") ?? "")]?.text;
    if (starter) await setVaultGuide(c.env, { ...r.vault, role: "owner" }, user.id, starter);
    return c.redirect(folderHref(r.vault.name, ""), 303);
  });

  // ---- vault browse / note view / raw ----
  async function vaultOr404(c: { env: AppEnv["Bindings"] }, user: User, name: string): Promise<Vault | null> {
    return getVault(c.env, user.id, decodeURIComponent(name));
  }

  const restPath = (path: string, marker: string) =>
    path
      .slice(path.indexOf(marker) + marker.length)
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");

  const browse = async (c: Context<AppEnv>, folder: string) => {
    const user = requireUser(c);
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const v = await vaultOr404(c, user, c.req.param("vault") ?? "");
    if (!v) return c.html(page(c, "Not found", html`<h1>Not found</h1>`), 404);
    const list = await vaultStub(c.env, v).listDirectory(vaultRef(v), { path: folder });
    const parts = list.path ? list.path.split("/") : [];
    return c.html(
      page(
        c,
        `${v.name}/${list.path}`,
        html`<div class="crumbs"><a href="${folderHref(v.name, "")}">${v.name}</a>${parts.map((p, i) => html`<span aria-hidden="true">/</span><a href="${folderHref(v.name, parts.slice(0, i + 1).join("/"))}">${p}</a>`)}</div>
        ${pageHeader(
          list.path ? (parts.at(-1) ?? list.path) : v.name,
          `${list.folders.length} ${list.folders.length === 1 ? "folder" : "folders"} · ${list.notes.length} ${list.notes.length === 1 ? "note" : "notes"}`,
          html`<a class="btn btn-ghost" href="/app/v/${encodeURIComponent(v.name)}/sharing">${icon("user", "size-4")} ${v.role === "owner" ? "Share" : `Shared with you (${v.role})`}</a>
          ${canWriteVault(v) ? html`<a class="btn btn-secondary" href="/export/${encodeURIComponent(v.name)}">${icon("download", "size-4")} Download this project (.zip)</a>` : ""}
          ${canWriteVault(v) ? html`<a class="btn btn-primary" href="/app/new?v=${encodeURIComponent(v.name)}${list.path ? `&folder=${encodeURIComponent(list.path)}` : ""}">${icon("plus", "size-4")} New note</a>` : ""}`,
        )}
        ${
          v.guide && !list.path
            ? html`<details class="card mb-4"><summary class="cursor-pointer text-sm font-semibold">Guide for assistants <span class="font-normal text-muted">— ${guideSummary(v.guide)}</span></summary>
              <div class="note-body prose mt-3">${raw(renderMarkdown(v.guide, { vault: v.name, links: {} }))}</div>
              <p class="mb-0 text-xs text-muted">Updated ${when(v.guide_updated_at)}${v.guide_editor ? ` by ${v.guide_editor}` : ""}. <a href="/app/v/${encodeURIComponent(v.name)}/sharing#guide">${canWriteVault(v) ? "Edit" : "More"}</a></p></details>`
            : ""
        }
        ${
          !list.folders.length && !list.notes.length
            ? html`<div class="card">${emptyState("folder", "Empty.", "Nothing in this folder yet. Ask your assistant to save something here, or write a note yourself.")}</div>`
            : html`<ul class="m-0 list-none divide-y divide-line overflow-hidden rounded-2xl bg-surface p-0 shadow-card ring-1 ring-line">
          ${list.folders.map(
            (
              f,
            ) => html`<li class="m-0"><a href="${folderHref(v.name, f.path)}" class="flex items-center gap-3 px-4 py-3 text-fg no-underline hover:bg-sunken hover:no-underline sm:px-5">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-accent-2">${icon("folder", "size-5")}</span>
              <span class="min-w-0 flex-1 truncate font-medium">${f.name}/</span>
              <span class="shrink-0 text-xs text-muted">${f.notes} notes</span></a></li>`,
          )}
          ${list.notes.map(
            (
              n,
            ) => html`<li class="m-0"><a href="${noteHref(v.name, n.permalink)}" class="flex items-center gap-3 px-4 py-3 text-fg no-underline hover:bg-sunken hover:no-underline sm:px-5">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">${icon("note", "size-5")}</span>
              <span class="min-w-0 flex-1"><span class="block truncate font-medium">${n.title}</span><span class="block truncate font-mono text-xs text-faint">${n.permalink}</span></span>
              <span class="hidden shrink-0 text-right text-xs text-muted sm:block"><span class="badge">${n.type}</span><span class="mt-1 block">${when(n.updated_at)}</span></span></a></li>`,
          )}
        </ul>`
        }`,
        { vault: v.name },
      ),
    );
  };

  // Round 3a routes (history must be registered before the catch-all note route below).
  registerRound3(app, page as never, loginRedirect);

  app.get("/app/v/:vault", (c) => browse(c, ""));
  app.get("/app/v/:vault/f/*", (c) => browse(c, restPath(c.req.path, "/f/")));

  // Note pages: src/web/viewer/note.ts (registered with the viewer below).

  app.get("/app/v/:vault/raw/*", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const v = await vaultOr404(c, user, c.req.param("vault"));
    if (!v) return c.text("Not found", 404);
    const r = await vaultStub(c.env, v).readNote(vaultRef(v), { identifier: restPath(c.req.path, "/raw/") });
    if (!r.ok || r.value.content === null) return c.text("Not found", 404);
    const filename = r.value.note.file_path.split("/").pop() ?? "note.md";
    return c.body(r.value.content, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
  });

  // ---- search, editor, graph (src/web/viewer) ----
  registerViewer(app);
  registerCapture(app);
  registerSharing(app);

  // ---- export ----
  app.get("/export", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const gate = needsReauth(c, "/export");
    if (gate) return gate;
    const zip = await buildExportZip(c.env, user.id, undefined, await accountJson(c.env, user));
    await audit(c.env, user.id, "export", null, c.req.header("cf-connecting-ip"));
    return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="cairn-${user.username}-${new Date().toISOString().slice(0, 10)}.zip"`,
    });
  });

  app.get("/export/:vault", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const gate = needsReauth(c, new URL(c.req.url).pathname);
    if (gate) return gate;
    const v = await vaultOr404(c, user, c.req.param("vault"));
    if (!v) return c.text("Not found", 404);
    // Owners and editors may download a project; readers read it in the app.
    if (!canWriteVault(v)) return c.text("Only the project's owner and editors can download it.", 403);
    const zip = await buildExportZip(c.env, user.id, v);
    return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="cairn-${v.name.replace("/", "-")}-${new Date().toISOString().slice(0, 10)}.zip"`,
    });
  });

  // ---- settings ----
  app.get("/app/settings", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const restricted = !!c.get("session")?.restricted;
    const creds = await c.env.DB.prepare("SELECT id, name, created_at, last_used_at, backed_up FROM credentials WHERE user_id = ? ORDER BY created_at")
      .bind(user.id)
      .all<{ id: string; name: string | null; created_at: string; last_used_at: string | null; backed_up: number }>();
    const addForm = html`<form data-passkey="add-passkey" class="mt-6 space-y-4">
        <div><label for="pkname">Name this passkey (e.g. "iPhone", "YubiKey")</label><input id="pkname" name="name" type="text" maxlength="64" class="h-11"></div>
        <button type="submit" class="btn btn-primary btn-lg w-full">${icon("fingerprint")} Add a passkey</button><p data-status class="m-0 text-center text-xs text-muted"></p></form>`;
    if (restricted) {
      return c.html(
        page(
          c,
          "Recovery",
          html`<h1 class="text-center text-2xl">Add a new passkey</h1><p class="mt-1 mb-0 text-center text-sm text-muted">You signed in with a recovery code. Add a passkey to finish; your other sessions will be signed out.</p>${addForm}`,
        ),
      );
    }
    const codesLeft = await remainingRecoveryCodes(c.env, user.id);
    const pats = await listPats(c.env, user.id);
    const mcpUrl = `${publicOrigin(c.env)}/mcp`;
    return c.html(
      page(
        c,
        "Settings",
        settingsLayout(
          null,
          { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) },
          html`${c.req.query("added") ? html`<p class="callout tip">Passkey added.</p>` : ""}
        ${panel(
          "Connect an assistant",
          "Give claude.ai, Claude Desktop or Claude Code your memory. You’ll sign in with your passkey and approve the connection.",
          html`<div class="space-y-6">
            <div><p class="mt-0 mb-2 flex items-center gap-2 text-sm font-semibold">${icon("bolt", "size-4 text-accent")} One-line setup</p>
              <p class="mt-0 mb-2 text-sm text-muted">Paste this into Claude or Codex. It checks the connection (and tells you how to add it if needed), asks how you want to use Cairn, installs the right skills and records your answers in a pinned note.</p>${copyLine("setup-line", setupLine(publicOrigin(c.env)))}</div>
            <div><p class="mt-0 mb-2 flex items-center gap-2 text-sm font-semibold">${icon("plug", "size-4 text-accent")} claude.ai / Claude Desktop</p>
              <p class="mt-0 mb-2 text-sm text-muted">Settings → Connectors → Add custom connector, URL:</p>${copyLine("mcp-url", mcpUrl)}</div>
            <div><p class="mt-0 mb-2 flex items-center gap-2 text-sm font-semibold">${icon("bolt", "size-4 text-accent")} Claude Code</p>${copyLine("cc-cmd", `claude mcp add --transport http cairn ${mcpUrl}`)}
              <p class="mt-2 mb-0 text-xs text-muted">Then run <code>/mcp</code> in Claude Code and choose Authenticate.</p></div>
            <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sunken px-4 py-3 text-sm ring-1 ring-line">
              <span>${creds.results.length} passkey(s) · ${codesLeft} unused recovery code(s)</span>
              <span class="flex gap-4"><a href="/app/settings/apps">Connected apps</a><a href="/app/settings/account">Passkeys &amp; security</a></span>
            </div>
          </div>`,
          { id: "connect", tab: "connect" },
        )}
        ${panel(
          "Personal access tokens",
          html`For MCP clients that can't do OAuth: send <code>Authorization: Bearer cairn_pat_…</code> to ${mcpUrl}.`,
          html`${
            pats.length
              ? html`<ul class="-mx-5 -mt-5 mb-5 divide-y divide-line border-b border-line sm:-mx-6">${pats.map(
                  (p) => html`<li class="flex flex-wrap items-center gap-3 px-5 py-3.5 sm:px-6">
                  <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warn-soft text-warn">${icon("key", "size-4")}</span>
                  <div class="min-w-0 flex-1"><p class="m-0 truncate text-sm font-medium">${p.name} <span class="badge ml-1">${p.scope}</span></p>
                    <p class="m-0 text-xs text-muted">expires ${when(p.expires_at) || "never"} · last used ${when(p.last_used_at) || "never"}</p></div>
                  <form class="inline" method="post" action="/app/settings/tokens/delete"><input type="hidden" name="id" value="${p.id}"><button class="danger small" type="submit">Revoke</button></form></li>`,
                )}</ul>`
              : ""
          }
          <form method="post" action="/app/settings/tokens" class="grid gap-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
            <div><label for="tname">Token name</label><input id="tname" name="name" type="text" required maxlength="64" placeholder="e.g. laptop script"></div>
            <div><label for="days">Expires in (days, blank = never)</label><input id="days" name="days" type="text" inputmode="numeric" value="90"></div>
            <button class="secondary" type="submit">Create token</button>
            <label class="sm:col-span-3"><input type="checkbox" name="write" value="1" checked> allow writes</label>
          </form>`,
          { id: "tokens", tab: "tokens" },
        )}
        ${panel(
          "Preferences",
          "How the app behaves for you, and where everything else lives.",
          html`<div class="divide-y divide-line">
            ${seriousModeSettings(c)}
            <div class="flex flex-wrap items-center justify-between gap-3 py-4"><div><p class="m-0 text-sm font-semibold">Download everything</p><p class="m-0 text-sm text-muted">A .zip of all your notes as markdown. Asks for your passkey.</p></div>
              <a class="button secondary" href="/export">${icon("download", "size-4")} Download everything (.zip of markdown)</a></div>
            <div class="flex flex-wrap items-center justify-between gap-3 py-4"><div><p class="m-0 text-sm font-semibold">Activity and undo</p><p class="m-0 text-sm text-muted">Every write by you and your assistants, with one-click revert.</p></div>
              <a class="button secondary" href="/app/activity">Open activity</a></div>
            <div class="flex flex-wrap items-center justify-between gap-3 py-4"><div><p class="m-0 text-sm font-semibold">Stats</p><p class="m-0 text-sm text-muted">Your memory, activity and AI usage.</p></div>
              <a class="button secondary" href="/app/stats">Open stats</a></div>
            <div class="py-4"><p class="m-0 text-sm font-semibold">Admin</p>
            ${
              user.is_admin
                ? html`<p class="m-0 text-sm text-muted">You are an admin. Sign-up is ${openSignup(c.env) ? "open" : "invite-only"}. <a href="/app/admin">Manage accounts</a>.</p>`
                : html`<form method="post" action="/app/settings/admin" class="mt-2 flex flex-wrap items-end gap-2"><div class="min-w-0 flex-1"><label for="st">Setup token</label><input id="st" name="token" type="password" autocomplete="off"></div><button class="secondary" type="submit">Become admin</button></form>`
            }</div>
            <p class="m-0 pt-4 text-xs text-faint">Cairn ${VERSION}</p>
          </div>`,
          { id: "preferences", tab: "preferences" },
        )}`,
        ),
      ),
    );
  });

  app.post("/app/settings/tokens", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect("/login", 303);
    const gate = needsReauth(c, "/app/settings");
    if (gate) return gate;
    const f = await c.req.formData();
    const days = Number(String(f.get("days") ?? "").trim() || 0);
    const scope = f.get("write") ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];
    const token = await createPat(c.env, user.id, String(f.get("name") ?? "token"), scope, Number.isFinite(days) && days > 0 ? days : null);
    await audit(c.env, user.id, "pat.create", { scope }, c.req.header("cf-connecting-ip"));
    return c.html(
      page(
        c,
        "New token",
        html`<h1>New personal access token</h1><p>Copy it now; it is shown only once.</p><pre class="cmd">${token}</pre><p><a href="/app/settings">Back to settings</a></p>`,
      ),
    );
  });

  app.post("/app/settings/tokens/delete", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect("/login", 303);
    await deletePat(c.env, user.id, String((await c.req.formData()).get("id") ?? ""));
    return c.redirect("/app/settings", 303);
  });

  app.post("/app/settings/admin", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect("/login", 303);
    const token = String((await c.req.formData()).get("token") ?? "");
    if (!c.env.CAIRN_SETUP_TOKEN || !safeEqual(token, c.env.CAIRN_SETUP_TOKEN)) {
      await audit(c.env, user.id, "admin.fail", null, c.req.header("cf-connecting-ip"));
      return c.html(page(c, "Admin", html`<p class="error">That setup token is not right.</p><p><a href="/app/settings">Back</a></p>`), 403);
    }
    await c.env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(user.id).run();
    await audit(c.env, user.id, "admin.grant", null, c.req.header("cf-connecting-ip"));
    return c.redirect("/app/settings", 303);
  });

  app.get("/app/settings/apps", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const grants = await c.env.OAUTH_PROVIDER.listUserGrants(user.id);
    // KV's list() lags new grants by ~30 s: add the ones approved in the last few minutes from D1.
    const items: { id: string; clientId: string; scope: string[]; createdAt: number }[] = [...grants.items];
    for (const r of await recentGrants(c.env, user.id)) if (!items.some((g) => g.id === r.id)) items.unshift(r);
    const rows = await Promise.all(
      items.map(async (g) => {
        let name = g.clientId;
        try {
          const client = await c.env.OAUTH_PROVIDER.lookupClient(g.clientId);
          name = client?.clientName ?? g.clientId;
        } catch {
          // CIMD document unreachable: show the client id
        }
        return { g, name };
      }),
    );
    return c.html(
      page(
        c,
        "Connected apps",
        settingsLayout(
          "apps",
          { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) },
          panel(
            "Connected apps",
            "Apps you allowed to use your memory through OAuth (claude.ai, Claude Code…). Revoking one signs it out at once.",
            rows.length
              ? html`<ul class="-mx-5 -my-5 divide-y divide-line sm:-mx-6">${rows.map(
                  ({ g, name }) => html`<li class="flex flex-wrap items-center gap-3 px-5 py-3.5 sm:px-6">
                  <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-accent-2">${icon("bolt", "size-5")}</span>
                  <div class="min-w-0 flex-1"><p class="m-0 truncate text-sm font-medium text-fg">${name}</p>
                    <p class="m-0 truncate text-xs text-muted"><span class="font-mono">${g.clientId}</span></p>
                    <p class="m-0 mt-1 flex flex-wrap gap-1.5">${g.scope.map((sc) => html`<span class="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-fg-2 ring-1 ring-line">${sc}</span>`)}<span class="text-xs text-muted">· connected ${when(new Date(g.createdAt * 1000).toISOString())}</span></p></div>
                  <form class="m-0" method="post" action="/app/settings/apps/revoke"><input type="hidden" name="grant" value="${g.id}"><button class="btn btn-secondary btn-sm text-danger" type="submit">Revoke</button></form></li>`,
                )}</ul>`
              : emptyState(
                  "bolt",
                  "No apps connected yet.",
                  "Connect claude.ai or Claude Code from the Connect section and it will show up here.",
                  html`<a class="btn btn-secondary" href="/app/settings#connect">${icon("plug", "size-4")}Connect Claude</a>`,
                ),
          ),
        ),
      ),
    );
  });

  app.post("/app/settings/apps/revoke", async (c) => {
    const user = requireUser(c);
    if (!user) return c.redirect("/login", 303);
    const grant = String((await c.req.formData()).get("grant") ?? "");
    await c.env.OAUTH_PROVIDER.revokeGrant(grant, user.id);
    await c.env.DB.prepare("DELETE FROM recent_grants WHERE grant_id = ? AND user_id = ?").bind(grant, user.id).run();
    await audit(c.env, user.id, "grant.revoke", { grant }, c.req.header("cf-connecting-ip"));
    return c.redirect("/app/settings/apps", 303);
  });

  // ---- OAuth authorize + consent ----
  const oauthErrorResponse = (c: Context<AppEnv>, error: unknown) => {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "This app could not be verified (its metadata document could not be fetched).";
      return c.html(
        page(
          c,
          "Authorization failed",
          html`<h1 class="text-center text-2xl">Authorization failed</h1>
          <p class="callout warning mt-6">${message}</p>
          <p class="mt-6 mb-0 text-center text-sm"><a href="/app">Back to ${c.env.APP_NAME || "Cairn"}</a></p>`,
          { auth: "shield" },
        ),
        400,
      );
    }
    throw error;
  };

  app.get("/authorize", async (c) => {
    const user = c.get("user");
    // Signed-out callers go to sign-in before anything resolves the client: no CIMD fetch,
    // no KV work, for anonymous traffic.
    if (!user) return c.redirect(loginRedirect(c.req.url));
    try {
      const request = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
      const details = await c.env.OAUTH_PROVIDER.describeConsent(request);
      const consent = await c.env.OAUTH_PROVIDER.beginConsent(request);
      const requested = details.scope.length ? details.scope : [SCOPE_READ, SCOPE_WRITE];
      const wantsWrite = requested.includes(SCOPE_WRITE) || !details.scope.length;
      const hidden = requested.filter((s) => s !== SCOPE_READ && s !== SCOPE_WRITE && s === "offline_access");
      const body = html`<p class="eyebrow mb-2 text-center">Connect an app</p>
        <h1 class="text-center text-2xl text-balance">Allow ${details.clientName} to use your memory?</h1>
        <p class="mt-2 mb-0 text-center text-sm text-muted">${details.clientDomain ? html`Published by <strong class="text-fg">${details.clientDomain}</strong>.` : html`This app registered itself; its name is not verified.`}
          Access will be sent to <strong class="text-fg">${details.redirectHost}</strong>.</p>
        ${details.redirectIsLoopback ? html`<p class="callout warning mt-5"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>` : ""}
        <form method="post" action="/authorize" class="mt-6">
          <input type="hidden" name="handle" value="${consent.handle}">
          <input type="hidden" name="scope" value="${SCOPE_READ}">
          ${hidden.map((s) => html`<input type="hidden" name="scope" value="${s}">`)}
          <fieldset class="m-0 divide-y divide-line rounded-2xl border-0 p-0 ring-1 ring-line">
            <legend class="sr-only">What it can do</legend>
            <label class="m-0 flex cursor-default items-start gap-3 px-4 py-3.5 font-normal"><input type="checkbox" checked disabled class="mt-1">
              <span><span class="block text-sm font-semibold text-fg">Read notes</span><span class="block text-xs text-muted">Search and read every project.</span></span></label>
            <label class="m-0 flex cursor-pointer items-start gap-3 px-4 py-3.5 font-normal"><input type="checkbox" name="scope" value="${SCOPE_WRITE}" ${wantsWrite ? "checked" : ""} class="mt-1">
              <span><span class="block text-sm font-semibold text-fg">Create, edit and delete notes</span><span class="block text-xs text-muted">Every change is kept in the note’s history.</span></span></label>
          </fieldset>
          <p class="mt-4 mb-0 text-center text-xs text-muted">Signed in as <strong class="text-fg">${user.username}</strong>. It will be able to use all your projects. You can disconnect it any time in Settings → Connected apps.</p>
          <div class="mt-6 flex flex-row-reverse gap-3">
            <button class="btn btn-primary btn-lg flex-1" name="decision" value="approve" type="submit">Allow</button>
            <button class="btn btn-secondary btn-lg flex-1" name="decision" value="deny" type="submit">Deny</button>
          </div>
        </form>`;
      const resp = await c.html(page(c, `Authorize ${escapeHtml(details.clientName)}`, body, { auth: "plug" }));
      const headers = new Headers(resp.headers);
      consent.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") headers.append(key, value);
        else headers.set(key, value);
      });
      if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", CSP);
      return new Response(resp.body, { status: 200, headers });
    } catch (error) {
      return oauthErrorResponse(c, error);
    }
  });

  app.post("/authorize", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    try {
      const form = await c.req.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await c.env.OAUTH_PROVIDER.denyConsent(c.req.raw, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const scope = [...new Set(form.getAll("scope").map(String))];
      const approved = await c.env.OAUTH_PROVIDER.approveConsent(c.req.raw, handle, { scope });
      const details = await c.env.OAUTH_PROVIDER.describeConsent(approved.request);
      const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
        request: approved.request,
        userId: user.id,
        metadata: { clientName: details.clientName },
        scope: approved.request.scope,
        props: { userId: user.id, username: user.username, clientName: details.clientName, issuedAt: Date.now() },
      });
      await rememberGrant(c.env, user.id, redirectTo, details.clientId, approved.request.scope);
      await audit(c.env, user.id, "oauth.approve", { client: details.clientId, scope: approved.request.scope }, c.req.header("cf-connecting-ip"));
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      return oauthErrorResponse(c, error);
    }
  });

  registerRound2(app, page as never, loginRedirect);
  registerSite(app, page as never);
  registerAccount(app, page as never, loginRedirect);
  registerImport(app, page as never, loginRedirect);
  registerFun(app, page as never, loginRedirect);

  app.notFound((c) =>
    c.html(
      page(
        c,
        "Not found",
        html`<div class="card mt-4">${emptyState("search", "Not found", "There’s nothing at this address.", html`<a class="btn btn-secondary" href="/app">${icon("home", "size-4")}Home</a>`)}</div>`,
      ),
      404,
    ),
  );
  return app;
}

/** How long a just-approved grant is listed from D1 while KV's list() catches up. */
const RECENT_GRANT_SECONDS = 15 * 60;

/**
 * The grant id inside an authorization code the provider issued. Its codes are
 * "<userId>:<grantId>:<secret>" (workers-oauth-provider 1.x; test/oauth-recent.test.ts pins it);
 * anything else yields null, and Connected apps then relies on KV's list alone.
 */
export function grantIdFromRedirect(redirectTo: string, userId: string): string | null {
  try {
    const code = new URL(redirectTo).searchParams.get("code") ?? "";
    const parts = code.split(":");
    return parts.length === 3 && parts[0] === userId && /^[A-Za-z0-9_-]{8,64}$/.test(parts[1]) ? parts[1] : null;
  } catch {
    return null;
  }
}

async function rememberGrant(env: AppEnv["Bindings"], userId: string, redirectTo: string, clientId: string, scope: string[]) {
  const id = grantIdFromRedirect(redirectTo, userId);
  if (!id) return;
  await env.DB.prepare("INSERT OR IGNORE INTO recent_grants (grant_id, user_id, client_id, scope, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, userId, clientId.slice(0, 500), JSON.stringify(scope), Math.floor(Date.now() / 1000))
    .run()
    .catch(() => {});
}

async function recentGrants(env: AppEnv["Bindings"], userId: string) {
  const cutoff = Math.floor(Date.now() / 1000) - RECENT_GRANT_SECONDS;
  await env.DB.prepare("DELETE FROM recent_grants WHERE user_id = ? AND created_at < ?")
    .bind(userId, cutoff)
    .run()
    .catch(() => {});
  const rows = await env.DB.prepare("SELECT grant_id, client_id, scope, created_at FROM recent_grants WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
    .bind(userId)
    .all<{ grant_id: string; client_id: string; scope: string; created_at: number }>()
    .catch(() => ({ results: [] as { grant_id: string; client_id: string; scope: string; created_at: number }[] }));
  return rows.results.map((r) => ({ id: r.grant_id, clientId: r.client_id, scope: JSON.parse(r.scope) as string[], createdAt: r.created_at }));
}
