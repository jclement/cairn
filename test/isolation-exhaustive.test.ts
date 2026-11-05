// Isolation suite (Jeff: "no way for an unauth user to steal data. No way for cross tenant."):
// an exhaustive ENDPOINT INVENTORY with an isolation ATTACK MATRIX, plus well-formed control/attack
// pairs for the sensitive handlers. It is strong evidence, not a proof of every code path.
//
// What it does:
// - Inventory: every route createApp() registers (method + path), every OAuth provider endpoint and
//   every MCP tool from tools/list (Cairn names and, with BM_COMPAT on, the bm_* aliases) must have
//   a case here, and every case must still exist.
// - Attack matrix: user A is seeded with every kind of resource; each route/tool is called with A's
//   real ids and names, as seven identities: 1 no auth, 2 garbage cookie/token, 3 user B's session,
//   4 B's PAT, 5 B's OAuth token, 6 A's revoked PAT, 7 A's read-only OAuth grant (for writes).
//   Generic bodies: B's session sends every one of A's ids in JSON and multipart. These may stop at
//   validation (400) before the sensitive branch; that is why the control pairs below exist.
// - Control/attack pairs (CONTROLS): for the handlers that read or change data, a route-specific,
//   well-formed request is first sent by B against B's own resource and must succeed with its
//   effect visible (so the request shape reaches the sensitive branch); the identical request
//   aimed at A's resource (with A's real checksum, as if leaked) must leave A unchanged.
// - Assertions: no response (body or headers) contains any of A's canaries that the request didn't
//   carry (by-design exception: a valid invite link names its inviter); A's state is unchanged (D1
//   rows, both vaults' notes/revisions/imports, A's R2 objects, A's OAuth grant/token keys in KV);
//   unauthenticated callers get 3xx-to-login/401/403/404 on everything that isn't public; no 5xx.
// - Feature flags are set on explicitly (IMPORT_ENABLED, SCHEMA_ENABLED, BM_COMPAT) and asserted.
//
// What it does not cover (tested elsewhere or not at all): rate limits (bindings removed here so
// every request reaches its handler; see the limiter tests), inbound email (test/email-e2e.test.ts),
// middleware registered dynamically (method ALL), every command combination of every tool,
// concurrency/races, and DEV_LOGIN (unset here as in production; the top-level config is checked).
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { newInboxKey } from "../src/capture/email";
import { putAttachment } from "../src/capture/files";
import { createInvite, createPat, createSession, createVault, deletePat, listPats, type Vault } from "../src/directory";
import worker, { providerOptions } from "../src/index";
import { BM_NAMES } from "../src/mcp/names";
import { createApp } from "../src/web/app";
import wranglerConfig from "../wrangler.jsonc?raw";
import { BASE, caller, defaultVault, makeUser } from "./helpers";
import { getAccessToken } from "./oauth";

const quietEnv = {
  ...env,
  RL_AUTH: undefined,
  RL_OAUTH: undefined,
  RL_TOKEN: undefined,
  RL_AUTHORIZE: undefined,
  RL_WRITE: undefined,
  RL_SEARCH: undefined,
  RL_INVITE: undefined,
  DEV_LOGIN: undefined,
  // Every feature on, so every handler and alias is in the matrix.
  IMPORT_ENABLED: "true",
  SCHEMA_ENABLED: "true",
  BM_COMPAT: "true",
} as unknown as typeof env;

type Sent = { status: number; text: string; headers: Headers };
async function send(path: string, init: RequestInit = {}): Promise<Sent> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, { redirect: "manual", ...init }), quietEnv, ctx);
  const buf = await res.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return { status: res.status, text: new TextDecoder().decode(buf), headers: res.headers };
}

// ---------------------------------------------------------------- seeding

const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const c = (label: string) => `cnry${tag}${label}`;
const enc = (s: string) => new TextEncoder().encode(s);

