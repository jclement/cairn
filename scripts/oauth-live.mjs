// Live OAuth client-compatibility test: the paths real MCP clients take against a deployed Cairn.
// Signs up a throwaway account (CDP virtual passkey), then for each client:
//   401 from /mcp → protected-resource metadata → authorization-server metadata → /authorize
//   (PKCE S256 + resource indicator) → consent page (screenshot) → code → token → MCP initialize,
//   tools/list, write_note, search_notes → refresh-token rotation → revoke in Settings →
//   Connected apps → the access token is 401 and the refresh token is refused.
// Clients: Claude Code (its CIMD URL, loopback redirect on a random port), claude.ai (its hosted
// CIMD, redirect https://claude.ai/api/mcp/auth_callback; the redirect is read from the consent
// response and never delivered to claude.ai), and a plain DCR client (MCP Inspector style).
// The account is deleted at the end. Run: PLAYWRIGHT=/path/to/playwright/index.mjs mise run oauth:live
// Env: CAIRN_URL (default https://cairn.onewheelgeek.net), SHOTS (screenshot folder), CHROMIUM_PATH.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const U = (process.env.CAIRN_URL || "https://cairn.onewheelgeek.net").replace(/\/+$/, "");
const SHOTS = process.env.SHOTS || "/tmp/claude-1000/cairn-oauth";
mkdirSync(SHOTS, { recursive: true });
const user = `oauth${Date.now().toString(36)}`;
const out = [];
const ok = (name, cond, extra = "") => {
  out.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  return cond;
};
const b64url = (b) => Buffer.from(b).toString("base64url");
const port = () => 20000 + Math.floor(Math.random() * 40000);

const CLIENTS = [
  {
    name: "Claude Code (CIMD, loopback)",
    clientId: "https://claude.ai/oauth/claude-code-client-metadata",
    redirect: () => `http://localhost:${port()}/callback`,
  },
  {
    name: "claude.ai (CIMD, hosted callback)",
    clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    redirect: () => "https://claude.ai/api/mcp/auth_callback",
  },
  { name: "DCR client (Inspector style)", dcr: true, redirect: () => `http://127.0.0.1:${port()}/oauth/callback` },
];

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

