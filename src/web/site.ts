// The claim page (first run, no setup token) and the admin's "This Cairn" panel: canonical URL,
// moving it, running version and the update notice. Logic lives in src/site.ts and src/update.ts.

import type { Context, Hono } from "hono";
import { audit } from "../directory";
import { publicOrigin, VERSION } from "../env";
import { CLAIM_TTL_MS, claimOpen, issueClaimCode, liveClaimCode, loadSite, parseSiteUrl, recordCanonical } from "../site";
import { UPSTREAM, updateStatus } from "../update";
import { needsReauth } from "./account";
import { type H, html, icon, when } from "./layout";
import type { AppEnv } from "./types";
import { panel } from "./ui";

type Page = (c: never, title: string, body: H, extra?: { auth?: boolean | string }) => H;

export function registerSite(app: Hono<AppEnv>, page: Page) {
  const claimPage = (c: Context<AppEnv>, msg: H | string = "") =>
    page(
      c as never,
      "Claim this Cairn",
      html`<h1 class="text-center text-2xl">Claim this Cairn</h1>
      <p class="mt-1 mb-0 text-center text-sm text-muted">This Cairn has no admin yet. Whoever claims it first owns it, so do it now.</p>
      ${msg}
      <ol class="mt-6 space-y-2 text-sm">
        <li>In the Cloudflare dashboard open <strong>Workers &amp; Pages → this Worker → Logs</strong> (or run <code>npx wrangler tail</code>) and find the line <code>Cairn claim code: XXXXX-XXXXX</code>. Each code works for ${CLAIM_TTL_MS / 60e3} minutes.</li>
        <li>Enter it below with a username, and create your passkey. You become the admin, and this page goes away for good.</li>
      </ol>
      <form data-passkey="signup" data-next="/app" class="mt-6 space-y-4">
        <div><label for="claimCode">Claim code</label>
        <input id="claimCode" name="claimCode" type="text" autocomplete="one-time-code" required minlength="10" maxlength="16" placeholder="XXXXX-XXXXX" class="h-11 font-mono uppercase"></div>
        <div><label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username webauthn" required minlength="2" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{1,31}" placeholder="e.g. ada" class="h-11"></div>
        <button type="submit" class="btn btn-primary btn-lg w-full">${icon("fingerprint")} Claim with a passkey</button>
        <p data-status class="m-0 text-center text-xs text-muted">Your passkey will be tied to ${new URL(c.env.PUBLIC_URL).hostname}: claim at the address you will keep using.</p>
      </form>
      <form method="post" action="/claim/new" class="mt-4 text-center"><button class="btn btn-secondary btn-sm" type="submit">Write a new code to the logs</button></form>
      <div id="recovery" hidden class="mt-6">
        <h2 class="mt-0 mb-1 text-lg">Save your recovery codes</h2>
        <p class="mt-0 text-sm text-muted">Each code signs you in once if you lose your passkeys. They are shown only now.</p>
        <pre class="codes" id="signup-codes"></pre>
        <div class="flex gap-2">
          <button type="button" class="btn btn-secondary flex-1" data-copy-from="signup-codes" hidden>${icon("copy", "size-4")} Copy</button>
          <button type="button" class="btn btn-secondary flex-1" data-download-from="signup-codes" data-filename="cairn-recovery-codes.txt" data-download-head="Cairn recovery codes. Use one at /recover if you lose your passkeys; each works once.&#10;&#10;" hidden>${icon("download", "size-4")} Download</button>
        </div>
        <a class="button continue mt-4 w-full py-2.5" href="/app">I saved them, continue</a>
      </div>`,
      { auth: true },
    );

  app.get("/claim", async (c) => {
    if (!claimOpen(c.env, await loadSite(c.env))) return c.redirect("/", 303);
    // A live code may already be in the log; only write one when there is none.
    let msg: H | string = "";
    const live = await liveClaimCode(c.env);
    if (!live) {
      const r = await issueClaimCode(c.env, publicOrigin(c.env));
      msg = r.ok ? html`<p class="callout tip mt-6">A claim code was just written to the Worker's logs.</p>` : "";
    } else {
      msg = html`<p class="callout tip mt-6">The latest claim code was written to the logs ${when(live)}.</p>`;
    }
    return c.html(claimPage(c, msg));
  });

  app.post("/claim/new", async (c) => {
    if (!claimOpen(c.env, await loadSite(c.env))) return c.notFound();
    const r = await issueClaimCode(c.env, publicOrigin(c.env));
    await audit(c.env, null, "claim.code", null, c.req.header("cf-connecting-ip"));
    return c.html(
      claimPage(
        c,
        r.ok
          ? html`<p class="callout tip mt-6">A new claim code was written to the Worker's logs.</p>`
          : html`<p class="callout warning mt-6">A code was written less than a minute ago; use that one, or try again in ${r.retryAfter} s.</p>`,
      ),
      r.ok ? 200 : 429,
    );
  });

  app.post("/app/admin/site", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    if (!user.is_admin) return c.text("Only admins can change this.", 403);
    const gate = needsReauth(c, "/app/admin");
    if (gate) return gate;
    const back = (m: string, status: 400 | 403) =>
      c.html(page(c as never, "Admin", html`<p class="error">${m}</p><p><a href="/app/admin">Back</a></p>`), status);
    if (c.env.CAIRN_URL_SOURCE === "env") return back("PUBLIC_URL is set in the Worker's configuration, so the URL is fixed there.", 403);
    const f = await c.req.formData();
    const next = parseSiteUrl(String(f.get("url") ?? ""));
    if (!next) return back("Enter an https:// address with no path, e.g. https://cairn.example.com.", 400);
    if (f.get("confirm") !== "1") return back("Tick the box to confirm that passkeys will stop working.", 400);
    const prev = publicOrigin(c.env);
    if (next === prev) return c.redirect("/app/admin", 303);
    await recordCanonical(c.env, next, true);
    await audit(c.env, user.id, "site.url", { from: prev, to: next }, c.req.header("cf-connecting-ip"));
    // Sessions are per host: sign in at the new address (with a recovery code, until a new passkey).
    return c.redirect(`${next}/recover`, 303);
  });
}

