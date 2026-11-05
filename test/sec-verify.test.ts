import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blockedHost, checkUrl, safeFetch } from "../src/capture/fetch";
import { createPat } from "../src/directory";
import worker from "../src/index";
import { BASE, caller, defaultVault, makeUser } from "./helpers";
import { fetchWorker } from "./oauth";

/** Remove every place a search page legitimately repeats the user's own query. */
function withoutEcho(html: string, q: string): string {
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.replace(new RegExp(esc, "gi"), "<<ECHO>>").replace(new RegExp(encodeURIComponent(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<<ECHO>>");
}

describe("live lead 1: B searching for A's canary", () => {
  it("returns no rows and none of A's data; the canary appears only where B's own query is echoed", async () => {
    const a = await makeUser("sva");
    const b = await makeUser("svb");
    const canary = `swordfish${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const av = await defaultVault(a.user.id);
    const w = await av.stub.writeNote(av.ref, caller(a.user), {
      directory: "secret",
      title: `Vault code ${canary}`,
      content: `The code is ${canary}-body\n\n- [secret] ${canary} opens the safe`,
    });
    if (!w.ok) throw new Error(w.message);
    const bv = await defaultVault(b.user.id);
    await bv.stub.writeNote(bv.ref, caller(b.user), { title: "Bob's own note", content: "nothing to see" });

    // A finds it (control: the search works and would show a row).
    const mine = await (await fetchWorker(`/app/search?q=${encodeURIComponent(canary)}`, { headers: { cookie: a.cookie } })).text();
    expect(mine).toContain('class="hit');
    expect(mine).toContain(w.value.note.permalink);

    for (const path of [`/app/search?q=${encodeURIComponent(canary)}`, `/app/search?q=${encodeURIComponent(canary)}&project=main`]) {
      const res = await fetchWorker(path, { headers: { cookie: b.cookie } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('class="hit');
      expect(html).toContain('data-state="empty"');
      expect(html).toMatch(/0 results/);
      const rest = withoutEcho(html, canary);
      expect(rest).not.toContain(canary.toLowerCase());
      for (const leak of [w.value.note.permalink, "Vault code", "opens the safe", "-body", "secret/"]) expect(rest).not.toContain(leak);
    }
    // The JSON API (no echo at all): no hits, no canary.
    const api = await fetchWorker(`/app/api/search?q=${encodeURIComponent(canary)}`, { headers: { cookie: b.cookie } });
    const j = (await api.json()) as { hits: unknown[]; total: number };
    expect(j.hits).toEqual([]);
    expect(JSON.stringify(j).replaceAll(canary, "")).not.toContain("Vault code");
    // B can't reach A's project by name either.
    expect((await fetchWorker(`/app/search?q=${canary}&project=${encodeURIComponent(av.vault.name)}x`, { headers: { cookie: b.cookie } })).status).toBe(404);
    expect(env).toBeTruthy();
  });
});

describe("live lead 2: SSRF through wildcard DNS names", () => {
  it("refuses rebinding / wildcard DNS services and names that embed a private address", () => {
    for (const u of [
      "http://127.0.0.1.nip.io/",
      "https://anything.nip.io/",
      "http://10.0.0.5.sslip.io/",
      "http://app-127-0-0-1.sslip.io/",
      "http://7f000001.sslip.io/",
      "http://xip.io/",
      "http://foo.localtest.me/",
      "http://lvh.me/",
      "http://app.vcap.me/",
      "http://192.168.1.1.my-own-wildcard.example/",
      "http://svc-10-1-2-3.corp-dns.example/",
      "http://169-254-169-254.metadata.example/",
      "http://0a000001.example/",
    ])
      expect(checkUrl(u).ok, u).toBe(false);
    expect(blockedHost("127.0.0.1.nip.io")).toMatch(/wildcard DNS/);
    expect(blockedHost("192.168.1.1.my-own-wildcard.example")).toMatch(/embeds a private address/);
    // Ordinary public names still pass, including ones with numbers and hex-looking labels.
    for (const u of [
      "https://example.com/",
      "https://8.8.8.8.example.com/", // public address embedded: not refused by this rule
      "https://cdn-1-2-3.example.com/",
      "https://deadbeef.example.com/",
      "https://f0000000.example.com/",
      "https://news.ycombinator.com/item?id=1",
    ])
      expect(checkUrl(u).ok, u).toBe(true);
  });

  it("a non-2xx response is a refusal, so an error page is never stored (attach_file end to end)", async () => {
    const errorPage = (async () =>
      new Response("<html>error code: 1003</html>", { status: 403, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await safeFetch("https://public.example/x", { fetcher: errorPage })).toMatchObject({ ok: false, code: "FETCH_FAILED" });
    const ok = (async () => new Response("fine", { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    expect(await safeFetch("https://public.example/x", { fetcher: ok })).toMatchObject({ ok: true, status: 200 });

    const { user } = await makeUser("ssrf");
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const call = async (url: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${pat}`,
            host: "localhost:8787",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "attach_file", arguments: { url } } }),
        }),
        { ...env, CAPTURE_FETCH: errorPage } as typeof env,
        ctx,
      );
      const text = await res.text();
      await waitOnExecutionContext(ctx);
      return text;
    };
    expect(await call("http://127.0.0.1.nip.io/")).toMatch(/BLOCKED: Refused: wildcard DNS/);
    expect(await call("https://public.example/file.bin")).toMatch(/FETCH_FAILED: The server answered 403; nothing was saved/);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("live lead 3: security headers on every response type", () => {
  it("JSON errors, OAuth endpoints, MCP, rate-limit answers and pages all carry nosniff and a CSP", async () => {
    const send = async (path: string, init: RequestInit = {}, over: Partial<typeof env> = {}) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`${BASE}${path}`, { redirect: "manual", ...init }), { ...env, ...over } as typeof env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const deny = { limit: async () => ({ success: false }) };
    const cases: [string, Response][] = [
      ["/mcp 401", await send("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })],
      [
        "/oauth/token 400",
        await send("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=nope" }),
      ],
      ["/.well-known 200", await send("/.well-known/oauth-authorization-server")],
      ["/app/api/search 401", await send("/app/api/search?q=x")],
      ["/oauth/token 429", await send("/oauth/token", { method: "POST", body: "x" }, { RL_TOKEN: deny as never })],
      ["/nope 404", await send("/app/nope-not-a-route")],
    ];
    for (const [label, r] of cases) {
      expect(r.headers.get("x-content-type-options"), label).toBe("nosniff");
      expect(r.headers.get("content-security-policy"), label).toBeTruthy();
      expect(r.headers.get("x-frame-options"), label).toBeTruthy();
    }
    expect(cases.find(([l]) => l === "/oauth/token 429")?.[1].status).toBe(429);
    expect(cases[0][1].status).toBe(401);
    expect(cases[0][1].headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    // A page keeps its own, richer policy.
    const page = await send("/login");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  });
});
