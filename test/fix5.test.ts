// Fix round 5: enrollment can't bootstrap reauth; purge fencing; atomic passkey removal; viewer deletes.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WebAuthnVerifier } from "../src/auth/webauthn";
import { getUser } from "../src/directory";
import { createApp } from "../src/web/app";
import { caller, defaultVault, freshReauth, makeUser, ORIGIN } from "./helpers";
import { fetchWorker } from "./oauth";

// MOCKED: only the WebAuthn verify step (ok:true verifies).
const fake: WebAuthnVerifier = {
  async verifyRegistration({ response }) {
    const r = response as unknown as { id: string; ok?: boolean };
    return r.ok ? { id: r.id, publicKey: new Uint8Array([1]), counter: 0, transports: [], deviceType: "singleDevice", backedUp: false } : null;
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
const uname = (p: string) => `${p}${Date.now() % 1e7}${Math.floor(Math.random() * 1000)}`;
async function signup(username: string) {
  const o = (await (await json("/auth/signup/options", { username })).json()) as { challengeId: string };
  const v = await json("/auth/signup/verify", { challengeId: o.challengeId, response: { id: `cred-${username}`, ok: true } });
  const body = (await v.json()) as { recoveryCodes: string[] };
  const u = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first<{ id: string }>();
  return { cookie: sessionFrom(v), userId: u?.id as string, credId: `cred-${username}`, codes: body.recoveryCodes, username };
}
const credCount = async (userId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?").bind(userId).first<{ n: number }>())?.n ?? -1;

describe("1 (BLOCKER): a session alone can't enrol a passkey and bootstrap reauth", () => {
  it("an unrestricted, non-fresh session can't start or finish enrollment, so it can't reauth with an attacker key", async () => {
    const victim = await signup(uname("vic"));
    const opt = await json("/auth/passkey/options", {}, victim.cookie);
    expect(opt.status).toBe(403);
    expect(((await opt.json()) as { reauth?: string }).reauth).toBe("/app/reauth?next=%2Fapp%2Fsettings%2Faccount");
    expect(await credCount(victim.userId)).toBe(1);
    // the attacker's key isn't on the account, so reauth with it fails
    const ro = (await (await json("/auth/reauth/options", {}, victim.cookie)).json()) as { challengeId: string };
    expect((await json("/auth/reauth/verify", { challengeId: ro.challengeId, response: { id: "attacker-key", ok: true } }, victim.cookie)).status).toBe(400);
    expect((await app.request("/export", { headers: { cookie: victim.cookie } }, env)).status).toBe(303);
  });

  it("enrollment begun while fresh can't finish after the gate expires", async () => {
    const a = await signup(uname("exp"));
    await freshReauth(a.userId);
    const o = (await (await json("/auth/passkey/options", {}, a.cookie)).json()) as { challengeId: string };
    await env.DB.prepare("UPDATE sessions SET reauth_at = ? WHERE user_id = ?")
      .bind(new Date(Date.now() - 6 * 60e3).toISOString(), a.userId)
      .run();
    expect((await json("/auth/passkey/verify", { challengeId: o.challengeId, response: { id: "late-key", ok: true } }, a.cookie)).status).toBe(403);
    expect(await credCount(a.userId)).toBe(1);
  });

  it("an enrollment challenge is bound to the session that asked for it", async () => {
    const a = await signup(uname("bind"));
    await freshReauth(a.userId);
    const o = (await (await json("/auth/passkey/options", {}, a.cookie)).json()) as { challengeId: string };
    // a second session of the same user (also fresh) can't use it
    const l = (await (await json("/auth/login/options", {})).json()) as { challengeId: string };
    const other = sessionFrom(await json("/auth/login/verify", { challengeId: l.challengeId, response: { id: a.credId, ok: true } }));
    await freshReauth(a.userId);
    expect((await json("/auth/passkey/verify", { challengeId: o.challengeId, response: { id: "k2", ok: true } }, other)).status).toBe(400);
  });

  it("reauth only accepts a passkey that existed when the check began", async () => {
    const a = await signup(uname("age"));
    const ro = (await (await json("/auth/reauth/options", {}, a.cookie)).json()) as { challengeId: string };
    // a credential appearing after the challenge was issued (e.g. enrolled meanwhile) is refused
    await env.DB.prepare("INSERT INTO credentials (id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, 0, ?)")
      .bind("new-key", a.userId, new Uint8Array([1]), new Date(Date.now() + 1000).toISOString())
      .run();
    expect((await json("/auth/reauth/verify", { challengeId: ro.challengeId, response: { id: "new-key", ok: true } }, a.cookie)).status).toBe(400);
    const ro2 = (await (await json("/auth/reauth/options", {}, a.cookie)).json()) as { challengeId: string };
    expect((await json("/auth/reauth/verify", { challengeId: ro2.challengeId, response: { id: a.credId, ok: true } }, a.cookie)).status).toBe(200);
  });

  it("legitimate enrollment (fresh) and recovery enrollment still work", async () => {
    const a = await signup(uname("ok"));
    const ro = (await (await json("/auth/reauth/options", {}, a.cookie)).json()) as { challengeId: string };
    expect((await json("/auth/reauth/verify", { challengeId: ro.challengeId, response: { id: a.credId, ok: true } }, a.cookie)).status).toBe(200);
    const o = (await (await json("/auth/passkey/options", {}, a.cookie)).json()) as { challengeId: string };
    expect((await json("/auth/passkey/verify", { challengeId: o.challengeId, response: { id: "second", ok: true } }, a.cookie)).status).toBe(200);
    expect(await credCount(a.userId)).toBe(2);
    const rec = sessionFrom(await json("/auth/recover", { username: a.username, code: a.codes[0] }));
    const ro3 = (await (await json("/auth/passkey/options", {}, rec)).json()) as { challengeId: string };
    expect((await json("/auth/passkey/verify", { challengeId: ro3.challengeId, response: { id: "recovered", ok: true } }, rec)).status).toBe(200);
    expect(await credCount(a.userId)).toBe(3);
  });
});

describe("2: deleting a vault fences in-flight embedding", () => {
  it("an upsert paused across the purge never leaves vectors behind; new work is refused", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Doomed", content: "words that get embedded" });
    await v.stub.pauseAt("before-upsert");
    const embedding = v.stub.embedPending();
    await v.stub.untilPaused("before-upsert");
    const purge = v.stub.purge(v.ref);
    await new Promise((r) => setTimeout(r, 50));
    const refused = await v.stub.writeNote(v.ref, caller(user), { title: "Late", content: "x" }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(refused).toMatch(/being deleted/);
    await v.stub.resumeAt("before-upsert");
    await embedding;
    expect((await purge).vectors).toBeGreaterThan(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM fake_vectors WHERE ns = ?").bind(v.vault.id).first<{ n: number }>())?.n).toBe(0);
    // stays dead after the purge (tombstone), and a repeat is a no-op
    const gone = await v.stub.readNote(v.ref, { identifier: "doomed" }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(gone).toMatch(/being deleted/);
    expect(await v.stub.purge(v.ref)).toEqual({ vectors: 0 });
  });
});

describe("3: passkey removal is atomic with the last-key checks", () => {
  it("two concurrent removals with no recovery codes leave one passkey", async () => {
    const a = await signup(uname("race"));
    await freshReauth(a.userId);
    const o = (await (await json("/auth/passkey/options", {}, a.cookie)).json()) as { challengeId: string };
    await json("/auth/passkey/verify", { challengeId: o.challengeId, response: { id: `${a.credId}-2`, ok: true } }, a.cookie);
    await env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ?").bind(new Date().toISOString(), a.userId).run();
    await freshReauth(a.userId);
    const [r1, r2] = await Promise.all([
      app.request("/app/settings/passkeys/delete", form(a.cookie, { id: a.credId }), env),
      app.request("/app/settings/passkeys/delete", form(a.cookie, { id: `${a.credId}-2` }), env),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([303, 400]);
    expect(await credCount(a.userId)).toBe(1);
  });

  it("with codes, a concurrent second removal still needs explicit confirmation", async () => {
    const a = await signup(uname("race2"));
    await freshReauth(a.userId);
    const o = (await (await json("/auth/passkey/options", {}, a.cookie)).json()) as { challengeId: string };
    await json("/auth/passkey/verify", { challengeId: o.challengeId, response: { id: `${a.credId}-2`, ok: true } }, a.cookie);
    await freshReauth(a.userId);
    const res = await Promise.all([
      app.request("/app/settings/passkeys/delete", form(a.cookie, { id: a.credId }), env),
      app.request("/app/settings/passkeys/delete", form(a.cookie, { id: `${a.credId}-2` }), env),
    ]);
    const bodies = await Promise.all(res.map((r) => r.text()));
    expect(bodies.filter((b) => b.includes("Remove your last passkey?")).length).toBe(1);
    expect(await credCount(a.userId)).toBe(1);
    expect(await getUser(env, a.userId)).not.toBeNull();
  });
});

describe("4: viewer deletes need a checksum and are write-limited", () => {
  it("both delete routes refuse a missing checksum and honour the write limiter", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    const w = await v.stub.writeNote(v.ref, caller(user), { title: "Keep me", content: "x" });
    if (!w.ok) throw new Error();
    const jsonDel = (body: unknown, e = env) =>
      app.request(
        "/app/api/notes/delete",
        { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) },
        e,
      );
    expect((await jsonDel({ permalink: "keep-me" })).status).toBe(409);
    expect((await fetchWorker("/app/editor/delete", form(cookie, { permalink: "keep-me" }))).status).toBe(409);
    expect((await v.stub.readNote(v.ref, { identifier: "keep-me" })).ok).toBe(true);
    const deny = { ...env, RL_WRITE: { limit: async () => ({ success: false }) } } as typeof env;
    expect((await jsonDel({ permalink: "keep-me", expected_checksum: w.value.note.checksum }, deny)).status).toBe(429);
    expect((await app.request("/app/editor/delete", form(cookie, { permalink: "keep-me", expected_checksum: w.value.note.checksum }), deny)).status).toBe(429);
    expect((await v.stub.readNote(v.ref, { identifier: "keep-me" })).ok).toBe(true);
    expect((await fetchWorker("/app/editor/delete", form(cookie, { permalink: "keep-me", expected_checksum: w.value.note.checksum }))).status).toBe(303);
  });
});
