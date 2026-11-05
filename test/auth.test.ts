import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WebAuthnVerifier } from "../src/auth/webauthn";
import { createInvite, getUserByName } from "../src/directory";
import { createApp } from "../src/web/app";
import { makeUser, ORIGIN } from "./helpers";

type Opts = { rp: unknown; authenticatorSelection: unknown; attestation: string; pubKeyCredParams: { alg: number }[]; userVerification: string; rpId: string };

// MOCKED: the WebAuthn verify step. Option generation, challenge storage, credential storage,
// sessions and recovery are real. A response with ok:true "verifies".
const fakeVerifier: WebAuthnVerifier = {
  async verifyRegistration({ response }) {
    const r = response as unknown as { id: string; ok?: boolean };
    return r.ok ? { id: r.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"], deviceType: "multiDevice", backedUp: true } : null;
  },
  async verifyAuthentication({ response, credential }) {
    const r = response as unknown as { ok?: boolean };
    return r.ok ? { newCounter: credential.counter + 1 } : null;
  },
};

const app = createApp({ verifier: fakeVerifier });
const post = (path: string, body: unknown, extra: Record<string, string> = {}, e = env) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...extra }, body: JSON.stringify(body) }, e);
const sessionFrom = (res: Response) => /(__Host-cairn_session=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";

async function signup(username: string, extra: Record<string, unknown> = {}, e = env) {
  const o = await post("/auth/signup/options", { username, ...extra }, {}, e);
  if (o.status !== 200) return { status: o.status, body: (await o.json()) as Record<string, unknown>, cookie: "" };
  const { challengeId } = (await o.json()) as { challengeId: string };
  const v = await post("/auth/signup/verify", { challengeId, response: { id: `cred-${username}`, ok: true } }, {}, e);
  return { status: v.status, body: (await v.json()) as Record<string, unknown>, cookie: sessionFrom(v), challengeId };
}

describe("passkey sign-up and sign-in", () => {
  it("returns registration options with the required settings", async () => {
    const res = await post("/auth/signup/options", { username: "opts-user" });
    expect(res.status).toBe(200);
    const { options, challengeId } = (await res.json()) as { options: Opts; challengeId: string };
    expect(challengeId).toBeTruthy();
    expect(options.rp).toEqual({ name: "Cairn", id: "localhost" });
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(options.attestation).toBe("none");
    expect(options.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual([-8, -7, -257]);
  });

  it("signs up, issues 10 recovery codes and a secure session cookie", async () => {
    const r = await signup("newbie");
    expect(r.status).toBe(200);
    expect((r.body.recoveryCodes as string[]).length).toBe(10);
    expect(r.cookie).toMatch(/^__Host-cairn_session=/);
    const home = await app.request("/app", { headers: { cookie: r.cookie } }, env);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Your memory");
    const user = await getUserByName(env, "newbie");
    expect(user?.is_admin).toBe(0);
    // username taken; challenge single-use
    expect((await signup("newbie")).status).toBe(409);
    const replay = await post("/auth/signup/verify", { challengeId: r.challengeId, response: { id: "x", ok: true } });
    expect(replay.status).toBe(400);
  });

  it("sets session cookie attributes", async () => {
    const o = await post("/auth/signup/options", { username: "cookie-user" });
    const { challengeId } = (await o.json()) as { challengeId: string };
    const v = await post("/auth/signup/verify", { challengeId, response: { id: "c-cookie", ok: true } });
    const sc = v.headers.get("set-cookie") ?? "";
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(sc).toContain(attr);
  });

  it("rejects bad usernames and failed verification", async () => {
    expect((await post("/auth/signup/options", { username: "../x" })).status).toBe(400);
    const o = await post("/auth/signup/options", { username: "failer" });
    const { challengeId } = (await o.json()) as { challengeId: string };
    expect((await post("/auth/signup/verify", { challengeId, response: { id: "c", ok: false } })).status).toBe(400);
    expect(await getUserByName(env, "failer")).toBeNull();
  });

  it("signs in with a discoverable passkey", async () => {
    await signup("returning");
    const o = await post("/auth/login/options", {});
    const { challengeId, options } = (await o.json()) as { challengeId: string; options: Opts };
    expect(options.userVerification).toBe("required");
    expect(options.rpId).toBe("localhost");
    const v = await post("/auth/login/verify", { challengeId, response: { id: "cred-returning", ok: true } });
    expect(v.status).toBe(200);
    expect(sessionFrom(v)).toMatch(/^__Host-cairn_session=/);
    const o2 = await post("/auth/login/options", {});
    const c2 = ((await o2.json()) as { challengeId: string }).challengeId;
    expect((await post("/auth/login/verify", { challengeId: c2, response: { id: "unknown-cred", ok: true } })).status).toBe(400);
  });

  it("refuses cross-origin POSTs", async () => {
    const res = await app.request("/auth/login/options", { method: "POST", headers: { origin: "https://evil.example" } }, env);
    expect(res.status).toBe(403);
  });

  it("enforces invite-only sign-up when OPEN_SIGNUP is off, and the setup token makes an admin", async () => {
    const closed = { ...env, OPEN_SIGNUP: "false" };
    expect((await signup("nope", {}, closed)).status).toBe(403);
    const { user } = await makeUser("admin");
    const inv = await createInvite(env, user);
    if (!inv.ok) throw new Error(inv.message);
    const code = inv.code;
    expect((await signup("invited", { invite: code }, closed)).status).toBe(200);
    expect((await signup("invited2", { invite: code }, closed)).status).toBe(403); // single use
    const admin = await signup("boss", { setupToken: "test-setup-token-0123456789" }, closed);
    expect(admin.status).toBe(200);
    expect((await getUserByName(env, "boss"))?.is_admin).toBe(1);
  });

  it("recovers with a code into a restricted session that can only add a passkey", async () => {
    const r = await signup("forgetful");
    const code = (r.body.recoveryCodes as string[])[0];
    const rec = await post("/auth/recover", { username: "forgetful", code });
    expect(rec.status).toBe(200);
    const cookie = sessionFrom(rec);
    const blocked = await app.request("/app", { headers: { cookie } }, env);
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get("location")).toBe("/app/settings?recovered=1");
    expect((await post("/auth/recover", { username: "forgetful", code })).status).toBe(400); // used
    const o = await post("/auth/passkey/options", {}, { cookie });
    const { challengeId } = (await o.json()) as { challengeId: string };
    expect((await post("/auth/passkey/verify", { challengeId, response: { id: "cred-new", ok: true }, name: "new phone" }, { cookie })).status).toBe(200);
    expect((await app.request("/app", { headers: { cookie } }, env)).status).toBe(200);
    // the original signup session was signed out
    expect((await app.request("/app", { headers: { cookie: r.cookie } }, env)).status).toBe(302);
  });

  it("logs out", async () => {
    const r = await signup("leaver");
    const out = await app.request("/auth/logout", { method: "POST", headers: { origin: ORIGIN, cookie: r.cookie } }, env);
    expect(out.status).toBe(303);
    expect((await app.request("/app", { headers: { cookie: r.cookie } }, env)).status).toBe(302);
  });
});