/** Settings → Admin: canonical URL, version and update notice. */
export async function sitePanel(c: Context<AppEnv>): Promise<H> {
  const origin = publicOrigin(c.env);
  const pinned = c.env.CAIRN_URL_SOURCE === "env" || !c.env.CAIRN_URL_SOURCE;
  const up = await updateStatus(c.env);
  const commit = up.commit ? html` · <code>${up.commit.slice(0, 7)}</code>` : "";
  return panel(
    "This Cairn",
    "Its address and version.",
    html`<div class="divide-y divide-line">
      <div class="pb-4"><p class="m-0 text-sm font-semibold">Address</p>
        <p class="m-0 text-sm"><code>${origin}</code> <span class="text-muted">· ${pinned ? "set by PUBLIC_URL in the Worker's configuration" : "recorded when this Cairn was claimed"}</span></p>
        ${
          pinned
            ? ""
            : html`<details class="mt-3 text-sm"><summary>Move to another address</summary>
          <p class="callout warning mt-3">Passkeys are bound to the address. After a move, <strong>every existing passkey stops working</strong> for everyone: sign in at the new address with a recovery code, then add a new passkey. Connected apps must be reconnected. The new address must already reach this Worker (add the custom domain in Cloudflare first), or nobody can sign in; setting PUBLIC_URL in the Worker's variables always overrides this.</p>
          <form method="post" action="/app/admin/site" class="mt-3 space-y-3">
            <div><label for="site-url">New address</label><input id="site-url" name="url" type="url" required placeholder="https://cairn.example.com"></div>
            <label><input type="checkbox" name="confirm" value="1" required> I understand existing passkeys will stop working</label>
            <button class="btn btn-danger" type="submit">Move Cairn</button>
          </form></details>`
        }
      </div>
      <div class="pt-4"><p class="m-0 text-sm font-semibold">Version</p>
        <p class="m-0 text-sm">Cairn ${VERSION}${commit}</p>
        ${
          up.available
            ? html`<p class="callout tip mt-3">Update available (${up.reason}). In your copy of the repository on GitHub, run <strong>Actions → Update Cairn</strong> (or <strong>Sync fork</strong> if it is a fork of <a href="https://github.com/${UPSTREAM}">${UPSTREAM}</a>); Cloudflare redeploys it.</p>`
            : up.checkedAt
              ? html`<p class="m-0 mt-1 text-xs text-muted">Checked ${when(new Date(up.checkedAt).toISOString())} against <a href="https://github.com/${UPSTREAM}">${UPSTREAM}</a>.</p>`
              : ""
        }
      </div>
    </div>`,
    { id: "instance" },
  );
}
