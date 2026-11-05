// First-run claim and the canonical URL without PUBLIC_URL (the Deploy to Cloudflare template):
// through the real Worker entry, with a software passkey.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { CLAIM_LIVE_MAX, issueClaimCode, normaliseClaimCode, parseSiteUrl, resetSiteCache } from "../src/site";
import { compareBuild } from "../src/update";
import { BASE, freshReauth } from "./helpers";
import { SoftAuthenticator } from "./softauthn";

/** The template's config: no PUBLIC_URL, no setup token. */
let over: Record<string, string> = {};
const tmplEnv = () => ({ ...env, PUBLIC_URL: "", CAIRN_SETUP_TOKEN: "", RL_AUTH: undefined, ...over }) as unknown as typeof env;

async function send(url: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url.startsWith("http") ? url : `${BASE}${url}`, { redirect: "manual", ...init }), tmplEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const post = (path: string, body: unknown, origin = BASE, cookie = "") =>
  send(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

/** GET /claim and read the code the Worker wrote to its log. */
async function codeFromLog(): Promise<string> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const res = await send("/claim");
    expect(res.status).toBe(200);
    const line = spy.mock.calls.map((a) => String(a[0])).find((l) => l.startsWith("Cairn claim code:"));
    expect(line, "claim code logged").toBeTruthy();
    return /([0-9A-Z]{5}-[0-9A-Z]{5})/.exec(line ?? "")?.[1] ?? "";
  } finally {
    spy.mockRestore();
  }
}

async function claim(code: string, username = "owner", auth = new SoftAuthenticator("localhost", BASE)) {
  const o = await post("/auth/signup/options", { username, claimCode: code });
  if (o.status !== 200) return { status: o.status, cookie: "" };
  const { challengeId, options } = (await o.json()) as { challengeId: string; options: { challenge: string; user: { id: string } } };
  const v = await post("/auth/signup/verify", { challengeId, response: await auth.create(options) });
  return { status: v.status, cookie: /(__Host-cairn_session=[^;]+)/.exec(v.headers.get("set-cookie") ?? "")?.[1] ?? "" };
}