async function mcp(token, method, params, id = 1) {
  const r = await fetch(`${U}/mcp`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  let json = null;
  try {
    json = JSON.parse(line ? line.slice(5) : t);
  } catch {}
  return { status: r.status, headers: r.headers, json, raw: t.slice(0, 300) };
}

async function token(endpoint, form) {
  const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}

try {
  await page.goto(`${U}/signup`);
  await page.fill("#username", user);
  await page.click("form[data-passkey=signup] button[type=submit]");
  await page.waitForSelector("#recovery:not([hidden])", { timeout: 20000 });
  ok("sign up with a passkey", true, user);

  // Discovery, as a client does it: 401 → resource metadata → authorization-server metadata.
  const anon = await mcp(null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } });
  const www = anon.headers.get("www-authenticate") || "";
  const rmUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1];
  ok("unauthenticated /mcp is 401 with resource_metadata", anon.status === 401 && !!rmUrl, `${anon.status} ${www.slice(0, 120)}`);
  const rm = await (await fetch(rmUrl)).json();
  ok("protected-resource metadata names /mcp and the issuer", rm.resource === `${U}/mcp` && rm.authorization_servers?.[0] === U, JSON.stringify(rm).slice(0, 160));
  const as = await (await fetch(`${rm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  ok(
    "AS metadata: S256, CIMD + public clients, DCR",
    as.code_challenge_methods_supported?.includes("S256") &&
      as.client_id_metadata_document_supported === true &&
      as.token_endpoint_auth_methods_supported?.includes("none") &&
      !!as.registration_endpoint,
  );
  // As Claude chooses scopes: the 401's scope parameter, else the resource metadata's
  // scopes_supported, plus offline_access when the authorization server lists it.
  const challenged = /scope="([^"]*)"/.exec(www)?.[1]?.split(" ").filter(Boolean);
  const asked = challenged?.length ? challenged : (rm.scopes_supported ?? []);
  ok("clients are asked to request read and write", asked.includes("memory:read") && asked.includes("memory:write"), asked.join(" "));
  const scope = [...asked, ...(as.scopes_supported?.includes("offline_access") ? ["offline_access"] : [])].join(" ");

  for (const c of CLIENTS) {
    const tag = c.name;
    const slug = tag.split(" ")[0].replace(/\W/g, "").toLowerCase() + (c.dcr ? "-dcr" : "");
    const redirectUri = c.redirect();
    let clientId = c.clientId;
    if (c.dcr) {
      const reg = await fetch(as.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "MCP Inspector (oauth-live)",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      const j = await reg.json().catch(() => ({}));
      clientId = j.client_id;
      if (!ok(`${tag}: dynamic registration`, reg.status === 201 && !!clientId, `${reg.status} ${JSON.stringify(j).slice(0, 120)}`)) continue;
    }
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(12));
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope,
      resource: rm.resource,
    });
    const consent = await page.goto(`${as.authorization_endpoint}?${q}`);
    const body = await page.content();
    const shot = `${SHOTS}/consent-${slug}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    if (!ok(`${tag}: consent page`, consent.status() === 200 && body.includes('name="handle"'), `${consent.status()} ${shot}`)) {
      out.push(`      ${(await page.textContent("body"))?.replace(/\s+/g, " ").slice(0, 300)}`);
      continue;
    }
    const shown = (await page.textContent("main"))?.replace(/\s+/g, " ") ?? "";
    out.push(`      consent says: ${shown.slice(0, 260)}`);
    // Submit the consent form as the browser would, but read the redirect instead of following it.
    const fields = await page.$$eval("form[action='/authorize'] input", (els) =>
      els.filter((e) => e.name && (e.type === "hidden" || e.checked)).map((e) => [e.name, e.value]),
    );
    const form = new URLSearchParams(fields);
    form.set("decision", "approve");
    const approve = await ctx.request.post(`${U}/authorize`, {
      headers: { origin: U, "content-type": "application/x-www-form-urlencoded" },
      data: form.toString(),
      maxRedirects: 0,
    });
    const loc = approve.headers().location ?? "";
    const back = loc ? new URL(loc) : null;
    const code = back?.searchParams.get("code");
    if (
      !ok(
        `${tag}: approve redirects to the client with code, state and iss`,
        approve.status() === 302 &&
          `${back?.origin}${back?.pathname}` === redirectUri.replace(/\?.*$/, "") &&
          !!code &&
          back?.searchParams.get("state") === state &&
          back?.searchParams.get("iss") === as.issuer,
        `${approve.status()} ${loc.replace(/code=[^&]+/, "code=…").slice(0, 160)}`,
      )
    )
      continue;

    const t1 = await token(as.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: rm.resource });
    if (
      !ok(
        `${tag}: code → tokens (public client, PKCE)`,
        t1.status === 200 && !!t1.json?.access_token && !!t1.json?.refresh_token,
        `${t1.status} scope=${t1.json?.scope ?? ""} expires_in=${t1.json?.expires_in ?? ""} ${t1.json?.error ?? ""}`,
      )
    )
      continue;
    ok(`${tag}: granted read and write (the consent default)`, /memory:write/.test(t1.json.scope ?? ""), t1.json.scope);

    const at = t1.json.access_token;
    const init = await mcp(at, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: slug, version: "1" } });
    ok(`${tag}: MCP initialize`, init.status === 200 && init.json?.result?.serverInfo?.name === "cairn", `${init.status} ${init.raw.slice(0, 80)}`);
    const list = await mcp(at, "tools/list", {}, 2);
    const tools = (list.json?.result?.tools ?? []).map((t) => t.name);
    ok(`${tag}: tools/list`, tools.includes("write_note") && tools.includes("search_notes"), `${tools.length} tools`);
    const w = await mcp(at, "tools/call", { name: "write_note", arguments: { title: `OAuth ${slug}`, directory: "oauth", content: `- [fact] written by ${tag} over OAuth #oauthlive` } }, 3);
    const wt = w.json?.result?.content?.[0]?.text ?? w.raw;
    ok(`${tag}: write_note returns a receipt`, /^saved .* rev .* at /.test(wt), wt.slice(0, 120));
    const s = await mcp(at, "tools/call", { name: "search_notes", arguments: { query: "oauthlive", mode: "text" } }, 4);
    const st = s.json?.result?.content?.[0]?.text ?? s.raw;
    ok(`${tag}: search_notes finds it`, st.includes(`OAuth ${slug}`), st.slice(0, 100));

    // Refresh-token rotation.
    const r1 = t1.json.refresh_token;
    const t2 = await token(as.token_endpoint, { grant_type: "refresh_token", refresh_token: r1, client_id: clientId, resource: rm.resource });
    ok(`${tag}: refresh returns new tokens`, t2.status === 200 && !!t2.json?.access_token && t2.json?.refresh_token && t2.json.refresh_token !== r1, `${t2.status} ${t2.json?.error ?? ""}`);
    const r2 = t2.json?.refresh_token;
    const t3 = await token(as.token_endpoint, { grant_type: "refresh_token", refresh_token: r2, client_id: clientId, resource: rm.resource });
    ok(`${tag}: the rotated refresh token works`, t3.status === 200 && !!t3.json?.access_token, `${t3.status} ${t3.json?.error ?? ""}`);
    const old = await token(as.token_endpoint, { grant_type: "refresh_token", refresh_token: r1, client_id: clientId, resource: rm.resource });
    ok(`${tag}: a refresh token two rotations old is refused (invalid_grant)`, old.status === 400 && old.json?.error === "invalid_grant", `${old.status} ${old.json?.error ?? ""}`);
    const live = t3.json?.access_token ?? at;
    const r3 = t3.json?.refresh_token ?? r2;
    ok(`${tag}: refreshed access token works`, (await mcp(live, "tools/list", {}, 5)).status === 200);

    // Revoke in Settings → Connected apps.
    // Grants are listed from KV, whose list() is eventually consistent: give it up to two minutes
    // and record how long the new grant took to appear.
    const t0 = Date.now();
    let n = 0;
    const row = page.locator("li", { hasText: clientId });
    for (;;) {
      await page.goto(`${U}/app/settings/apps`);
      n = await row.count();
      if (n || Date.now() - t0 > 120_000) break;
      await page.waitForTimeout(5000);
    }
    await page.screenshot({ path: `${SHOTS}/apps-${slug}.png`, fullPage: true });
    const lag = Math.round((Date.now() - t0) / 1000);
    if (!ok(`${tag}: listed under Connected apps`, n >= 1, `${n} row(s) after ${lag}s`)) continue;
    ok(`${tag}: listed within 5 s of approval`, lag <= 5, `${lag}s`);
    await row.first().locator("button", { hasText: "Revoke" }).click();
    await page.waitForLoadState("load");
    ok(`${tag}: revoked from Settings`, (await page.locator("li", { hasText: clientId }).count()) === 0);
    const after = await mcp(live, "tools/list", {}, 6);
    ok(`${tag}: access token is 401 after revoke`, after.status === 401, String(after.status));
    const rAfter = await token(as.token_endpoint, { grant_type: "refresh_token", refresh_token: r3, client_id: clientId, resource: rm.resource });
    ok(`${tag}: refresh token refused after revoke`, rAfter.status === 400 && rAfter.json?.error === "invalid_grant", `${rAfter.status} ${rAfter.json?.error ?? ""}`);
  }
  // A replayed authorization code is refused, and (RFC 6749 §4.1.2, OAuth 2.1) revokes the grant it
  // issued: tokens from that code stop working. Done on its own authorization so it can't affect the above.
  {
    const redirectUri = `http://127.0.0.1:${port()}/callback`;
    const reg = await (
      await fetch(as.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "oauth-live replay", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
      })
    ).json();
    const verifier = b64url(randomBytes(32));
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state: "replay",
      scope,
      resource: rm.resource,
    });
    await page.goto(`${as.authorization_endpoint}?${q}`);
    const fields = await page.$$eval("form[action='/authorize'] input", (els) => els.filter((e) => e.name && (e.type === "hidden" || e.checked)).map((e) => [e.name, e.value]));
    const form = new URLSearchParams(fields);
    form.set("decision", "approve");
    const approve = await ctx.request.post(`${U}/authorize`, { headers: { origin: U, "content-type": "application/x-www-form-urlencoded" }, data: form.toString(), maxRedirects: 0 });
    const code = new URL(approve.headers().location).searchParams.get("code");
    const ex = { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier, resource: rm.resource };
    const first = await token(as.token_endpoint, ex);
    const again = await token(as.token_endpoint, ex);
    ok("a replayed code is refused (invalid_grant)", again.status === 400 && again.json?.error === "invalid_grant", `${again.status} ${again.json?.error ?? ""}`);
    const dead = await mcp(first.json?.access_token, "tools/list", {}, 7);
    ok("…and the tokens it issued are revoked", first.status === 200 && dead.status === 401, `${first.status} then ${dead.status}`);
  }
} catch (e) {
  ok("unexpected error", false, String(e?.stack ?? e).slice(0, 400));
} finally {
  // Clean up the throwaway account (needs a fresh passkey re-check).
  try {
    await page.goto(`${U}/app/reauth?next=/app/settings`);
    await page.click("form[data-passkey=reauth] button[type=submit]");
    await page.waitForURL((u) => !u.pathname.startsWith("/app/reauth"), { timeout: 20000 });
    const del = await page.evaluate(async (u) => {
      const fd = new FormData();
      fd.set("confirm", u);
      const r = await fetch("/app/settings/delete", { method: "POST", body: fd, redirect: "manual" });
      return r.status;
    }, user);
    const signedOut = /\/login/.test((await page.goto(`${U}/app`)).url());
    ok("throwaway account deleted", [200, 302, 303, 0].includes(del) && signedOut, `${del}`);
  } catch (e) {
    ok("throwaway account deleted", false, String(e).slice(0, 200));
  }
  await browser.close();
  console.log(`user ${user}\n${out.join("\n")}`);
  if (out.some((l) => l.startsWith("FAIL"))) process.exitCode = 1;
}