async function seed() {
  const a = await makeUser("alice");
  const b = await makeUser("bob");
  const am = await defaultVault(a.user.id);
  const w = async (v: { stub: ReturnType<typeof env.VAULT.getByName>; ref: { id: string; name: string; ownerId: string } }, input: Record<string, unknown>) => {
    const r = await v.stub.writeNote(v.ref, caller(a.user), input as never);
    if (!r.ok) throw new Error(`seed write failed: ${r.message}`);
    return r.value.note as { permalink: string; title: string };
  };
  const main = await w(am, {
    title: `Main ${c("maintitle")}`,
    content: `${c("mainbody")} ${c("mainsealed")}\n\n- [fact] ${c("mainobs")}\n- relates_to [[Pinned ${c("pintitle")}]]`,
  });
  await w(am, {
    identifier: main.permalink,
    title: main.title,
    overwrite: true,
    content: `${c("mainbody")} ${c("mainsealed")} ${c("revbody")}\n\n- [fact] ${c("mainobs")} ${c("obssealed")}`,
  });
  await w(am, { title: `Pinned ${c("pintitle")}`, content: `---\npinned: true\n---\n${c("pinbody")}` });
  await w(am, {
    directory: "schemas",
    title: "Person",
    content: `---\ntype: schema\nentity: Person\nschema:\n  name: string, ${c("schemadesc")}\n---\n${c("schemabody")}`,
  });
  await w(am, { directory: "gardening", title: "Gardening 2026-11-04", content: `- [ ] ${c("gardenitem")}` });
  await w(am, { identifier: "memory/index", title: "Index", content: `- [[Main ${c("maintitle")}]] ${c("indexline")}` });

  const projName = `proj${tag}`;
  const pv = await createVault(env, a.user.id, projName);
  if (!pv.ok) throw new Error(pv.message);
  const proj = { vault: pv.vault, stub: env.VAULT.getByName(pv.vault.id), ref: { id: pv.vault.id, name: pv.vault.name, ownerId: a.user.id } };
  const secret = await w(proj, {
    directory: "deep",
    title: `Secret ${c("projtitle")}`,
    content: `${c("projbody")} ${c("projsealed")}\n\n- [fact] ${c("projobs")} ${c("projobssealed")}`,
  });

  const att = await putAttachment(env, pv.vault as Vault, { bytes: enc(`file ${c("filebytes")}`), name: `${c("filename")}.txt`, source: "upload" });
  if (!att.ok) throw new Error(att.message);

  const jobId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO import_jobs (id, user_id, vault_id, status, staged_bytes, created_at) VALUES (?, ?, ?, 'staging', 0, ?)")
    .bind(jobId, a.user.id, pv.vault.id, new Date().toISOString())
    .run();
  const staged = await proj.stub.importStage(proj.ref, { id: jobId, source: "basic-memory", userId: a.user.id, username: a.user.username, overwrite: false }, [
    { path: `${c("importpath")}.md`, folder: "", title: c("importtitle"), content: c("importbody") },
  ]);
  if (!staged.ok) throw new Error("seed import failed");

  const aPat = await createPat(env, a.user.id, `pat ${c("patname")}`, ["memory:read", "memory:write"], null);
  const revokedPat = await createPat(env, a.user.id, `old ${c("oldpatname")}`, ["memory:read", "memory:write"], null);
  const pats = await listPats(env, a.user.id);
  const patId = pats.find((p) => p.name.startsWith("pat "))?.id as string;
  const revokedPatId = pats.find((p) => p.name.startsWith("old "))?.id as string;
  await deletePat(env, a.user.id, revokedPatId);

  const aRead = await getAccessToken(a.cookie, "memory:read");
  const aWrite = await getAccessToken(a.cookie);
  const appsHtml = await (await send("/app/settings/apps", { headers: { cookie: a.cookie } })).text;
  const grantIds = [...appsHtml.matchAll(/name="grant" value="([^"]+)"/g)].map((m) => m[1]);
  if (grantIds.length < 2) throw new Error(`expected 2 grants, saw ${grantIds.length}`);

  const invite = await createInvite(env, a.user, { note: c("invitenote") });
  if (!invite.ok) throw new Error(invite.message);
  const inboxKey = newInboxKey();
  await env.DB.prepare("UPDATE users SET inbox_key = ? WHERE id = ?").bind(inboxKey, a.user.id).run();
  const credId = c("credid");
  await env.DB.prepare("INSERT INTO credentials (id, user_id, public_key, name, created_at) VALUES (?, ?, X'00', ?, ?)")
    .bind(credId, a.user.id, c("credname"), new Date().toISOString())
    .run();

  // B: own data and own credentials.
  const bm = await defaultVault(b.user.id);
  await bm.stub.writeNote(bm.ref, caller(b.user), { title: "Bob note", content: "bob's own words" });
  const bPat = await createPat(env, b.user.id, "bob pat", ["memory:read", "memory:write"], null);
  const bOauth = await getAccessToken(b.cookie);
  await env.DB.prepare("UPDATE sessions SET reauth_at = ? WHERE user_id = ?").bind(new Date().toISOString(), b.user.id).run(); // B can reach fresh-gated routes

  const aSession = a.cookie.split("=")[1];
  const ids = {
    user: a.user.id,
    mainVault: am.vault.id,
    projVault: pv.vault.id,
    att: att.attachment.id,
    job: jobId,
    pat: patId,
    revokedPat: revokedPatId,
    invite: invite.id,
    cred: credId,
    grantRead: grantIds[0],
    grantWrite: grantIds[1],
  };
  // Everything that must never reach B or an anonymous caller.
  const canaries = [
    ...[
      "maintitle",
      "mainbody",
      "mainobs",
      "revbody",
      "pintitle",
      "pinbody",
      "schemadesc",
      "schemabody",
      "gardenitem",
      "indexline",
      "projtitle",
      "projbody",
      "projobs",
      "filebytes",
      "filename",
      "importpath",
      "importtitle",
      "importbody",
      "patname",
      "oldpatname",
      "invitenote",
      "credid",
      "credname",
      ...SEALED,
    ].map(c),
    projName,
    a.user.username,
    aSession,
    aPat,
    revokedPat,
    aRead.accessToken,
    aWrite.accessToken,
    aRead.refreshToken ?? "",
    aWrite.refreshToken ?? "",
    invite.code,
    inboxKey,
    ...Object.values(ids),
  ].filter((x) => x && x.length >= 8);

  return {
    a,
    b,
    am,
    proj,
    projName,
    mainPermalink: main.permalink,
    secretPermalink: secret.permalink,
    ids,
    aPat,
    revokedPat,
    aRead,
    aWrite,
    bPat,
    bOauth,
    invite,
    inboxKey,
    canaries,
  };
}
type Seed = Awaited<ReturnType<typeof seed>>;

// ---------------------------------------------------------------- A's state

