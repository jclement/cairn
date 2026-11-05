// Account settings: passkeys (list, add, rename, remove), recovery codes, re-authentication gate,
// and deleting the account. Sensitive actions need a fresh passkey assertion (reauth) on the session.

import type { Context, Hono } from "hono";
import { deleteAccount } from "../account";
import { audit, clearSessionCookie, issueRecoveryCodes, remainingRecoveryCodes, type Session } from "../directory";
import { importEnabled } from "./importer";
import { type H, html, icon, when } from "./layout";
import { safeNext } from "./next";
import type { AppEnv } from "./types";
import { focusCard, panel, settingsLayout } from "./ui";

type Page = (c: never, title: string, body: H, extra?: { vault?: string; q?: string; auth?: boolean | string }) => H;

export const REAUTH_WINDOW_MS = 5 * 60e3;

/** True if this session proved possession of a passkey in the last 5 minutes (recovery sessions never do). */
export function reauthFresh(session: Session | undefined): boolean {
  if (!session || session.restricted || !session.reauth_at) return false;
  return Date.now() - Date.parse(session.reauth_at) < REAUTH_WINDOW_MS;
}

/** Redirect to the passkey confirmation page unless the session re-authenticated recently. */
export function needsReauth(c: Context<AppEnv>, next: string): Response | null {
  if (reauthFresh(c.get("session"))) return null;
  return c.redirect(`/app/reauth?next=${encodeURIComponent(next)}`, 303);
}

