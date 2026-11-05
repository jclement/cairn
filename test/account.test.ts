// Jeff's account asks: multiple passkeys, recovery codes, reauth-gated download/delete, delete account.
import { env, runInDurableObject } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { WebAuthnVerifier } from "../src/auth/webauthn";
import { createInvite, createPat, getUser, remainingRecoveryCodes, resolvePat } from "../src/directory";
import { createApp } from "../src/web/app";
import { caller, defaultVault, freshReauth, makeUser, ORIGIN } from "./helpers";
import { fetchWorker, getAccessToken } from "./oauth";

// MOCKED: only the WebAuthn verify step (a response with ok:true verifies).
const fake: WebAuthnVerifier = {
  async verifyRegistration({ response }) {
    const r = response as unknown as { id: string; ok?: boolean };
    return r.ok ? { id: r.id, publicKey: new Uint8Array([1]), counter: 0, transports: ["internal"], deviceType: "multiDevice", backedUp: true } : null;
  },
  async verifyAuthentication({ response, credential }) {
    return (response as unknown as { ok?: boolean }).ok ? { newCounter: credential.counter + 1 } : null;
  },
};
const app = createApp({ verifier: fake });
const json = (path: string, body: unknown, cookie = "") =>
  app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) },
    env,
  );
const form = (cookie: string, data: Record<string, string>) => ({
  method: "POST",
  headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});