async function snapshot(s: Seed): Promise<string> {
  const keys = [s.a.user.id, s.ids.mainVault, s.ids.projVault, s.a.user.username];
  // Usage counters move when A's own read-only token is refused a write; they hold no A data.
  const skip = new Set(["stats_daily", "ai_daily", "ai_budget", "d1_migrations"]);
  const tables = (
    await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()
  ).results
    .map((t) => t.name)
    .filter((t) => !skip.has(t) && !t.includes("_fts"))
    .sort();
  const out: string[] = [];
  for (const t of tables) {
    const rows = (await env.DB.prepare(`SELECT * FROM "${t}"`).all()).results
      // Failed attempts against A's account are meant to be logged in A's audit trail.
      .filter((r) => !(t === "audit_log" && String((r as { action?: string }).action ?? "").endsWith(".fail")))
      // usage_version only versions A's own display snapshot (sizes unchanged); not data.
      .map((r) => JSON.stringify({ ...r, usage_version: undefined }))
      .filter((r) => keys.some((k) => r.includes(k)));
    if (rows.length) out.push(`${t}: ${rows.length} rows: ${rows.sort().join(" ; ")}`); // tables created lazily mid-run hold none of A's rows
  }
  for (const v of [s.am, s.proj]) {
    out.push(
      await runInDurableObject(v.stub, (_i, state) => {
        const q = (sql: string) => JSON.stringify(state.storage.sql.exec(sql).toArray());
        return [
          q("SELECT * FROM notes ORDER BY id"),
          q("SELECT COUNT(*) AS n, MAX(id) AS m FROM revisions"),
          q("SELECT COUNT(*) AS n FROM observations"),
          q("SELECT * FROM import_jobs ORDER BY id"),
          q("SELECT job, idx, status, path FROM import_items ORDER BY job, idx"),
        ].join("\n");
      }),
    );
  }
  // A's OAuth grants and tokens (KV) and every R2 object under A's vaults.
  for (const prefix of [`grant:${s.a.user.id}:`, `token:${s.a.user.id}:`]) {
    const keys = (await env.OAUTH_KV.list({ prefix })).keys.map((k) => k.name).sort();
    out.push(`kv ${prefix}: ${keys.join(" ")}`);
  }
  for (const v of [s.ids.mainVault, s.ids.projVault]) {
    const listed = (await env.FILES?.list({ prefix: `${v}/` }))?.objects.map((o) => `${o.key}:${o.size}:${o.etag}`) ?? [];
    out.push(`r2 ${v}: ${listed.sort().join(" ")}`);
  }
  const obj = await env.FILES?.get(
    ((await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?").bind(s.ids.att).first<{ r2_key: string }>())?.r2_key as string) ?? "missing",
  );
  out.push(`file: ${obj ? await obj.text() : "MISSING"}`);
  return out.join("\n---\n");
}

// ---------------------------------------------------------------- identities

type Who = { name: string; headers: Record<string, string>; authed: boolean };
function identities(s: Seed): Who[] {
  return [
    { name: "1 no auth", headers: {}, authed: false },
    { name: "2 garbage", headers: { cookie: "__Host-cairn_session=garbage0000", authorization: "Bearer garbage0000" }, authed: false },
    { name: "3 B session", headers: { cookie: s.b.cookie }, authed: true },
    { name: "4 B PAT", headers: { authorization: `Bearer ${s.bPat}` }, authed: false },
    { name: "5 B OAuth", headers: { authorization: `Bearer ${s.bOauth.accessToken}` }, authed: false },
    { name: "6 A revoked PAT", headers: { authorization: `Bearer ${s.revokedPat}` }, authed: false },
    { name: "7 A read-only grant", headers: { authorization: `Bearer ${s.aRead.accessToken}` }, authed: false },
  ];
}

// ---------------------------------------------------------------- cases

/**
 * Every route createApp() registers. public: answers anonymous callers (only canary-checked);
 * otherwise anonymous callers must get 3xx/401/403/404/405. A route missing here fails the suite.
 */
const ROUTES: Record<string, { public?: true; note?: string }> = {
  "GET /setup.md": { public: true },
  "GET /skills/:name/SKILL.md": { public: true },
  "GET /skills/:file": { public: true },
  "GET /health": { public: true },
  "POST /auth/signup/options": { public: true, note: "creates a challenge; username availability is a documented oracle" },
  "POST /auth/signup/verify": { public: true },
  "POST /auth/login/options": { public: true },
  "POST /auth/login/verify": { public: true },
  "POST /auth/passkey/options": {},
  "POST /auth/passkey/verify": {},
  "POST /auth/reauth/options": {},
  "POST /auth/reauth/verify": {},
  "POST /auth/recover": { public: true },
  "POST /auth/logout": { public: true },
  "GET /signup": { public: true, note: "a valid invite shows its inviter's username (by design)" },
  "GET /login": { public: true },
  "GET /recover": { public: true },
  "POST /recover": { public: true },
  "GET /": { public: true },
  "GET /connect": { public: true },
  "GET /app": {},
  "POST /app/projects": {},
  "GET /app/activity": {},
  "GET /app/activity/revert": {},
  "POST /app/activity/revert": {},
  "GET /app/v/:vault/n/:rest{.+/history}": {},
  "POST /app/v/:vault/revert": {},
  "POST /app/v/:vault/pin": {},
  "GET /app/settings/memory": {},
  "POST /app/settings/memory": {},
  "GET /app/v/:vault": {},
  "GET /app/v/:vault/f/*": {},
  "GET /app/v/:vault/raw/*": {},
  "GET /app/v/:vault/n/*": {},
  "GET /app/api/search": {},
  "GET /app/search": {},
  "GET /app/api/titles": {},
  "GET /app/api/graph": {},
  "GET /app/graph": {},
  "GET /app/new": {},
  "GET /app/v/:vault/edit/*": {},
  "POST /app/api/notes": {},
  "POST /app/api/notes/delete": {},
  "POST /app/editor/save": {},
  "POST /app/editor/delete": {},
  "GET /app/dev-login": { note: "env-gated (DEV_LOGIN); 404 with production config" },
  "GET /app/files/:project/:id": {},
  "POST /app/api/files": {},
  "POST /app/api/files/delete": {},
  "POST /app/files/delete": {},
  "GET /app/files": {},
  "GET /app/settings/capture": {},
  "POST /app/settings/capture/key": {},
  "POST /app/settings/capture/allow": {},
  "GET /app/clip": {},
  "POST /app/clip": {},
  "GET /export": {},
  "GET /export/:vault": {},
  "GET /app/settings": {},
  "POST /app/settings/tokens": {},
  "POST /app/settings/tokens/delete": {},
  "POST /app/settings/admin": {},
  "GET /app/settings/apps": {},
  "POST /app/settings/apps/revoke": {},
  "GET /authorize": {},
  "POST /authorize": {},
  "GET /app/settings/invites": {},
  "POST /app/settings/invites": {},
  "POST /app/settings/invites/revoke": {},
  "GET /app/admin": {},
  "GET /app/admin/health": {},
  "POST /app/admin/users/disable": {},
  "POST /app/admin/users/enable": {},
  "GET /app/stats": {},
  "GET /app/reauth": {},
  "GET /app/settings/account": {},
  "POST /app/settings/passkeys/rename": {},
  "POST /app/settings/passkeys/delete": {},
  "POST /app/settings/recovery": {},
  "GET /app/settings/delete": {},
  "POST /app/settings/delete": {},
  "GET /app/settings/import": {},
  "POST /app/settings/import": {},
  "GET /app/settings/import/permalinks": {},
  "POST /app/settings/import/permalinks": {},
  "POST /app/api/import": {},
  "GET /app/api/import/:job": {},
  "GET /app/wrapped": {},
  "GET /app/wrapped/card.svg": {},
  "POST /app/settings/serious": {},
};

/** Endpoints the OAuth provider serves itself (outside the Hono app). */
const PROVIDER_ENDPOINTS = ["/oauth/token", "/oauth/register", "/mcp", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"];

/**
 * Every MCP tool. write "always": every call writes, so A's read-only grant must be refused;
 * "some": only some commands write (create, infer-and-save...), so the read-only grant is checked
 * by A's state alone; "never": read tools (A's own grant may read A's data).
 */
const TOOLS: Record<string, { write: "always" | "some" | "never" }> = {
  write_note: { write: "always" },
  read_note: { write: "never" },
  edit_note: { write: "always" },
  delete_note: { write: "always" },
  move_note: { write: "always" },
  search_notes: { write: "never" },
  list_notes: { write: "never" },
  find_notes: { write: "never" },
  build_context: { write: "never" },
  projects: { write: "some" },
  recent_activity: { write: "never" },
  core_memory: { write: "some" },
  supersede: { write: "always" },
  check_schema: { write: "some" },
  help: { write: "never" },
  attach_file: { write: "always" },
};

/** A tool's case; a bm_* alias uses its Cairn tool's. */
const toolCase = (name: string) => TOOLS[name] ?? TOOLS[BM_NAMES[name] ?? ""];

// ---------------------------------------------------------------- checks

/**
 * Names B has itself sent (A's project name, and the title words inside A's permalinks) can end up
 * in B's own data: B may create a project or note with that name, which is B's, not a leak. Once B
 * has sent one, it is no longer counted for B. Every other canary (bodies, observations, file
 * bytes, tokens, ids, A's username) stays strict for the whole run.
 */
/**
 * Canaries that sit on the same lines as the ones requests carry (A's searched body text, A's
 * observation) but are never sent in any request. A request's own values may be echoed back (a
 * search page repeats its query), so a canary the request carried is not counted for that request;
 * these sealed ones close that gap: a result row or excerpt that leaks the line leaks them too, and
 * they can never be an echo.
 */
const SEALED = ["mainsealed", "obssealed", "projsealed", "projobssealed"];

const taintedByB = new Set<string>();
function taintable(s: Seed): string[] {
  return [s.projName, c("maintitle"), c("projtitle"), c("pintitle")];
}
function noteSentByB(s: Seed, request: string) {
  for (const x of taintable(s)) if (request.includes(x)) taintedByB.add(x);
}
function leaks(s: Seed, res: Sent, request: string, allow: string[] = [], byB = false): string[] {
  const sealed = SEALED.map(c);
  if (sealed.some((x) => request.includes(x))) throw new Error("test bug: a request carried a sealed canary");
  const seen = `${res.text}\n${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  return s.canaries.filter((x) => seen.includes(x) && !request.includes(x) && !allow.includes(x) && !(byB && taintedByB.has(x)));
}

const UNAUTH_OK = new Set([301, 302, 303, 307, 401, 403, 404, 405]);

function fillPath(path: string, s: Seed): string {
  return path
    .replace(/:rest\{[^}]*\}/, `${s.secretPermalink}/history`)
    .replace(/:(\w+)(\{[^}]*\})?/g, (_m, name: string) => {
      const v: Record<string, string> = { vault: s.projName, project: s.projName, id: s.ids.att, job: s.ids.job, name: "cairn-notes", file: "index.json" };
      if (!(name in v)) throw new Error(`no value for route param :${name} in ${path}`);
      return encodeURIComponent(v[name]);
    })
    .replace("*", s.secretPermalink);
}

function query(s: Seed): string {
  return new URLSearchParams({
    v: s.projName,
    project: s.projName,
    q: c("projbody"),
    job: s.ids.job,
    folder: "deep",
    rev: "1",
    title: s.secretPermalink,
    url: "https://example.com/",
    next: "/app",
    invite: s.invite.code,
    u: s.a.user.username,
    scope: "everyone",
  }).toString();
}

function bodyFields(s: Seed, id: string): Record<string, string> {
  return {
    vault: s.projName,
    project: s.projName,
    v: s.projName,
    name: s.projName,
    title: s.secretPermalink,
    identifier: s.secretPermalink,
    permalink: s.secretPermalink,
    path: s.secretPermalink,
    note: s.secretPermalink,
    folder: "deep",
    rev: "1",
    revision: "1",
    checksum: "x",
    expected_checksum: "x",
    content: "pwned",
    id,
    grant: s.ids.grantWrite,
    job: s.ids.job,
    user: s.a.user.id,
    user_id: s.a.user.id,
    username: s.a.user.username,
    code: s.invite.code,
    invite: s.invite.code,
    handle: "x",
    decision: "approve",
    scope: "memory:read",
    url: "https://example.com/",
    text: "pwned",
    action: "save",
    sender: "x@example.com",
    allow: "x@example.com",
    key: s.inboxKey,
    attach: "1",
    pinned: "1",
    secret: "x",
    confirm: s.a.user.username,
  };
}

// ---------------------------------------------------------------- control/attack pairs

/** What one owner's resources look like to a route-specific request. */
/** rev: the note's latest revision id (revert undoes it). mine: B owns a project of this name. */
type Target = {
  vault: string;
  permalink: string;
  checksum: string;
  rev: number;
  att: string;
  pat: string;
  grant: string;
  invite: string;
  job: string;
  bOwnsVaultName: boolean;
};
type Built = { url: string; init: RequestInit };
type Control = {
  key: string;
  build: (t: Target, cookie: string) => Built | Promise<Built>;
  /** For B's control on B's own target: null when the request did what it should, else what went wrong. */
  effect: (res: Sent, t: Target) => Promise<string | null>;
};

const form = (cookie: string, fields: Record<string, string>): RequestInit => {
  const body = new URLSearchParams(fields);
  return { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body };
};
const jsonPost = (cookie: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { cookie, origin: BASE, "content-type": "application/json" },
  body: JSON.stringify(body),
});
/** A valid multipart import upload with an explicit Content-Length (the handler requires one). */
async function importUpload(cookie: string, project: string): Promise<RequestInit> {
  const zip = zipSync({ "imported/Control note.md": strToU8("---\ntitle: Control note\n---\ncontrol import body\n") });
  const fd = new FormData();
  fd.set("project", project);
  fd.set("file", new File([zip as Uint8Array<ArrayBuffer>], "export.zip", { type: "application/zip" }));
  const r = new Response(fd);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": r.headers.get("content-type") ?? "", "content-length": String(bytes.byteLength) },
    body: bytes,
  };
}

function controls(s: Seed): Control[] {
  const bNote = async (t: Target) => {
    const v = await defaultVault(s.b.user.id);
    return v.stub.readNote(v.ref, { identifier: t.permalink });
  };
  const status = (res: Sent, ...ok: number[]) => (ok.includes(res.status) ? null : `status ${res.status}: ${res.text.slice(0, 160)}`);
  return [
    {
      key: "GET /app/v/:vault/n/*",
      build: (t, cookie) => ({ url: `/app/v/${encodeURIComponent(t.vault)}/n/${t.permalink}`, init: { headers: { cookie } } }),
      effect: async (res) => status(res, 200) ?? (res.text.includes("control body") ? null : "B's note body not shown"),
    },
    {
      key: "GET /app/v/:vault/raw/*",
      build: (t, cookie) => ({ url: `/app/v/${encodeURIComponent(t.vault)}/raw/${t.permalink}`, init: { headers: { cookie } } }),
      effect: async (res) => status(res, 200) ?? (res.text.includes("control body") ? null : "raw body missing"),
    },
    {
      key: "GET /app/v/:vault/edit/*",
      build: (t, cookie) => ({ url: `/app/v/${encodeURIComponent(t.vault)}/edit/${t.permalink}`, init: { headers: { cookie } } }),
      effect: async (res) => status(res, 200) ?? (res.text.includes("control body") ? null : "editor without the body"),
    },
    {
      key: "GET /app/v/:vault/n/:rest{.+/history}",
      build: (t, cookie) => ({ url: `/app/v/${encodeURIComponent(t.vault)}/n/${t.permalink}/history`, init: { headers: { cookie } } }),
      effect: async (res) => status(res, 200),
    },
    {
      key: "GET /export/:vault",
      build: (t, cookie) => ({ url: `/export/${encodeURIComponent(t.vault)}`, init: { headers: { cookie } } }),
      effect: async (res) => status(res, 200),
    },
    {
      key: "GET /app/files/:project/:id",
      build: (t, cookie) => ({ url: `/app/files/${encodeURIComponent(t.vault)}/${t.att}`, init: { headers: { cookie } } }),
      effect: async (res) => status(res, 200) ?? (res.text.includes("control file") ? null : "file bytes differ"),
    },
    {
      key: "POST /app/api/notes",
      build: (t, cookie) => ({
        url: "/app/api/notes",
        init: jsonPost(cookie, { project: t.vault, permalink: t.permalink, title: "Control", content: "control body edited", expected_checksum: t.checksum }),
      }),
      effect: async (res, t) => status(res, 200) ?? ((await bNote(t)).ok ? null : "note gone"),
    },
    {
      key: "POST /app/editor/save",
      build: (t, cookie) => ({
        url: "/app/editor/save",
        init: form(cookie, {
          project: t.vault,
          permalink: t.permalink,
          title: "Control",
          folder: "",
          content: "control body saved",
          expected_checksum: t.checksum,
        }),
      }),
      effect: async (res, t) => {
        const n = await bNote(t);
        return status(res, 303) ?? (n.ok && n.value.content?.includes("control body saved") ? null : "save had no effect");
      },
    },
    {
      key: "POST /app/v/:vault/pin",
      build: (t, cookie) => ({ url: `/app/v/${encodeURIComponent(t.vault)}/pin`, init: form(cookie, { permalink: t.permalink, pin: "1" }) }),
      effect: async (res, t) => {
        const n = await bNote(t);
        return status(res, 303) ?? (n.ok && n.value.note.pinned ? null : "not pinned");
      },
    },
    {
      key: "POST /app/v/:vault/revert",
      build: (t, cookie) => ({
        url: `/app/v/${encodeURIComponent(t.vault)}/revert`,
        init: form(cookie, { permalink: t.permalink, rev: String(t.rev), checksum: t.checksum }),
      }),
      effect: async (res, t) => {
        const n = await bNote(t);
        return status(res, 303) ?? (n.ok && n.value.content?.includes("first version") ? null : "revert had no effect");
      },
    },
    {
      key: "POST /app/api/notes/delete",
      build: (t, cookie) => ({
        url: "/app/api/notes/delete",
        init: jsonPost(cookie, { project: t.vault, permalink: t.permalink, expected_checksum: t.checksum }),
      }),
      effect: async (res, t) => status(res, 200) ?? ((await bNote(t)).ok ? "note still there" : null),
    },
    {
      key: "POST /app/editor/delete",
      build: (t, cookie) => ({ url: "/app/editor/delete", init: form(cookie, { project: t.vault, permalink: t.permalink, expected_checksum: t.checksum }) }),
      effect: async (res, t) => status(res, 303) ?? ((await bNote(t)).ok ? "note still there" : null),
    },
    {
      key: "POST /app/api/files/delete",
      build: (t, cookie) => ({ url: "/app/api/files/delete", init: jsonPost(cookie, { project: t.vault, id: t.att }) }),
      effect: async (res, t) => {
        const row = await env.DB.prepare("SELECT state FROM attachments WHERE id = ?").bind(t.att).first<{ state: string }>();
        return status(res, 200) ?? (row && row.state === "ready" ? "attachment still ready" : null);
      },
    },
    {
      key: "POST /app/files/delete",
      build: (t, cookie) => ({ url: "/app/files/delete", init: form(cookie, { project: t.vault, id: t.att }) }),
      effect: async (res, t) => {
        const row = await env.DB.prepare("SELECT state FROM attachments WHERE id = ?").bind(t.att).first<{ state: string }>();
        return status(res, 303) ?? (row && row.state === "ready" ? "attachment still ready" : null);
      },
    },
    {
      key: "POST /app/settings/tokens/delete",
      build: (t, cookie) => ({ url: "/app/settings/tokens/delete", init: form(cookie, { id: t.pat }) }),
      effect: async (res, t) => {
        const left = (await listPats(env, s.b.user.id)).some((p) => p.id === t.pat);
        return status(res, 303) ?? (left ? "token not deleted" : null);
      },
    },
    {
      key: "POST /app/settings/apps/revoke",
      build: (t, cookie) => ({ url: "/app/settings/apps/revoke", init: form(cookie, { grant: t.grant }) }),
      effect: async (res, t) => {
        const left = (await env.OAUTH_KV.list({ prefix: `grant:${s.b.user.id}:${t.grant}` })).keys.length;
        return status(res, 303) ?? (left ? "grant not revoked" : null);
      },
    },
    {
      key: "POST /app/settings/invites/revoke",
      build: (t, cookie) => ({ url: "/app/settings/invites/revoke", init: form(cookie, { id: t.invite }) }),
      effect: async (res, t) => {
        const row = await env.DB.prepare("SELECT revoked_at FROM invites WHERE id = ?").bind(t.invite).first<{ revoked_at: string | null }>();
        return status(res, 303) ?? (!row || row.revoked_at ? null : "invite not revoked"); // revoked rows may be pruned
      },
    },
    {
      key: "POST /app/api/import",
      build: async (t, cookie) => ({ url: "/app/api/import", init: await importUpload(cookie, t.vault) }),
      effect: async (res) => status(res, 200, 202) ?? (/"job":"[^"]+"/.test(res.text) ? null : "no job returned"),
    },
    {
      key: "GET /app/api/import/:job",
      build: (t, cookie) => ({ url: `/app/api/import/${t.job}?project=${encodeURIComponent(t.vault)}`, init: { headers: { cookie } } }),
      effect: async (res) => status(res, 200),
    },
  ];
}

/** Fresh resources of B's to aim a control at (some controls consume theirs). */
async function bTarget(s: Seed, cookie: string): Promise<Target> {
  const v = await defaultVault(s.b.user.id);
  const title = `Control ${crypto.randomUUID().slice(0, 8)}`;
  const w1 = await v.stub.writeNote(v.ref, caller(s.b.user), { title, content: "first version" });
  if (!w1.ok) throw new Error(w1.message);
  const w2 = await v.stub.writeNote(v.ref, caller(s.b.user), { identifier: w1.value.note.permalink, title, overwrite: true, content: "control body" });
  if (!w2.ok) throw new Error(w2.message);
  const att = await putAttachment(env, v.vault as Vault, { bytes: enc(`control file ${title}`), name: "control.txt", source: "upload" });
  if (!att.ok) throw new Error(att.message);
  await createPat(env, s.b.user.id, `control ${title}`, ["memory:read"], null);
  const pat = (await listPats(env, s.b.user.id)).find((p) => p.name === `control ${title}`)?.id ?? "";
  // B's invite quota: retire the earlier controls' invites first.
  await env.DB.prepare("UPDATE invites SET revoked_at = ?, code = NULL WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL")
    .bind(new Date().toISOString(), s.b.user.id)
    .run();
  const invite = await createInvite(env, s.b.user, { note: "control" });
  if (!invite.ok) throw new Error(invite.message);
  await getAccessToken(cookie, "memory:read");
  const grants = (await env.OAUTH_KV.list({ prefix: `grant:${s.b.user.id}:` })).keys.map((k) => k.name.split(":")[2]);
  // B's import admission (2 in progress): earlier controls' jobs may still be running on a slow
  // machine, so close them out first, as for invites above.
  await env.DB.prepare("UPDATE import_jobs SET status = 'failed', finished_at = ? WHERE user_id = ? AND status IN ('staging', 'running')")
    .bind(new Date().toISOString(), s.b.user.id)
    .run();
  await env.DB.prepare("DELETE FROM import_daily WHERE user_id = ?").bind(s.b.user.id).run();
  const imp = await send("/app/api/import", await importUpload(cookie, v.vault.name));
  const job = /"job":"([^"]+)"/.exec(imp.text)?.[1] ?? "";
  const revs = await v.stub.revisions(v.ref, w2.value.note.permalink);
  return {
    vault: v.vault.name,
    bOwnsVaultName: true,
    rev: revs[0]?.id ?? 0,
    permalink: w2.value.note.permalink,
    checksum: w2.value.note.checksum,
    att: att.attachment.id,
    pat,
    grant: grants.at(-1) ?? "",
    invite: invite.id,
    job,
  };
}

/** A's resources, addressed both through A's second project and A's main (B owns a "main" too). */
async function aTargets(s: Seed): Promise<Target[]> {
  const read = async (v: { stub: ReturnType<typeof env.VAULT.getByName>; ref: { id: string; name: string; ownerId: string } }, permalink: string) => {
    const r = await v.stub.readNote(v.ref, { identifier: permalink });
    if (!r.ok) throw new Error(`A's note ${permalink} unreadable`);
    return { checksum: r.value.note.checksum, rev: (await v.stub.revisions(v.ref, permalink))[0]?.id ?? 0 };
  };
  const common = { att: s.ids.att, pat: s.ids.pat, grant: s.ids.grantWrite, invite: s.ids.invite, job: s.ids.job };
  return [
    { vault: s.projName, bOwnsVaultName: false, permalink: s.secretPermalink, ...(await read(s.proj, s.secretPermalink)), ...common },
    // B has its own "main": these requests reach B's project and must not touch A's.
    { vault: "main", bOwnsVaultName: true, permalink: s.mainPermalink, ...(await read(s.am, s.mainPermalink)), ...common },
  ];
}

async function runControls(s: Seed, freshB: () => Promise<string>, failures: string[], checkState: (label: string) => Promise<void>) {
  const list = controls(s);
  const unknown = list.map((x) => x.key).filter((k) => !(k in ROUTES));
  if (unknown.length) failures.push(`controls for unregistered routes: ${unknown.join(", ")}`);
  const targets = await aTargets(s);
  for (const ctl of list) {
    const cookie = await freshB();
    // Control: B's own resource, well formed -> must succeed and take effect.
    const mine = await bTarget(s, cookie);
    const b = await ctl.build(mine, cookie);
    const res = await send(b.url, b.init);
    const problem = await ctl.effect(res, mine);
    if (problem) failures.push(`control ${ctl.key} on B's own data did not reach its handler: ${problem}`);
    // Attack: the same well-formed request at A's resource (with A's real checksum).
    for (const t of targets) {
      const atk = await ctl.build(t, await freshB());
      const reqText = `${atk.url} ${typeof atk.init.body === "string" ? atk.init.body : String(atk.init.body ?? "")}`;
      noteSentByB(s, reqText);
      const r = await send(atk.url, atk.init);
      const leaked = leaks(s, r, reqText, [], true);
      if (leaked.length) failures.push(`attack ${ctl.key} on A's ${t.vault}: leaked ${leaked.join(", ")}`);
      if (r.status >= 500) failures.push(`attack ${ctl.key} on A's ${t.vault}: server error ${r.status}`);
      // A read of a project name B doesn't have must not succeed (for "main", B reads its own).
      if (r.status >= 200 && r.status < 300 && ctl.key.startsWith("GET") && !t.bOwnsVaultName)
        failures.push(`attack ${ctl.key} on A's ${t.vault}: answered ${r.status}`);
      await checkState(`attack ${ctl.key} on A's ${t.vault}`);
    }
  }
}

// ---------------------------------------------------------------- the suite

describe("exhaustive isolation", () => {
  it("covers every route, provider endpoint and MCP tool without leaking or changing A's data", { timeout: 600_000 }, async () => {
    // Production config never enables dev-login (it would let anyone sign in as anyone).
    const topLevel = wranglerConfig.split(/"env"\s*:/)[0];
    expect(topLevel).not.toMatch(/"DEV_LOGIN"\s*:\s*"1"/);

    const s = await seed();
    const failures: string[] = [];
    let before = await snapshot(s);
    // B may create its own project under A's project name (that's allowed); drop it after every
    // step so A's name keeps pointing at A's project for the rest of the run.
    const dropBCopies = () => env.DB.prepare("DELETE FROM vaults WHERE owner_id = ? AND name = ?").bind(s.b.user.id, s.projName).run();
    const checkState = async (label: string) => {
      await dropBCopies();
      const now = await snapshot(s);
      if (now !== before) {
        const a = before.split("\n");
        const b = now.split("\n");
        const gone = a.filter((l) => !b.includes(l)).slice(0, 3);
        const added = b.filter((l) => !a.includes(l)).slice(0, 3);
        failures.push(`${label}: A's data changed: was ${gone.join(" | ").slice(0, 500)} now ${added.join(" | ").slice(0, 500)}`);
        before = now; // report each change once, at the step that made it
      }
    };
    const who = identities(s);

    // ---- every Hono route
    const registered = [
      ...new Set(
        createApp()
          .routes.filter((r) => r.method !== "ALL")
          .map((r) => `${r.method} ${r.path}`),
      ),
    ];
    expect(
      registered.filter((k) => !(k in ROUTES)),
      "routes without an isolation case",
    ).toEqual([]);
    expect(
      Object.keys(ROUTES).filter((k) => !registered.includes(k)),
      "stale isolation cases",
    ).toEqual([]);

    const idVariants = Object.values(s.ids);
    // Routes run as B can end B's own session (logout) or credentials; every route starts with a
    // fresh, freshly re-authenticated B session so no later route silently runs as anonymous.
    const freshB = async () => {
      const token = await createSession(env, s.b.user.id);
      await env.DB.prepare("UPDATE sessions SET reauth_at = ? WHERE user_id = ?").bind(new Date().toISOString(), s.b.user.id).run();
      return `__Host-cairn_session=${token}`;
    };
    for (const key of registered) {
      const [method, pattern] = key.split(" ");
      const path = fillPath(pattern, s);
      const isPublic = !!ROUTES[key].public;
      const bCookie = await freshB();
      for (const w0 of who) {
        const w = w0.authed ? { ...w0, headers: { cookie: bCookie } } : w0;
        const reqs: { url: string; init: RequestInit; reqText: string }[] = [];
        const ip = { "cf-connecting-ip": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
        if (method === "GET") {
          const url = `${path}?${query(s)}`;
          reqs.push({ url, init: { headers: { ...w.headers, ...ip } }, reqText: url });
        } else {
          // Only B's session gets past authentication, so only it is tried with every one of A's ids
          // and both body encodings; the others are refused before the body is read.
          for (const id of w.authed ? idVariants : [s.ids.att]) {
            const fields = bodyFields(s, id);
            const reqText = `${path} ${JSON.stringify(fields)}`;
            reqs.push({
              url: path,
              init: { method, headers: { ...w.headers, ...ip, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(fields) },
              reqText,
            });
            if (w.authed || pattern.startsWith("/app")) {
              const fd = new FormData();
              for (const [k, v] of Object.entries(fields)) fd.set(k, v);
              fd.set("file", new File([enc("pwned file")], "pwned.txt", { type: "text/plain" }));
              reqs.push({ url: path, init: { method, headers: { ...w.headers, ...ip, origin: BASE }, body: fd }, reqText });
            }
          }
        }
        const byB = w.name.includes(" B ");
        for (const r of reqs) {
          if (byB) noteSentByB(s, r.reqText);
          const res = await send(r.url, r.init);
          const label = `${key} as ${w.name} (${res.status})`;
          const allow = key === "GET /signup" ? [s.a.user.username] : [];
          const leaked = leaks(s, res, r.reqText, allow, byB);
          if (leaked.length) failures.push(`${label}: leaked ${leaked.join(", ")}`);
          if (res.status >= 500) failures.push(`${label}: server error ${res.text.slice(0, 200)}`);
          if (!w.authed && !isPublic && !UNAUTH_OK.has(res.status)) failures.push(`${label}: anonymous caller got ${res.status}`);
          // Coverage guard: B's session must actually be accepted (else the route ran as anonymous).
          if (w.authed && key !== "POST /auth/logout" && (res.headers.get("location") ?? "").startsWith("/login"))
            failures.push(`${label}: B's session was not accepted, so this route wasn't tested as B`);
          if (key === "GET /app/dev-login" && res.status !== 404) failures.push(`${label}: dev-login answered with production config`);
        }
      }
      await checkState(key);
    }

    // ---- control/attack pairs: well-formed requests for the sensitive handlers
    await runControls(s, freshB, failures, checkState);

    // ---- OAuth provider endpoints (outside the Hono app)
    const opts = providerOptions(quietEnv);
    for (const k of Object.keys(opts).filter((k) => /Endpoint$|Route$/.test(k))) {
      const v = (opts as unknown as Record<string, string>)[k];
      expect(v === "/authorize" || PROVIDER_ENDPOINTS.includes(v), `provider endpoint ${k}=${v} has a case`).toBe(true);
    }
    const tokenTries: Record<string, string>[] = [
      { grant_type: "refresh_token", refresh_token: s.aWrite.refreshToken ?? "x", client_id: s.bOauth.clientId },
      { grant_type: "refresh_token", refresh_token: s.aRead.refreshToken ?? "x", client_id: s.bOauth.clientId },
      { grant_type: "authorization_code", code: "garbage", client_id: s.aWrite.clientId, redirect_uri: "http://127.0.0.1:9999/callback", code_verifier: "x" },
      { grant_type: "client_credentials", client_id: s.aWrite.clientId },
    ];
    for (const t of tokenTries) {
      const reqText = JSON.stringify(t);
      const res = await send("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(t),
      });
      if (res.status < 400 || /access_token/.test(res.text)) failures.push(`/oauth/token ${t.grant_type} as B/anon issued a token (${res.status})`);
      const leaked = leaks(s, res, reqText);
      if (leaked.length) failures.push(`/oauth/token: leaked ${leaked.join(", ")}`);
    }
    {
      const res = await send("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris: ["http://127.0.0.1:1/cb"], token_endpoint_auth_method: "none" }),
      });
      const leaked = leaks(s, res, "");
      if (leaked.length) failures.push(`/oauth/register: leaked ${leaked.join(", ")}`);
    }
    for (const p of PROVIDER_ENDPOINTS.filter((p) => p.startsWith("/.well-known"))) {
      const res = await send(p);
      const leaked = leaks(s, res, p);
      if (leaked.length) failures.push(`${p}: leaked ${leaked.join(", ")}`);
    }
    for (const w of who.filter((x) => ["1 no auth", "2 garbage", "6 A revoked PAT"].includes(x.name))) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const res = await send("/mcp", {
          method,
          headers: { ...w.headers, host: "localhost:8787", "content-type": "application/json", accept: "application/json, text/event-stream" },
          ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) } : {}),
        });
        if (res.status !== 401) failures.push(`/mcp ${method} as ${w.name}: ${res.status}, expected 401`);
        const leaked = leaks(s, res, "");
        if (leaked.length) failures.push(`/mcp ${method} as ${w.name}: leaked ${leaked.join(", ")}`);
      }
    }
    await checkState("provider endpoints");

    // ---- every MCP tool and prompt
    let rpc = 0;
    const call = async (token: string, method: string, params: unknown) => {
      const res = await send("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          host: "localhost:8787",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }),
      });
      return res;
    };
    // Fresh B credentials (web routes run as B may have revoked B's own tokens).
    s.bPat = await createPat(env, s.b.user.id, "bob pat 2", ["memory:read", "memory:write"], null);
    s.bOauth = await getAccessToken(await freshB());
    const listed = await call(s.bPat, "tools/list", {});
    const data = JSON.parse(
      listed.text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5))
        .pop() ?? listed.text,
    ) as {
      result: {
        tools: {
          name: string;
          inputSchema: { properties?: Record<string, { type?: string; enum?: string[]; items?: { type?: string } }>; required?: string[] };
        }[];
      };
    };
    const tools = data.result.tools;
    // BM_COMPAT is on: every alias is listed and attacked with its Cairn tool's case.
    expect(
      Object.keys(BM_NAMES).filter((a) => !tools.some((t) => t.name === a)),
      "bm_* aliases missing with BM_COMPAT=true",
    ).toEqual([]);
    expect(
      tools.map((t) => t.name).filter((n) => !toolCase(n)),
      "MCP tools without an isolation case",
    ).toEqual([]);
    expect(
      Object.keys(TOOLS).filter((n) => !tools.some((t) => t.name === n)),
      "stale MCP tool cases",
    ).toEqual([]);

    const memUrl = `memory://${s.projName}/${s.secretPermalink}`;
    for (const t of tools) {
      const props = t.inputSchema.properties ?? {};
      const required = t.inputSchema.required ?? [];
      const valueFor = (name: string, p: { type?: string; enum?: string[]; items?: { type?: string } }): unknown => {
        if (p.enum?.length) return p.enum[0];
        const byName: Record<string, unknown> = {
          identifier: s.secretPermalink,
          note: s.secretPermalink,
          query: c("projbody"),
          path: "deep",
          destination: "moved/",
          content: "pwned",
          title: "pwned",
          name: s.projName,
          project: s.projName,
          url: "https://example.com/",
          old: c("projobs"),
          new: "pwned",
          reason: "pwned",
        };
        if (name in byName) return byName[name];
        if (p.type === "number" || p.type === "integer") return 1;
        if (p.type === "boolean") return false;
        if (p.type === "array") return p.items?.type === "string" ? [s.projName] : [];
        if (p.type === "object") return {};
        return "x";
      };
      const base: Record<string, unknown> = {};
      for (const r of required) base[r] = valueFor(r, props[r] ?? {});
      const commands = props.command?.enum ?? props.operation?.enum ?? [undefined];
      const variants: Record<string, unknown>[] = [
        { project: s.projName },
        ...(props.projects ? [{ projects: [s.projName] }] : []),
        ...(props.all_projects ? [{ all_projects: true }] : []),
        ...(props.identifier
          ? [
              { project: s.projName, identifier: s.secretPermalink },
              { identifier: memUrl },
              { identifier: s.mainPermalink },
              { project: "main", identifier: s.mainPermalink },
            ]
          : []),
        ...(props.query ? [{ project: s.projName, query: c("projbody") }, { query: memUrl }, { all_projects: true, query: c("mainbody") }] : []),
        ...(props.path ? [{ project: s.projName, path: "deep" }] : []),
        ...(props.note ? [{ project: s.projName, note: s.secretPermalink }, { note: memUrl }] : []),
        ...(props.name ? [{ name: s.projName }] : []),
      ].filter((v) => Object.keys(v).every((k) => k in props));
      const writers = [
        { name: "4 B PAT", token: s.bPat },
        { name: "5 B OAuth", token: s.bOauth.accessToken },
        ...(toolCase(t.name)?.write !== "never" ? [{ name: "7 A read-only grant", token: s.aRead.accessToken }] : []),
      ];
      for (const command of commands) {
        for (const v of variants) {
          const args = { ...base, ...(command ? { [props.command ? "command" : "operation"]: command } : {}), ...v };
          for (const wtr of writers) {
            const res = await call(wtr.token, "tools/call", { name: t.name, arguments: args });
            const label = `${t.name} ${JSON.stringify(args)} as ${wtr.name} (${res.status})`;
            if (res.status >= 500) failures.push(`${label}: server error`);
            // A's own read-only token may read A's data; it is only checked for writes (state below).
            if (wtr.name !== "7 A read-only grant") {
              noteSentByB(s, JSON.stringify(args));
              const leaked = leaks(s, res, JSON.stringify(args), [], true);
              if (leaked.length) failures.push(`${label}: leaked ${leaked.join(", ")}`);
            } else if (toolCase(t.name)?.write === "always" && !/read-only|memory:write|FORBIDDEN|insufficient/i.test(res.text)) {
              failures.push(`${label}: a write tool did not refuse A's read-only grant: ${res.text.slice(0, 160)}`);
            }
          }
        }
      }
      await checkState(`tool ${t.name}`);
    }

    // prompts and resources, as B
    for (const method of ["prompts/list", "resources/list", "resources/templates/list"]) {
      const res = await call(s.bPat, method, {});
      const leaked = leaks(s, res, "", [], true);
      if (leaked.length) failures.push(`${method} as B: leaked ${leaked.join(", ")}`);
      for (const m of res.text.matchAll(/"name":"([^"]+)"/g)) {
        if (method !== "prompts/list") continue;
        const got = await call(s.bPat, "prompts/get", { name: m[1], arguments: { project: s.projName, identifier: memUrl } });
        const l2 = leaks(s, got, JSON.stringify({ project: s.projName, identifier: memUrl }), [], true);
        if (l2.length) failures.push(`prompts/get ${m[1]} as B: leaked ${l2.join(", ")}`);
      }
    }
    for (const uri of [memUrl, `memory://${s.mainPermalink}`]) {
      const res = await call(s.bPat, "resources/read", { uri });
      const leaked = leaks(s, res, uri, [], true);
      if (leaked.length) failures.push(`resources/read ${uri} as B: leaked ${leaked.join(", ")}`);
    }
    await checkState("prompts and resources");

    // Sanity: the canaries are real (A can see them with A's own credentials), so "no leak" means something.
    const own = await call(s.aPat, "tools/call", { name: "read_note", arguments: { project: s.projName, identifier: s.secretPermalink } });
    if (!own.text.includes(c("projbody"))) failures.push("sanity: A can no longer read A's own note");
    const ownFile = await send(`/app/files/${s.projName}/${s.ids.att}`, { headers: { cookie: s.a.cookie } });
    if (!ownFile.text.includes(c("filebytes"))) failures.push("sanity: A can no longer read A's own file");

    expect(failures).toEqual([]);
  });
});