export async function accountStatus(env: AppEnv["Bindings"], userId: string) {
  const passkeys = (await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?").bind(userId).first<{ n: number }>())?.n ?? 0;
  return { passkeys, codes: await remainingRecoveryCodes(env, userId) };
}

/** Nag on /app when the account can't survive losing one device. */
export async function safetyNag(env: AppEnv["Bindings"], userId: string): Promise<H> {
  const s = await accountStatus(env, userId);
  if (s.codes > 0 && s.passkeys > 1) return html``;
  return html`<p class="callout warning small">
    ${s.codes === 0 ? html`You have no unused recovery codes.` : ""}
    ${s.passkeys < 2 ? html`You have only one passkey.` : ""}
    If you lose that device you could lose this account. <a href="/app/settings/account">Fix it in Account settings</a>.</p>`;
}

export function registerAccount(app: Hono<AppEnv>, page: Page, loginRedirect: (url: string) => string) {
  app.get("/app/reauth", (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const next = c.req.query("next");
    return c.html(
      page(
        c as never,
        "Confirm it's you",
        html`<h1 class="text-center text-2xl">Confirm it's you</h1>
        <p class="mt-1 mb-0 text-center text-sm text-muted">This action needs a fresh check with one of your passkeys. It lasts five minutes.</p>
        <form data-passkey="reauth" data-next="${safeNext(next, "/app/settings/account")}" class="mt-6 space-y-3">
          <button type="submit" class="btn btn-primary btn-lg w-full">${icon("fingerprint")} Confirm with a passkey</button><p data-status class="m-0 min-h-4 text-center text-xs text-muted"></p>
        </form>
        <p class="mt-5 mb-0 border-t border-line pt-5 text-center text-sm"><a href="/app">Cancel</a></p>`,
        { auth: true },
      ),
    );
  });

  app.get("/app/settings/account", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const creds = await c.env.DB.prepare(
      "SELECT id, name, created_at, last_used_at, device_type, backed_up FROM credentials WHERE user_id = ? ORDER BY created_at",
    )
      .bind(user.id)
      .all<{ id: string; name: string | null; created_at: string; last_used_at: string | null; device_type: string | null; backed_up: number }>();
    const codes = await remainingRecoveryCodes(c.env, user.id);
    const msg = c.req.query("msg");
    return c.html(
      page(
        c as never,
        "Account",
        settingsLayout(
          "security",
          { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) },
          html`${msg ? html`<p class="callout tip mt-0">${msg}</p>` : ""}
        ${panel(
          "Passkeys",
          "Each passkey can sign you in. Keep at least two (say, your phone and a laptop or security key) so losing one device doesn't lock you out.",
          html`<ul class="-mx-5 -mt-5 mb-5 divide-y divide-line border-b border-line sm:-mx-6">${creds.results.map(
            (k) => html`<li class="flex flex-wrap items-center gap-3 px-5 py-4 sm:px-6">
              <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-accent-2">${icon("key", "size-5")}</span>
              <form class="flex min-w-0 flex-1 basis-56 items-center gap-2" method="post" action="/app/settings/passkeys/rename">
                <input type="hidden" name="id" value="${k.id}"><input name="name" type="text" maxlength="64" value="${k.name ?? "passkey"}" aria-label="Passkey name" class="min-w-0 flex-1 font-medium">
                <button class="secondary small" type="submit">Rename</button></form>
              <span class="basis-full text-xs text-muted sm:basis-auto">${k.device_type === "multiDevice" ? "synced" : k.device_type === "singleDevice" ? "this device only" : "—"}${k.backed_up ? " · backed up" : ""} · added ${when(k.created_at)} · last used ${when(k.last_used_at) || "never"}</span>
              <form class="inline" method="post" action="/app/settings/passkeys/delete"><input type="hidden" name="id" value="${k.id}">
                <button class="danger small" type="submit">Remove</button></form>
            </li>`,
          )}</ul>
          <form data-passkey="add-passkey" class="flex flex-wrap items-end gap-3">
            <div class="min-w-0 flex-1 basis-56"><label for="pkname">Add a passkey: name it (e.g. "iPhone", "YubiKey")</label><input id="pkname" name="name" type="text" maxlength="64"></div>
            <button type="submit">${icon("plus", "size-4")} Add a passkey</button><p data-status class="m-0 basis-full text-xs text-muted"></p>
          </form>`,
        )}
        ${panel(
          "Recovery codes",
          html`If you lose all your passkeys, go to <a href="/recover">/recover</a>, enter your username and one code. You'll be signed in only to add a new passkey; your other sessions are then signed out. Each code works once.`,
          html`<div class="flex flex-wrap items-center justify-between gap-4">
            <p class="m-0 text-sm"><strong>${codes}</strong> unused code(s).</p>
            <form method="post" action="/app/settings/recovery" class="text-right"><button class="secondary" type="submit">Generate new recovery codes</button>
              <span class="mt-1 block text-xs text-muted">Asks for your passkey. Your current codes stop working.</span></form>
          </div>`,
        )}
        ${panel(
          "Download everything",
          "A .zip of all your notes as markdown, with [[links]] intact. Asks for your passkey.",
          html`<a class="button secondary" href="/export">${icon("download", "size-4")} Download a .zip of all your notes</a>`,
        )}
        <section class="mb-6 rounded-2xl p-5 ring-1 ring-danger/30 sm:p-6">
          <h2 class="mt-0 mb-1 text-base text-danger">Danger zone</h2>
          <p class="mt-0 text-sm text-muted">Deleting your account removes every note, project, passkey and token. It can't be undone.</p>
          <a class="button danger" href="/app/settings/delete">Delete your account…</a>
        </section>`,
        ),
      ),
    );
  });

  app.post("/app/settings/passkeys/rename", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const f = await c.req.formData();
    const name =
      String(f.get("name") ?? "")
        .trim()
        .slice(0, 64) || "passkey";
    await c.env.DB.prepare("UPDATE credentials SET name = ? WHERE id = ? AND user_id = ?")
      .bind(name, String(f.get("id") ?? ""), user.id)
      .run();
    return c.redirect("/app/settings/account?msg=Renamed.", 303);
  });

  app.post("/app/settings/passkeys/delete", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const gate = needsReauth(c, "/app/settings/account");
    if (gate) return gate;
    const f = await c.req.formData();
    const id = String(f.get("id") ?? "");
    const confirmLast = f.get("confirm_last") === "1";
    // One atomic statement: delete only if this user owns the key AND either another key remains,
    // or this is an explicitly confirmed last-key removal and an unused recovery code exists.
    const del = await c.env.DB.prepare(
      `DELETE FROM credentials WHERE id = ?1 AND user_id = ?2 AND (
         (SELECT COUNT(*) FROM credentials WHERE user_id = ?2) > 1
         OR (?3 = 1 AND (SELECT COUNT(*) FROM recovery_codes WHERE user_id = ?2 AND used_at IS NULL) > 0))`,
    )
      .bind(id, user.id, confirmLast ? 1 : 0)
      .run();
    if (!(del.meta.changes ?? 0)) {
      const owned = await c.env.DB.prepare("SELECT 1 AS x FROM credentials WHERE id = ? AND user_id = ?").bind(id, user.id).first();
      if (!owned) return c.redirect("/app/settings/account?msg=That passkey no longer exists.", 303);
      const { codes } = await accountStatus(c.env, user.id);
      if (codes === 0) {
        return c.html(
          page(
            c as never,
            "Can't remove",
            focusCard(
              "shield",
              "Can't remove your last passkey",
              html`<p>You have no unused recovery codes, so you would have no way to sign in. Add another passkey or generate recovery codes first.</p><p class="mb-0"><a class="btn btn-secondary" href="/app/settings/account">Back</a></p>`,
              "danger",
            ),
          ),
          400,
        );
      }
      return c.html(
        page(
          c as never,
          "Remove last passkey?",
          focusCard(
            "key",
            "Remove your last passkey?",
            html`<p class="callout warning">After this you can only sign in with one of your ${codes} recovery code(s) at /recover. If you lose them too, this account and its notes are gone for good.</p>
          <form method="post" action="/app/settings/passkeys/delete" class="m-0 flex flex-wrap gap-2"><input type="hidden" name="id" value="${id}"><input type="hidden" name="confirm_last" value="1">
            <button class="btn btn-danger" type="submit">Yes, remove it</button> <a class="btn btn-ghost" href="/app/settings/account">Cancel</a></form>`,
            "danger",
          ),
        ),
      );
    }
    await audit(c.env, user.id, "passkey.remove", null, c.req.header("cf-connecting-ip"));
    return c.redirect("/app/settings/account?msg=Passkey removed.", 303);
  });

  app.post("/app/settings/recovery", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const gate = needsReauth(c, "/app/settings/account");
    if (gate) return gate;
    const codes = await issueRecoveryCodes(c.env, user.id);
    await audit(c.env, user.id, "recovery.regenerate", null, c.req.header("cf-connecting-ip"));
    const txt = `Cairn recovery codes for ${user.username}\nUse one at /recover if you lose your passkeys. Each works once.\n\n${codes.join("\n")}\n`;
    return c.html(
      page(
        c as never,
        "Recovery codes",
        focusCard(
          "key",
          "New recovery codes",
          html`<p class="mt-0 text-sm text-muted">Save these now; they are shown only once. Your old codes no longer work.</p>
        <pre class="codes" id="codes">${codes.join("\n")}</pre>
        <div class="flex gap-2"><button type="button" class="btn btn-secondary flex-1" data-copy="codes" data-copy-from="codes" hidden>${icon("copy", "size-4")}Copy</button>
          <a class="btn btn-secondary flex-1" download="cairn-recovery-codes.txt" href="data:text/plain;charset=utf-8,${encodeURIComponent(txt)}">${icon("download", "size-4")}Download .txt</a></div>
        <p class="mb-0"><a class="btn btn-primary mt-4 w-full" href="/app/settings/account">I saved them</a></p>`,
        ),
      ),
    );
  });

  // ---- delete account ----
  app.get("/app/settings/delete", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const resuming = !!user.deleting_at;
    return c.html(
      page(
        c as never,
        "Delete account",
        focusCard(
          "trash",
          "Delete your account",
          html`${
            resuming
              ? html`<p class="callout warning">Deleting this account didn't finish last time. Confirm again to finish the job.</p>`
              : html`<p class="callout tip">${icon("download", "size-5 shrink-0 text-ok")}<span>First, <a href="/export">download everything</a> if you want to keep your notes.</span></p>`
          }
        <p class="text-sm">This deletes every note and project, their history and search index, your passkeys, recovery codes, tokens and connected apps. It can't be undone.</p>
        <form method="post" action="/app/settings/delete" class="mt-5 border-t border-line pt-5">
          <label for="confirm">Type your username, <strong>${user.username}</strong>, to confirm</label>
          <input id="confirm" name="confirm" type="text" autocomplete="off" required>
          <div class="mt-4 flex flex-wrap items-center gap-3"><button class="btn btn-danger" type="submit">Delete my account</button> <span class="small muted">Asks for your passkey.</span>
          <a class="btn btn-ghost ml-auto" href="/app/settings/account">Cancel</a></div>
        </form>`,
          "danger",
        ),
      ),
    );
  });

  app.post("/app/settings/delete", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const gate = needsReauth(c, "/app/settings/delete");
    if (gate) return gate;
    const f = await c.req.formData();
    if (
      String(f.get("confirm") ?? "")
        .trim()
        .toLowerCase() !== user.username.toLowerCase()
    ) {
      return c.html(
        page(
          c as never,
          "Delete account",
          focusCard(
            "trash",
            "Nothing was deleted",
            html`<p class="error">The username didn't match. Nothing was deleted.</p><p class="mb-0"><a class="btn btn-secondary" href="/app/settings/delete">Back</a></p>`,
            "danger",
          ),
        ),
        400,
      );
    }
    try {
      await deleteAccount(c.env, c.env.OAUTH_PROVIDER, user.id);
    } catch (e) {
      return c.html(
        page(
          c as never,
          "Delete account",
          focusCard(
            "trash",
            "Deletion didn't finish",
            html`<p class="error">${(e as Error).message}</p><p class="mb-0">Your account is locked and partly deleted. <a href="/app/settings/delete">Try again</a> to finish.</p>`,
            "danger",
          ),
        ),
        500,
      );
    }
    c.header("Set-Cookie", clearSessionCookie());
    return c.html(
      page(
        c as never,
        "Account deleted",
        html`<h1 class="text-center text-2xl">Your account has been deleted</h1><p class="mb-0 text-center text-sm text-muted">Everything is gone. Thanks for trying Cairn.</p>
        <p class="mt-6 mb-0 text-center"><a class="btn btn-secondary" href="/">Back to the home page</a></p>`,
        { auth: "sparkle" },
      ),
    );
  });
}