const sessionFrom = (res: Response) => /(__Host-cairn_session=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";

async function signup(username: string) {
  const o = (await (await json("/auth/signup/options", { username })).json()) as { challengeId: string };
  const v = await json("/auth/signup/verify", { challengeId: o.challengeId, response: { id: `cred-${username}`, ok: true } });
  const body = (await v.json()) as { recoveryCodes: string[] };
  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<{ id: string }>();
  return { cookie: sessionFrom(v), codes: body.recoveryCodes, userId: user?.id as string, credId: `cred-${username}` };
}
async function reauth(cookie: string, credId: string) {
  const o = (await (await json("/auth/reauth/options", {}, cookie)).json()) as { challengeId: string; options: { allowCredentials: { id: string }[] } };
  const r = await json("/auth/reauth/verify", { challengeId: o.challengeId, response: { id: credId, ok: true } }, cookie);
  return { status: r.status, allowed: o.options?.allowCredentials?.map((c) => c.id) ?? [] };
}
const name = (p: string) => `${p}${Date.now() % 1e7}${Math.floor(Math.random() * 1000)}`;

describe("re-authentication gate", () => {
  it("export and other sensitive actions need a passkey assertion from the last 5 minutes", async () => {
    const a = await signup(name("ra"));
    const gated = await app.request("/export", { headers: { cookie: a.cookie } }, env);
    expect(gated.status).toBe(303);
    expect(gated.headers.get("location")).toBe("/app/reauth?next=%2Fexport");
    const r = await reauth(a.cookie, a.credId);
    expect(r.status).toBe(200);
    expect(r.allowed).toEqual([a.credId]);
    const ok = await app.request("/export", { headers: { cookie: a.cookie } }, env);
    expect(ok.status).toBe(200);
    // expires after 5 minutes
    await env.DB.prepare("UPDATE sessions SET reauth_at = ? WHERE user_id = ?")
      .bind(new Date(Date.now() - 6 * 60e3).toISOString(), a.userId)
      .run();
    expect((await app.request("/export", { headers: { cookie: a.cookie } }, env)).status).toBe(303);
  });

  it("refuses another account's passkey and recovery sessions", async () => {
    const a = await signup(name("rb"));
    const b = await signup(name("rc"));
    expect((await reauth(a.cookie, b.credId)).status).toBe(400);
    const rec = await json("/auth/recover", { username: (await getUser(env, a.userId))?.username, code: a.codes[0] });
    const rc = sessionFrom(rec);
    const refused = await json("/auth/reauth/options", {}, rc);
    expect(refused.status).toBe(303); // recovery sessions are sent to "add a passkey" and never reach reauth
    expect(refused.headers.get("location")).toContain("recovered=1");
  });

  it("creating a token needs reauth", async () => {
    const { user, cookie } = await makeUser();
    const res = await fetchWorker("/app/settings/tokens", form(cookie, { name: "t" }));
    expect(res.headers.get("location")).toMatch(/^\/app\/reauth/);
    await freshReauth(user.id);
    expect(await (await fetchWorker("/app/settings/tokens", form(cookie, { name: "t" }))).text()).toContain("cairn_pat_");
  });
});

describe("passkeys and recovery codes", () => {
  it("lists, adds, renames and removes passkeys; the last one only with codes and confirmation", async () => {
    const a = await signup(name("pk"));
    await freshReauth(a.userId); // adding a passkey needs a fresh check with an existing one
    const o = (await (await json("/auth/passkey/options", {}, a.cookie)).json()) as { challengeId: string };
    expect(
      (await json("/auth/passkey/verify", { challengeId: o.challengeId, response: { id: "second-key", ok: true }, name: "YubiKey" }, a.cookie)).status,
    ).toBe(200);
    let pageHtml = await (await app.request("/app/settings/account", { headers: { cookie: a.cookie } }, env)).text();
    expect(pageHtml).toContain('value="YubiKey"');
    expect(pageHtml).toContain("synced · backed up");
    await app.request("/app/settings/passkeys/rename", form(a.cookie, { id: "second-key", name: "Blue key" }), env);
    pageHtml = await (await app.request("/app/settings/account", { headers: { cookie: a.cookie } }, env)).text();
    expect(pageHtml).toContain('value="Blue key"');
    // removing needs reauth (expire the one used for enrolling)
    await env.DB.prepare("UPDATE sessions SET reauth_at = NULL WHERE user_id = ?").bind(a.userId).run();
    expect((await app.request("/app/settings/passkeys/delete", form(a.cookie, { id: "second-key" }), env)).headers.get("location")).toMatch(/^\/app\/reauth/);
    await freshReauth(a.userId);
    expect((await app.request("/app/settings/passkeys/delete", form(a.cookie, { id: "second-key" }), env)).status).toBe(303);
    // last passkey: confirmation page first
    const confirm = await (await app.request("/app/settings/passkeys/delete", form(a.cookie, { id: a.credId }), env)).text();
    expect(confirm).toContain("Remove your last passkey?");
    expect(confirm).toContain("10 recovery code(s)");
    // with no codes: refused outright
    await env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ?").bind(new Date().toISOString(), a.userId).run();
    expect((await app.request("/app/settings/passkeys/delete", form(a.cookie, { id: a.credId, confirm_last: "1" }), env)).status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?").bind(a.userId).first<{ n: number }>())?.n).toBe(1);
  });

  it("regenerating recovery codes needs reauth, shows them once with copy/download, and voids the old ones", async () => {
    const a = await signup(name("rcode"));
    expect((await app.request("/app/settings/recovery", form(a.cookie, {}), env)).headers.get("location")).toMatch(/^\/app\/reauth/);
    await freshReauth(a.userId);
    const html = await (await app.request("/app/settings/recovery", form(a.cookie, {}), env)).text();
    const codes = /<pre class="codes" id="codes">([^<]+)<\/pre>/.exec(html)?.[1].split("\n") ?? [];
    expect(codes.length).toBe(10);
    expect(html).toContain('data-copy="codes"');
    expect(html).toContain('download="cairn-recovery-codes.txt" href="data:text/plain;charset=utf-8,');
    expect((await json("/auth/recover", { username: (await getUser(env, a.userId))?.username, code: a.codes[0] })).status).toBe(400);
    expect(await remainingRecoveryCodes(env, a.userId)).toBe(10);
    const account = await (await app.request("/app/settings/account", { headers: { cookie: a.cookie } }, env)).text();
    expect(account).toContain("<strong>10</strong> unused code(s)");
    expect(account).toContain('<a href="/recover">/recover</a>');
  });

  it("nags on /app with one passkey or no recovery codes", async () => {
    const a = await signup(name("nag"));
    expect(await (await app.request("/app", { headers: { cookie: a.cookie } }, env)).text()).toContain("You have only one passkey.");
    await freshReauth(a.userId);
    const o = (await (await json("/auth/passkey/options", {}, a.cookie)).json()) as { challengeId: string };
    await json("/auth/passkey/verify", { challengeId: o.challengeId, response: { id: `${a.credId}-2`, ok: true } }, a.cookie);
    expect(await (await app.request("/app", { headers: { cookie: a.cookie } }, env)).text()).not.toContain("If you lose that device");
  });
});

describe("download everything", () => {
  it("includes account.json without secrets", async () => {
    const a = await signup(name("dl"));
    await freshReauth(a.userId);
    const zip = unzipSync(new Uint8Array(await (await app.request("/export", { headers: { cookie: a.cookie } }, env)).arrayBuffer()));
    const acct = JSON.parse(strFromU8(zip["account.json"]));
    expect(acct.passkeys).toEqual([expect.objectContaining({ name: "first passkey", device_type: "multiDevice" })]);
    expect(JSON.stringify(acct)).not.toMatch(/public_key|hash|token|code/);
  });
});

describe("delete account", () => {
  it("removes everything of the user (D1, DOs, vectors, grants), resumes after a failure, and leaves others alone", async () => {
    const a = await makeUser("del");
    const b = await makeUser("keep");
    const va = await defaultVault(a.user.id);
    const vb = await defaultVault(b.user.id);
    for (const [v, u] of [
      [va, a.user],
      [vb, b.user],
    ] as const) {
      await v.stub.writeNote(v.ref, caller(u), { title: "Shared title", content: "same words in both vaults" });
      await v.stub.embedPending();
    }
    const pat = await createPat(env, a.user.id, "t", ["memory:read"], null);
    const { accessToken } = await getAccessToken(a.cookie);
    await createInvite(env, a.user);
    await freshReauth(a.user.id);

    // wrong confirmation: nothing happens
    expect((await fetchWorker("/app/settings/delete", form(a.cookie, { confirm: "nope" }))).status).toBe(400);
    // a failure part-way leaves a locked, resumable account
    await va.stub.setFaults(["purge-fail"]);
    expect((await fetchWorker("/app/settings/delete", form(a.cookie, { confirm: a.user.username }))).status).toBe(500);
    expect((await getUser(env, a.user.id))?.deleting_at).toBeTruthy();
    expect((await fetchWorker("/app", { headers: { cookie: a.cookie } })).headers.get("location")).toBe("/app/settings/delete");
    expect(await (await fetchWorker("/app/settings/delete", { headers: { cookie: a.cookie } })).text()).toContain("didn't finish last time");
    await va.stub.setFaults([]);
    const done = await fetchWorker("/app/settings/delete", form(a.cookie, { confirm: a.user.username }));
    expect(done.status).toBe(200);
    expect(done.headers.get("set-cookie")).toContain("Max-Age=0");

    // nothing of A remains in D1
    for (const [table, col] of [
      ["users", "id"],
      ["credentials", "user_id"],
      ["sessions", "user_id"],
      ["challenges", "user_id"],
      ["recovery_codes", "user_id"],
      ["vaults", "owner_id"],
      ["invites", "created_by"],
      ["pats", "user_id"],
      ["stats_daily", "user_id"],
      ["ai_daily", "user_id"],
      ["ai_budget", "user_id"],
      ["usage_ledger", "user_id"],
      ["audit_log", "user_id"],
    ]) {
      const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(a.user.id).first<{ n: number }>())?.n;
      expect(n, table).toBe(0);
    }
    // nor in its Durable Object or the vector index
    expect(await runInDurableObject(va.stub, (_i, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM notes").one().n)).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM fake_vectors WHERE ns = ?").bind(va.vault.id).first<{ n: number }>())?.n).toBe(0);
    // credentials are dead
    expect(await resolvePat(env, pat)).toBeNull();
    const mcp = await fetchWorker("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, host: "localhost:8787", "content-type": "application/json" },
      body: "{}",
    });
    expect(mcp.status).toBe(401);
    // B is untouched
    expect((await vb.stub.readNote(vb.ref, { identifier: "shared-title" })).ok).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM fake_vectors WHERE ns = ?").bind(vb.vault.id).first<{ n: number }>())?.n).toBeGreaterThan(0);
    expect(await getUser(env, b.user.id)).not.toBeNull();
  });
});
