// Test helper: drive the real OAuth flow (DCR, /authorize with a session, consent, token) to get
// an access token for /mcp. Nothing here is mocked except the passkey sign-in (a session row).
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import worker from "../src/index";
import { BASE } from "./helpers";

/** Env vars layered over the test env for every request these helpers send (null: the plain worker). */
let envOverride: Record<string, string> | null = null;
export function setWorkerEnv(over: Record<string, string> | null): void {
  envOverride = over;
}

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function cookiesFrom(res: Response): string[] {
  const all = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  return all.map((c) => c.split(";")[0]);
}

export async function fetchWorker(path: string, init?: RequestInit) {
  const req = new Request(`${BASE}${path}`, { redirect: "manual", ...init });
  if (!envOverride) return exports.default.fetch(req);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...envOverride }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function getAccessToken(
  sessionCookie: string,
  scope = "memory:read memory:write",
): Promise<{ accessToken: string; clientId: string; refreshToken?: string }> {
  const redirectUri = "http://127.0.0.1:9999/callback";
  const reg = await fetchWorker("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (reg.status !== 201) throw new Error(`register ${reg.status}: ${await reg.text()}`);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st8",
    scope,
    resource: `${BASE}/mcp`,
  });
  const page = await fetchWorker(`/authorize?${q}`, { headers: { cookie: sessionCookie } });
  if (page.status !== 200) throw new Error(`authorize ${page.status}: ${await page.text()}`);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) throw new Error("no consent handle");
  const cookies = [sessionCookie, ...cookiesFrom(page)].join("; ");
  const form = new URLSearchParams();
  form.set("handle", handle);
  for (const s of scope.split(" ")) form.append("scope", s);
  form.set("decision", "approve");
  const approved = await fetchWorker("/authorize", {
    method: "POST",
    headers: { cookie: cookies, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (approved.status !== 302) throw new Error(`approve ${approved.status}: ${await approved.text()}`);
  const loc = new URL(approved.headers.get("location") ?? "");
  const code = loc.searchParams.get("code");
  if (!code || loc.searchParams.get("state") !== "st8") throw new Error(`bad redirect ${loc}`);

  const tok = await fetchWorker("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  if (tok.status !== 200) throw new Error(`token ${tok.status}: ${await tok.text()}`);
  const { access_token, refresh_token } = (await tok.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: access_token, clientId, refreshToken: refresh_token };
}

let rpcId = 0;
export async function mcp(token: string, method: string, params: unknown = {}) {
  const res = await fetchWorker("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      host: "localhost:8787",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`mcp ${method} ${res.status}: ${text}`);
  const payload = res.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .pop()
    : text;
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC payloads in tests
  return JSON.parse(payload ?? "{}") as any;
}

export async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result as { content: { type: string; text: string }[]; isError?: boolean };
}