const setting = async (key: string) =>
  (await env.DB.prepare("SELECT value FROM site_settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;

// Storage is shared by this file's tests: start each one unclaimed (all references cascade).
beforeEach(async () => {
  over = {};
  await env.DB.batch([
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM claim_codes"),
    env.DB.prepare("DELETE FROM site_settings"),
    env.DB.prepare("DELETE FROM challenges"),
  ]);
  resetSiteCache();
});
afterEach(() => resetSiteCache());

describe("before the claim", () => {
  it("starts with no users (this file's storage)", async () => {
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("reaches no data: pages redirect to /claim, APIs and OAuth refuse", async () => {
    for (const p of ["/", "/app", "/login", "/signup", "/app/settings", "/export", "/.well-known/oauth-authorization-server", "/authorize?client_id=x"]) {
      const r = await send(p);
      expect(r.status, p).toBe(303);
      expect(r.headers.get("location"), p).toBe("/claim");
    }
    for (const p of ["/mcp", "/oauth/register", "/oauth/token", "/auth/login/options", "/auth/recover"]) {
      const r = await post(p, {});
      expect(r.status, p).toBe(503);
    }
    expect((await send("/health")).status).toBe(200);
  });

  it("only the claim signs up: no code, a wrong code, or an invite path all fail", async () => {
    over = { OPEN_SIGNUP: "true" };
    await codeFromLog();
    expect((await post("/auth/signup/options", { username: "early" })).status).toBe(403);
    expect((await post("/auth/signup/options", { username: "early", claimCode: "ABCDE-FGHJK" })).status).toBe(403);
    expect((await post("/auth/signup/options", { username: "early", invite: "nope", claimCode: "" })).status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("logs a code only when none is live; new codes are rate-limited, and only hashes are stored", async () => {
    const code = await codeFromLog();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await send("/claim")).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect((await post("/claim/new", {})).status).toBe(429);
    spy.mockRestore();
    const rows = await env.DB.prepare("SELECT code_hash FROM claim_codes").all<{ code_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.code_hash).not.toContain(normaliseClaimCode(code));
  });

  it("keeps at most a handful of live codes, so requests can't flush the owner's at once", async () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await issueClaimCode(tmplEnv(), BASE);
    for (let i = 0; i < CLAIM_LIVE_MAX + 2; i++) {
      await env.DB.prepare("UPDATE claim_codes SET created_at = ?")
        .bind(new Date(Date.now() - 120e3).toISOString())
        .run();
      await issueClaimCode(tmplEnv(), BASE);
    }
    quiet.mockRestore();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM claim_codes").first<{ n: number }>())?.n).toBe(CLAIM_LIVE_MAX);
    expect(first.ok).toBe(true);
  });

  it("an expired code fails", async () => {
    const code = await codeFromLog();
    await env.DB.prepare("UPDATE claim_codes SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await claim(code)).status).toBe(403);
  });

  it("setting CAIRN_SETUP_TOKEN turns the claim page off (the token path, as before)", async () => {
    over = { CAIRN_SETUP_TOKEN: "test-setup-token-0123456789" };
    expect((await send("/claim")).status).toBe(303);
    expect((await send("/app")).status).not.toBe(303);
  });
});

describe("the claim", () => {
  it("works once: the claimer is admin, the URL is recorded, the page is gone, codes are spent", async () => {
    const code = await codeFromLog();
    const r = await claim(` ${code.toLowerCase()} `);
    expect(r.status).toBe(200);
    const u = await env.DB.prepare("SELECT username, is_admin FROM users").all<{ username: string; is_admin: number }>();
    expect(u.results).toEqual([{ username: "owner", is_admin: 1 }]);
    expect(await setting("canonical_url")).toBe(BASE);
    expect(await setting("claimed_at")).toBeTruthy();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM claim_codes").first<{ n: number }>())?.n).toBe(0);
    expect((await send("/app", { headers: { cookie: r.cookie } })).status).toBe(200);
    // gone for good
    const again = await send("/claim");
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/");
    expect((await post("/claim/new", {})).status).toBe(404);
    // even with the users deleted, the claim never reopens
    await env.DB.prepare("DELETE FROM users").run();
    resetSiteCache();
    expect((await send("/claim")).status).toBe(303);
  });

  it("a second claim is impossible, even with a challenge started before the first finished", async () => {
    const code = await codeFromLog();
    const a = new SoftAuthenticator("localhost", BASE);
    const b = new SoftAuthenticator("localhost", BASE);
    const oa = (await (await post("/auth/signup/options", { username: "alice", claimCode: code })).json()) as {
      challengeId: string;
      options: { challenge: string; user: { id: string } };
    };
    const ob = (await (await post("/auth/signup/options", { username: "bob", claimCode: code })).json()) as {
      challengeId: string;
      options: { challenge: string; user: { id: string } };
    };
    expect((await post("/auth/signup/verify", { challengeId: oa.challengeId, response: await a.create(oa.options) })).status).toBe(200);
    expect((await post("/auth/signup/verify", { challengeId: ob.challengeId, response: await b.create(ob.options) })).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n).toBe(1);
    // After the claim, a claim code is no route to admin: invite-only sign-up refuses it.
    over = { OPEN_SIGNUP: "false" };
    expect((await post("/auth/signup/options", { username: "carol", claimCode: code })).status).toBe(403);
  });
});

describe("canonical URL without PUBLIC_URL", () => {
  it("serves the recorded origin and redirects (GET) or refuses (POST) other hosts", async () => {
    const { cookie } = await claim(await codeFromLog());
    const other = "http://127.0.0.1:8787";
    const g = await send(`${other}/app?x=1`);
    expect(g.status).toBe(308);
    expect(g.headers.get("location")).toBe(`${BASE}/app?x=1`);
    expect((await post("/auth/login/options", {}, other)).status).toBe(421);
    expect((await send(`${other}/mcp`, { method: "POST" })).status).toBe(421);
    // OAuth metadata names the canonical origin, never the request's.
    const meta = (await (await send("/.well-known/oauth-authorization-server")).json()) as { issuer: string };
    expect(meta.issuer).toBe(BASE);
    // passkeys are bound to it
    const lo = (await (await post("/auth/login/options", {})).json()) as { options: { rpId: string } };
    expect(lo.options.rpId).toBe("localhost");
    expect((await send("/app/admin", { headers: { cookie } })).status).toBe(200);
  });

  it("PUBLIC_URL, when set, wins over the recorded origin", async () => {
    await claim(await codeFromLog());
    await env.DB.prepare("UPDATE site_settings SET value = 'https://elsewhere.example' WHERE key = 'canonical_url'").run();
    resetSiteCache();
    over = { PUBLIC_URL: BASE };
    expect((await send("/health")).status).toBe(200);
    expect((await send("/login")).status).toBe(200);
  });

  it("an admin can move it, with confirmation; afterwards the old host redirects to the new", async () => {
    const r = await claim(await codeFromLog());
    const me = await env.DB.prepare("SELECT id FROM users").first<{ id: string }>();
    await freshReauth(me?.id ?? "");
    const form = (fields: Record<string, string>) =>
      send("/app/admin/site", { method: "POST", headers: { origin: BASE, cookie: r.cookie }, body: new URLSearchParams(fields) });
    expect((await form({ url: "https://cairn.example.com" })).status).toBe(400); // no confirmation
    expect((await form({ url: "ftp://x", confirm: "1" })).status).toBe(400);
    expect((await form({ url: "https://cairn.example.com/path", confirm: "1" })).status).toBe(400);
    const moved = await form({ url: "https://cairn.example.com", confirm: "1" });
    expect(moved.status).toBe(303);
    expect(moved.headers.get("location")).toBe("https://cairn.example.com/recover");
    expect(await setting("canonical_url")).toBe("https://cairn.example.com");
    const old = await send("/app");
    expect(old.status).toBe(308);
    expect(old.headers.get("location")).toBe("https://cairn.example.com/app");
  });

  it("a non-admin can't move it, and with PUBLIC_URL set nobody can", async () => {
    const r = await claim(await codeFromLog());
    await env.DB.prepare("UPDATE users SET is_admin = 0").run();
    const me = await env.DB.prepare("SELECT id FROM users").first<{ id: string }>();
    await freshReauth(me?.id ?? "");
    const body = () => new URLSearchParams({ url: "https://cairn.example.com", confirm: "1" });
    expect((await send("/app/admin/site", { method: "POST", headers: { origin: BASE, cookie: r.cookie }, body: body() })).status).toBe(403);
    await env.DB.prepare("UPDATE users SET is_admin = 1").run();
    over = { PUBLIC_URL: BASE };
    expect((await send("/app/admin/site", { method: "POST", headers: { origin: BASE, cookie: r.cookie }, body: body() })).status).toBe(403);
    expect(await setting("canonical_url")).toBe(BASE);
  });
});

describe("pure helpers", () => {
  it("parseSiteUrl takes https origins (http only for localhost)", () => {
    expect(parseSiteUrl("https://Cairn.Example.com/")).toBe("https://cairn.example.com");
    expect(parseSiteUrl("http://localhost:8787")).toBe("http://localhost:8787");
    for (const bad of ["http://cairn.example.com", "https://a.example/x", "https://u:p@a.example", "javascript:alert(1)", "", "https://a.example/?q"])
      expect(parseSiteUrl(bad), bad).toBeNull();
  });

  it("claim codes normalise look-alikes and separators", () => {
    expect(normaliseClaimCode(" abcde-fghjk ")).toBe("ABCDEFGHJK");
    expect(normaliseClaimCode("O0-Il")).toBe("0011");
  });

  it("compareBuild: newer release, newer upstream commit, or up to date; quiet without data", () => {
    const at = Date.now();
    const built = { CAIRN_COMMIT: "aaaaaaa1111", CAIRN_COMMIT_TIME: "1700000000" };
    expect(compareBuild(built, null).available).toBe(false);
    expect(compareBuild(built, { at, ok: false }).available).toBe(false);
    expect(compareBuild(built, { at, ok: true, release: "v9.0.0", mainSha: null, mainTime: null }).available).toBe(true);
    expect(compareBuild(built, { at, ok: true, release: "v0.0.1", mainSha: "bbbb", mainTime: 1700000000 + 3600 }).available).toBe(true);
    expect(compareBuild(built, { at, ok: true, release: null, mainSha: "aaaaaaa1111", mainTime: 1700000000 + 3600 }).available).toBe(false);
    expect(compareBuild(built, { at, ok: true, release: null, mainSha: "bbbb", mainTime: 1700000000 - 10 }).available).toBe(false);
    expect(compareBuild({}, { at, ok: true, release: null, mainSha: "bbbb", mainTime: 1700000000 }).available).toBe(false);
  });
});
