// Launch-review fix round 1: one block per finding.
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WebAuthnVerifier } from "../src/auth/webauthn";
import { createInvite, createPat, createVault, getUserByName, userBytes, vaultRef } from "../src/directory";
import { LIMITS } from "../src/env";
import worker, { rateLimit } from "../src/index";
import { createApp } from "../src/web/app";
import { BASE, caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { fetchWorker } from "./oauth";

const KB = 1024;
const text = (n: number, ch = "x") => ch.repeat(n);
const setUsed = (userId: string, bytes: number) => env.DB.prepare("UPDATE users SET bytes_used = ? WHERE id = ?").bind(bytes, userId).run();

async function vaultTotals(userId: string) {
  return (await env.DB.prepare("SELECT COALESCE(SUM(bytes_used),0) AS b FROM vaults WHERE owner_id = ?").bind(userId).first<{ b: number }>())?.b ?? 0;
}

describe("finding 1: storage quota covers history and real sizes", () => {
  it("bounds retained revisions per note and charges them", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    for (let i = 0; i < 25; i++) {
      const r = await stub.writeNote(ref, caller(user), { title: "Big", content: `${i}\n${text(50 * KB)}`, overwrite: true });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    const stats = await stub.stats(ref);
    const revs = await stub.revisions(ref, "big");
    expect(revs.length).toBe(25);
    // 1 live copy + at most 20 retained copies, all charged to the user
    expect(stats.totalBytes).toBeLessThan(22 * 51 * KB);
    expect(stats.totalBytes).toBeGreaterThan(20 * 50 * KB);
    expect(await userBytes(env, user.id)).toBe(stats.totalBytes);
    // delete: the live copy moves to the trash, older copies are dropped
    await stub.deleteNote(ref, caller(user), { identifier: "big" });
    const after = await stub.stats(ref);
    expect(after.totalBytes).toBeLessThan(51 * KB);
    expect(await userBytes(env, user.id)).toBe(after.totalBytes);
  });

  it("charges the final serialized markdown: metadata, tags, set_metadata, multi find_replace", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    const big = await stub.writeNote(ref, caller(user), { title: "Meta", content: "small", metadata: { blob: text(LIMITS.noteBytes) } });
    expect(big).toMatchObject({ ok: false, code: "TOO_LARGE" });
    const w = await stub.writeNote(ref, caller(user), { title: "Meta", content: "a b a b a b", tags: [text(5 * KB, "t")], metadata: { blob: text(20 * KB) } });
    if (!w.ok) throw new Error(w.message);
    expect(w.value.note.bytes).toBeGreaterThan(25 * KB);
    const sm = await stub.editNote(ref, caller(user), { identifier: "meta", command: "set_metadata", metadata: { more: text(30 * KB) } });
    expect(sm.ok).toBe(true);
    const fr = await stub.editNote(ref, caller(user), {
      identifier: "meta",
      command: "find_replace",
      find_text: "a",
      content: text(10 * KB, "z"),
      expected_replacements: 3,
    });
    if (!fr.ok) throw new Error(fr.message);
    expect(fr.value.note.bytes).toBeGreaterThan(85 * KB);
    const stats = await stub.stats(ref);
    expect(await userBytes(env, user.id)).toBe(stats.totalBytes);
    expect(await vaultTotals(user.id)).toBe(stats.totalBytes);
  });

  it("evicts old history to make room, then refuses when live notes alone hit the limit", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    await setUsed(user.id, LIMITS.userBytes - 250 * KB); // pretend other notes use the rest
    const put = (title: string) => stub.writeNote(ref, caller(user), { title, content: text(100 * KB), overwrite: true });
    expect((await put("A")).ok).toBe(true); // L-150K
    expect((await put("A")).ok).toBe(true); // L-50K (old A retained)
    expect((await put("A")).ok).toBe(true); // evicts one revision copy to fit
    expect((await put("B")).ok).toBe(true); // evicts the remaining copy
    const c = await put("C");
    expect(c).toMatchObject({ ok: false, code: "QUOTA" });
    expect(await userBytes(env, user.id)).toBeLessThanOrEqual(LIMITS.userBytes);
  });

  it("reserves atomically: concurrent writes across vaults cannot overshoot", async () => {
    const { user } = await makeUser();
    const vaults = [await defaultVault(user.id)];
    for (const name of ["p1", "p2", "p3", "p4"]) {
      const r = await createVault(env, user.id, name);
      if (!r.ok) throw new Error(r.message);
      vaults.push({ vault: r.vault, stub: env.VAULT.getByName(r.vault.id), ref: vaultRef(r.vault) });
    }
    await setUsed(user.id, LIMITS.userBytes - 250 * KB);
    const results = await Promise.all(vaults.map((v, i) => v.stub.writeNote(v.ref, caller(user), { title: `N${i}`, content: text(100 * KB) })));
    expect(results.filter((r) => r.ok).length).toBe(2);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "QUOTA")).toBe(true);
    expect(await userBytes(env, user.id)).toBeLessThanOrEqual(LIMITS.userBytes);
  });

  it("rate-limits MCP writes per user", async () => {
    const { user } = await makeUser();
    const pat = await createPat(env, user.id, "rl", ["memory:read", "memory:write"], null);
    const limited = { ...env, RL_WRITE: { limit: async () => ({ success: false }) } };
    const call = (name: string, args: unknown) =>
      worker.fetch(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${pat}`,
            host: "localhost:8787",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
        limited as typeof env,
        createExecutionContext(),
      );
    const body = await (await call("write_note", { title: "x", content: "y" })).text();
    expect(body).toContain("RATE_LIMITED");
    expect(await (await call("search_notes", { query: "x" })).text()).not.toContain("RATE_LIMITED");
  });
});

describe("finding 2: vector ids are unique per vault + note", () => {
  const semanticHits = async (v: Awaited<ReturnType<typeof defaultVault>>, q: string) => {
    const r = await v.stub.search(v.ref, { query: q, mode: "semantic" });
    return r.ok ? r.value.hits.map((h) => h.permalink) : [];
  };

  it("identical notes in two users' vaults don't share or delete each other's vectors", async () => {
    const a = await makeUser("va");
    const b = await makeUser("vb");
    const va = await defaultVault(a.user.id);
    const vb = await defaultVault(b.user.id);
    const note = { title: "Template", content: "Standard onboarding checklist for new hires.\n- [step] collect laptop" };
    await va.stub.writeNote(va.ref, caller(a.user), note);
    await vb.stub.writeNote(vb.ref, caller(b.user), note);
    await va.stub.embedPending();
    await vb.stub.embedPending();
    const ids = (await env.DB.prepare("SELECT id, ns FROM fake_vectors WHERE ns IN (?, ?)").bind(va.vault.id, vb.vault.id).all<{ id: string; ns: string }>())
      .results;
    expect(new Set(ids.filter((r) => r.ns === va.vault.id).map((r) => r.id)).size).toBeGreaterThan(0);
    expect(ids.filter((r) => r.ns === va.vault.id).length).toBe(ids.filter((r) => r.ns === vb.vault.id).length);
    expect(ids.every((r) => r.id.length === 64)).toBe(true);
    // B deletes theirs; A's vectors survive
    await vb.stub.deleteNote(vb.ref, caller(b.user), { identifier: "template" });
    await vb.stub.embedPending();
    expect(await semanticHits(va, "onboarding checklist new hires")).toEqual(["template"]);
    expect(await semanticHits(vb, "onboarding checklist new hires")).toEqual([]);
  });

  it("identical content in two notes of one vault keeps both covered", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Readme", directory: "one", content: "Quarterly budget forecast spreadsheet." });
    await v.stub.writeNote(v.ref, caller(user), { title: "Readme", directory: "two", content: "Quarterly budget forecast spreadsheet." });
    await v.stub.embedPending();
    expect((await semanticHits(v, "quarterly budget forecast")).sort()).toEqual(["one/readme", "two/readme"]);
    await v.stub.deleteNote(v.ref, caller(user), { identifier: "one/readme" });
    await v.stub.embedPending();
    expect(await semanticHits(v, "quarterly budget forecast")).toEqual(["two/readme"]);
  });
});

describe("finding 3: checksum guard holds under concurrency", () => {
  it("two edits from the same checksum: exactly one wins", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    const w = await stub.writeNote(ref, caller(user), { title: "Race", content: "base" });
    if (!w.ok) throw new Error(w.message);
    const [r1, r2] = await Promise.all(
      ["first", "second"].map((t) =>
        stub.editNote(ref, caller(user), { identifier: "race", command: "append", content: t, expected_checksum: w.value.note.checksum }),
      ),
    );
    expect([r1.ok, r2.ok].filter(Boolean).length).toBe(1);
    expect([r1, r2].find((r) => !r.ok)).toMatchObject({ code: "REVISION_CONFLICT" });
    const read = await stub.readNote(ref, { identifier: "race" });
    const content = read.ok ? (read.value.content ?? "") : "";
    expect(content.includes("first") !== content.includes("second")).toBe(true);
    expect(await userBytes(env, user.id)).toBe((await stub.stats(ref)).totalBytes);
  });
});

describe("finding 4: an invite admits exactly one account", () => {
  const fake: WebAuthnVerifier = {
    async verifyRegistration({ response }) {
      return {
        id: (response as unknown as { id: string }).id,
        publicKey: new Uint8Array([1]),
        counter: 0,
        transports: [],
        deviceType: "singleDevice",
        backedUp: false,
      };
    },
    async verifyAuthentication() {
      return null;
    },
  };
  const app = createApp({ verifier: fake });
  const closed = { ...env, OPEN_SIGNUP: "false" };
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) }, closed);

  it("concurrent sign-ups with one invite: one account, one session", async () => {
    const { user } = await makeUser("inviter");
    const inv = await createInvite(env, user);
    if (!inv.ok) throw new Error(inv.message);
    const code = inv.code;
    const names = [`racer-a-${Date.now()}`, `racer-b-${Date.now()}`];
    const opts = await Promise.all(
      names.map(async (u) => (await post("/auth/signup/options", { username: u, invite: code })).json() as Promise<{ challengeId: string }>),
    );
    const results = await Promise.all(opts.map((o, i) => post("/auth/signup/verify", { challengeId: o.challengeId, response: { id: `cred-${names[i]}` } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    const loser = results.find((r) => r.status === 403);
    expect(loser?.headers.get("set-cookie")).toBeNull();
    const users = await Promise.all(names.map((n) => getUserByName(env, n)));
    expect(users.filter(Boolean).length).toBe(1);
  });
});

describe("finding 5: /authorize does no client work for anonymous callers; endpoints are limited", () => {
  it("redirects to sign-in without resolving a CIMD client", async () => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "https://cimd.invalid/client.json",
      redirect_uri: "https://cimd.invalid/cb",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const res = await fetchWorker(`/authorize?${q}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/login\?next=%2Fauthorize/);
  });

  it("rate-limits /authorize, /oauth/token and /oauth/register per IP before the provider", async () => {
    const deny = { limit: async () => ({ success: false }) };
    const e = { ...env, RL_AUTHORIZE: deny, RL_TOKEN: deny, RL_OAUTH: deny } as typeof env;
    for (const [method, path] of [
      ["GET", "/authorize?client_id=x"],
      ["POST", "/oauth/token"],
      ["POST", "/oauth/register"],
    ]) {
      const r = await rateLimit(new Request(`${BASE}${path}`, { method, headers: { "cf-connecting-ip": "203.0.113.9" } }), e);
      expect(r?.status, path).toBe(429);
    }
    expect(await rateLimit(new Request(`${BASE}/health`), e)).toBeNull();
    const viaWorker = await worker.fetch(new Request(`${BASE}/oauth/token`, { method: "POST" }), e, createExecutionContext());
    expect(viaWorker.status).toBe(429);
  });
});
