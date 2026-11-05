// Live end-to-end smoke test for Cairn with a CDP virtual WebAuthn authenticator.
// Signs up a throwaway account, uses the app, mints a PAT, drives /mcp, then deletes the account.
// Needs Playwright with Chromium: PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/smoke-live.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");

const U = process.env.CAIRN_URL || "https://cairn.onewheelgeek.net";
const user = "smoke" + Date.now().toString(36);
const out = [];
const ok = (name, cond, extra = "") => { out.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); return cond; };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

try {
  // Landing
  await page.goto(U + "/");
  ok("landing renders", (await page.title()).length > 0, await page.title());
  ok("landing has a cringe quote", (await page.content()).toLowerCase().includes("fictional"));

  // Sign up with a passkey
  await page.goto(U + "/signup");
  await page.fill("#username", user);
  await page.click("form[data-passkey=signup] button[type=submit]");
  await page.waitForSelector("#recovery:not([hidden])", { timeout: 20000 });
  const codes = (await page.textContent("#recovery pre.codes")) || "";
  ok("signup with passkey + recovery codes shown", codes.trim().split(/\s+/).length >= 10, `${codes.trim().split(/\s+/).length} codes`);

  // App home, stats, graph, search
  for (const p of ["/app", "/app/stats", "/app/graph", "/app/search?q=coffee", "/app/settings", "/app/settings/account"]) {
    const r = await page.goto(U + p);
    ok(`GET ${p}`, r.status() === 200, String(r.status()));
  }

  // Create a note in the browser editor via the JSON API (same-origin fetch from the page)
  const created = await page.evaluate(async () => {
    const r = await fetch("/app/api/notes", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "main", title: "Coffee Brewing", folder: "smoke",
        content: "# Coffee Brewing\n\n## Observations\n- [preference] Jeff likes a 1:16 ratio #coffee\n- [method] Pour over for clarity\n\n## Relations\n- requires [[Burr Grinder]]\n\n```mermaid\ngraph LR; A-->B\n```\n" }) });
    return { status: r.status, body: await r.text() };
  });
  ok("web create note", created.status === 200 || created.status === 201, `${created.status} ${created.body.slice(0, 120)}`);

  // Reauth (virtual authenticator) then mint a read/write PAT
  await page.goto(U + "/app/reauth?next=/app/settings");
  await page.click("form[data-passkey=reauth] button[type=submit]");
  await page.waitForURL((u) => !u.pathname.startsWith("/app/reauth"), { timeout: 20000 });
  ok("reauth with passkey", true);
  const pat = await page.evaluate(async () => {
    const fd = new FormData(); fd.set("name", "smoke"); fd.set("write", "1"); fd.set("days", "1");
    const r = await fetch("/app/settings/tokens", { method: "POST", body: fd });
    const t = await r.text(); const m = t.match(/cairn_pat_[A-Za-z0-9_\-]+/); return m ? m[0] : ("ERR " + r.status + " " + r.url + " " + t.slice(0, 200));
  });
  ok("create PAT after reauth", !!pat && pat.startsWith("cairn_pat_"), pat && !pat.startsWith("cairn_pat_") ? pat : "");

  // MCP over streamable HTTP with the PAT
  const mcp = async (method, params, id) => {
    const r = await fetch(U + "/mcp", { method: "POST",
      headers: { authorization: `Bearer ${pat}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data:"));
    try { return { status: r.status, json: JSON.parse(line ? line.slice(5) : t) }; } catch { return { status: r.status, raw: t.slice(0, 300) }; }
  };
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } }, 1);
  ok("MCP initialize", init.status === 200 && !!init.json?.result, `${init.status} ${init.json?.result?.serverInfo?.name ?? init.raw ?? ""}`);
  const list = await mcp("tools/list", {}, 2);
  const tools = (list.json?.result?.tools || []).map((t) => t.name);
  ok("MCP tools/list", tools.includes("write_note") && tools.includes("search_notes"), tools.join(","));
  const call = (name, args, id) => mcp("tools/call", { name, arguments: args }, id);
  const w = await call("write_note", { title: "Smoke Test Note", directory: "smoke", content: "- [fact] The smoke test ran on the live site #smoke\n- relates_to [[Coffee Brewing]]" }, 3);
  const wtext = JSON.stringify(w.json?.result?.content ?? w.raw ?? "");
  ok("MCP write_note returns a receipt", /saved .*rev .* at /.test(wtext), wtext.slice(0, 200));
  const s = await call("search_notes", { query: "coffee ratio" }, 4);
  const stext = JSON.stringify(s.json?.result?.content ?? s.raw ?? "");
  ok("MCP search_notes finds the note", /Coffee Brewing/i.test(stext), stext.slice(0, 200));
  const rd = await call("read_note", { identifier: "smoke/smoke-test-note" }, 5);
  const rtext = JSON.stringify(rd.json?.result?.content ?? rd.raw ?? "");
  ok("MCP read_note", /smoke test ran/i.test(rtext), rtext.slice(0, 160));
  const ctxr = await call("build_context", { identifier: "memory://smoke/smoke-test-note", depth: 1 }, 6);
  ok("MCP build_context", !!ctxr.json?.result && !ctxr.json.result.isError && /Coffee Brewing/.test(JSON.stringify(ctxr.json.result.content)), JSON.stringify(ctxr.json?.result?.content ?? "").slice(0, 120));

  // Note page renders the mermaid + observations
  const note = await page.goto(U + "/app/v/main/n/smoke/coffee-brewing");
  ok("note page renders", note.status() === 200 && (await page.content()).includes("1:16"));

  // Export (needs fresh reauth; we have one)
  const exp = await page.evaluate(async () => { const r = await fetch("/export"); return { s: r.status, ct: r.headers.get("content-type"), n: (await r.arrayBuffer()).byteLength }; });
  ok("export zip", exp.s === 200 && /zip/.test(exp.ct || ""), `${exp.s} ${exp.ct} ${exp.n} bytes`);

  // Delete account (reauth still fresh) — cleans up the smoke user
  const del = await page.evaluate(async (u) => { const fd = new FormData(); fd.set("confirm", u); const r = await fetch("/app/settings/delete", { method: "POST", body: fd, redirect: "manual" }); return r.status; }, user);
  ok("delete account", [200, 302, 303, 0].includes(del), String(del));
  const after = await page.goto(U + "/app");
  ok("signed out after delete", /\/login/.test(after.url()), after.url());
  const patAfter = await mcp("tools/list", {}, 9);
  ok("PAT revoked after delete", patAfter.status === 401, String(patAfter.status));
} catch (e) {
  ok("unexpected error", false, String(e).slice(0, 300));
} finally {
  ok("no page JS errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
  console.log(`user ${user}\n` + out.join("\n"));
}
