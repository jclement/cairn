// Shared projects and guidance, end to end: share links (join, confirm a role raise, sign up
// through a link while sign-up is invite-only, single use, caps), owner deletion, attribution,
// export rules, attachment links across members, project guides and personal guidance.
// The role/isolation matrix over every route and tool is in isolation-exhaustive.test.ts.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deleteAccount } from "../src/account";
import type { WebAuthnVerifier } from "../src/auth/webauthn";
import { putAttachment } from "../src/capture/files";
import {
  createPat,
  createShareLink,
  createVault,
  GUIDE_MAX_BYTES,
  getVault,
  listVaults,
  SHARE_LIMITS,
  setGuidance,
  setVaultGuide,
  type Vault,
} from "../src/directory";
import worker from "../src/index";
import { createApp } from "../src/web/app";
import { renderMarkdown } from "../src/web/render";
import { BASE, makeUser, ORIGIN } from "./helpers";

const fakeVerifier: WebAuthnVerifier = {
  async verifyRegistration({ response }) {
    const r = response as unknown as { id: string; ok?: boolean };
    return r.ok ? { id: r.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"], deviceType: "multiDevice", backedUp: true } : null;
  },
  async verifyAuthentication() {
    return null;
  },
};
const app = createApp({ verifier: fakeVerifier });
const quiet = { ...env, RL_INVITE: undefined, RL_AUTH: undefined, RL_WRITE: undefined } as unknown as typeof env;
const closed = { ...quiet, OPEN_SIGNUP: "false" } as unknown as typeof env;

const form = (cookie: string, fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields),
});
const get = (path: string, cookie = "", e = quiet) => app.request(path, { headers: cookie ? { cookie } : {} }, e);
const postForm = (path: string, cookie: string, fields: Record<string, string>, e = quiet) => app.request(path, form(cookie, fields), e);
const postJson = (path: string, body: unknown, e = quiet) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) }, e);

async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        host: "localhost:8787",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    quiet,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return text;
}

async function project(prefix = "team") {
  const o = await makeUser("own");
  const r = await createVault(env, o.user.id, `${prefix}${Math.floor(Math.random() * 1e6)}`);
  if (!r.ok) throw new Error(r.message);
  const vault = { ...r.vault, role: "owner" as const } as Vault;
  return { o, vault, label: `${o.user.username}/${vault.name}`, pat: await createPat(env, o.user.id, "t", ["memory:read", "memory:write"], null) };
}
async function link(v: Vault, ownerId: string, role: "editor" | "reader", opts: { singleUse?: boolean; days?: number } = {}) {
  const l = await createShareLink(env, v, ownerId, { role, ...opts });
  if (!l.ok) throw new Error(l.message);
  return l;
}

describe("share links", () => {
  it("joins as the link's role, names the project owner/name, and needs a confirm to raise a role", async () => {
    const p = await project();
    const m = await makeUser("mem");
    const rl = await link(p.vault, p.o.user.id, "reader");
    const land = await get(`/share/${rl.code}`, m.cookie);
    expect(land.status).toBe(200);
    expect(await land.text()).toContain(`Join as reader`);
    // Opening the link changes nothing; accepting does.
    expect(await getVault(env, m.user.id, p.label)).toBeNull();
    expect((await postForm("/share/accept", m.cookie, { code: rl.code })).status).toBe(303);
    const v = await getVault(env, m.user.id, p.label);
    expect(v?.role).toBe("reader");
    expect(v?.name).toBe(p.label);
    expect((await listVaults(env, m.user.id)).map((x) => x.name)).toContain(p.label);
    // The owner addresses it either way, and sees the plain name.
    expect((await getVault(env, p.o.user.id, p.label))?.name).toBe(p.vault.name);
    // An editor link shows the change and asks; the role moves only on the POST.
    const el = await link(p.vault, p.o.user.id, "editor");
    const up = await (await get(`/share/${el.code}`, m.cookie)).text();
    expect(up).toContain("Become an editor");
    expect((await getVault(env, m.user.id, p.label))?.role).toBe("reader");
    await postForm("/share/accept", m.cookie, { code: el.code });
    expect((await getVault(env, m.user.id, p.label))?.role).toBe("editor");
    // A reader link never lowers it.
    await postForm("/share/accept", m.cookie, { code: rl.code });
    expect((await getVault(env, m.user.id, p.label))?.role).toBe("editor");
    // The owner's own link: nothing to join.
    expect(await (await get(`/share/${rl.code}`, p.o.cookie)).text()).toContain("You own");
  });

  it("single-use links work once, expiry is capped at 30 days, and the open-link cap holds", async () => {
    const p = await project();
    const a = await makeUser("a");
    const b = await makeUser("b");
    const one = await link(p.vault, p.o.user.id, "reader", { singleUse: true });
    expect((await postForm("/share/accept", a.cookie, { code: one.code })).status).toBe(303);
    expect((await postForm("/share/accept", b.cookie, { code: one.code })).status).toBe(404);
    expect(await getVault(env, b.user.id, p.label)).toBeNull();
    const long = await link(p.vault, p.o.user.id, "reader", { days: 365 });
    expect(Date.parse(long.expires_at) - Date.now()).toBeLessThanOrEqual(SHARE_LIMITS.maxDays * 86400e3 + 5000);
    const p2 = await project();
    for (let i = 0; i < SHARE_LIMITS.openLinksPerVault; i++) await link(p2.vault, p2.o.user.id, "reader");
    expect((await createShareLink(env, p2.vault, p2.o.user.id, { role: "reader" })).ok).toBe(false);
    // Only the owner makes links.
    expect((await createShareLink(env, p2.vault, a.user.id, { role: "reader" })).ok).toBe(false);
  });

  it("signs up through a link while sign-up is invite-only, joining the project in the same step", async () => {
    const p = await project();
    const l = await link(p.vault, p.o.user.id, "editor");
    const name = `viashare${Math.floor(Math.random() * 1e6)}`;
    // No link: refused.
    expect((await postJson("/auth/signup/options", { username: name }, closed)).status).toBe(403);
    const o = await postJson("/auth/signup/options", { username: name, share: l.code }, closed);
    expect(o.status).toBe(200);
    const { challengeId } = (await o.json()) as { challengeId: string };
    const v = await postJson("/auth/signup/verify", { challengeId, response: { id: `cred-${name}`, ok: true } }, closed);
    expect(v.status).toBe(200);
    const u = await env.DB.prepare("SELECT id, invited_by FROM users WHERE username = ?").bind(name).first<{ id: string; invited_by: string }>();
    expect(u?.invited_by).toBe(p.o.user.id);
    expect((await getVault(env, u?.id as string, p.label))?.role).toBe("editor");
    // A revoked link is no invite.
    await env.DB.prepare("UPDATE share_links SET revoked_at = ? WHERE vault_id = ?").bind(new Date().toISOString(), p.vault.id).run();
    expect((await postJson("/auth/signup/options", { username: `${name}x`, share: l.code }, closed)).status).toBe(403);
  });
});

describe("shared project lifecycle", () => {
  it("attributes writes, follows the export rules, opens attachments for members, and ends with the owner", async () => {
    const p = await project();
    const ed = await makeUser("ed");
    const rd = await makeUser("rd");
    await postForm("/share/accept", ed.cookie, { code: (await link(p.vault, p.o.user.id, "editor")).code });
    await postForm("/share/accept", rd.cookie, { code: (await link(p.vault, p.o.user.id, "reader")).code });
    const edPat = await createPat(env, ed.user.id, "t", ["memory:read", "memory:write"], null);
    const rdPat = await createPat(env, rd.user.id, "t", ["memory:read", "memory:write"], null);
    expect(await mcp(edPat, "write_note", { project: p.label, title: "Plan", content: "the plan" })).toContain(`saved ${p.label}/plan`);
    expect(await mcp(rdPat, "write_note", { project: p.label, title: "Nope", content: "x" })).toContain("FORBIDDEN");
    // History shows the editor's name to the owner.
    const hist = await (await get(`/app/v/${encodeURIComponent(p.vault.name)}/n/plan/history`, p.o.cookie)).text();
    expect(hist).toContain(ed.user.username);
    // Export: owner and editor may download the project; the reader may not; "everything" is owned only.
    await env.DB.prepare("UPDATE sessions SET reauth_at = ?").bind(new Date().toISOString()).run();
    expect((await get(`/export/${encodeURIComponent(p.label)}`, ed.cookie)).status).toBe(200);
    expect((await get(`/export/${encodeURIComponent(p.label)}`, rd.cookie)).status).toBe(403);
    // An attachment the owner linked by plain name opens for a member: the page points at owner/name.
    const att = await putAttachment(env, p.vault, { bytes: new TextEncoder().encode("hello"), name: "a.txt", source: "upload" });
    if (!att.ok) throw new Error(att.message);
    const html = renderMarkdown(`[file](${att.url})`, { vault: p.label, links: {} });
    expect(html).toContain(`/app/files/${encodeURIComponent(p.label)}/${att.attachment.id}`);
    expect((await get(`/app/files/${encodeURIComponent(p.label)}/${att.attachment.id}`, rd.cookie)).status).toBe(200);
    // Deleting the owner deletes the project: members lose it.
    const oauth = { listUserGrants: async () => ({ items: [], cursor: undefined }), revokeGrant: async () => {} };
    await deleteAccount(env, oauth as never, p.o.user.id);
    expect(await getVault(env, ed.user.id, p.label)).toBeNull();
    expect(await mcp(edPat, "read_note", { project: p.label, identifier: "plan" })).toContain("NOT_FOUND");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_members WHERE vault_id = ?").bind(p.vault.id).first<{ n: number }>())?.n).toBe(0);
  });

  it("deleting a member's account removes only their membership", async () => {
    const p = await project();
    const m = await makeUser("gone");
    await postForm("/share/accept", m.cookie, { code: (await link(p.vault, p.o.user.id, "editor")).code });
    const oauth = { listUserGrants: async () => ({ items: [], cursor: undefined }), revokeGrant: async () => {} };
    await deleteAccount(env, oauth as never, m.user.id);
    expect(await getVault(env, p.o.user.id, p.vault.name)).not.toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_members WHERE vault_id = ?").bind(p.vault.id).first<{ n: number }>())?.n).toBe(0);
  });
});

describe("guides and personal guidance", () => {
  it("members read the guide, owner and editors edit it, readers can't, and the cap holds", async () => {
    const p = await project();
    const ed = await makeUser("ged");
    const rd = await makeUser("grd");
    await postForm("/share/accept", ed.cookie, { code: (await link(p.vault, p.o.user.id, "editor")).code });
    await postForm("/share/accept", rd.cookie, { code: (await link(p.vault, p.o.user.id, "reader")).code });
    const sharing = `/app/v/${encodeURIComponent(p.label)}/sharing`;
    expect((await postForm(`${sharing}/guide`, ed.cookie, { guide: "Customers and decisions.\n\n- folders: customers/" })).status).toBe(303);
    expect((await postForm(`${sharing}/guide`, rd.cookie, { guide: "reader was here" })).status).toBe(403);
    expect((await getVault(env, rd.user.id, p.label))?.guide).toBe("Customers and decisions.\n\n- folders: customers/");
    expect(await (await get(sharing, rd.cookie)).text()).toContain("Customers and decisions.");
    expect((await setVaultGuide(env, { ...p.vault, role: "owner" }, p.o.user.id, "x".repeat(GUIDE_MAX_BYTES + 1))).ok).toBe(false);
    // Assistants see it: projects (first line), projects guide (all), build_context/recent_activity (top), write receipts (pointer).
    const rdPat = await createPat(env, rd.user.id, "t", ["memory:read", "memory:write"], null);
    const edPat = await createPat(env, ed.user.id, "t", ["memory:read", "memory:write"], null);
    expect(await mcp(rdPat, "projects", { command: "list" })).toContain("guide: Customers and decisions.");
    expect(await mcp(rdPat, "projects", { command: "guide", project: p.label })).toContain("folders: customers/");
    expect(await mcp(rdPat, "recent_activity", { project: p.label })).toContain(`## Guide for ${p.label}`);
    expect(await mcp(edPat, "write_note", { project: p.label, title: "G", content: "g" })).toContain(`guide for ${p.label}: Customers and decisions.`);
  });

  it("personal guidance is the user's alone: in their projects and help, nobody else's", async () => {
    const p = await project();
    const m = await makeUser("pg");
    await postForm("/share/accept", m.cookie, { code: (await link(p.vault, p.o.user.id, "editor")).code });
    const secret = `route customers to ${p.label} zq${Math.floor(Math.random() * 1e9)}`;
    expect((await postForm("/app/settings/guidance", p.o.cookie, { guidance: secret })).status).toBe(303);
    expect((await setGuidance(env, p.o.user.id, "y".repeat(GUIDE_MAX_BYTES + 1))).ok).toBe(false);
    expect(await mcp(p.pat, "projects", { command: "list" })).toContain(secret);
    expect(await mcp(p.pat, "help", {})).toContain(secret);
    const mPat = await createPat(env, m.user.id, "t", ["memory:read", "memory:write"], null);
    for (const [tool, args] of [
      ["projects", { command: "list" }],
      ["projects", { command: "guide", project: p.label }],
      ["help", {}],
      ["recent_activity", { project: p.label }],
    ] as const) {
      expect(await mcp(mPat, tool, args as Record<string, unknown>)).not.toContain(secret);
    }
    for (const path of ["/app/settings/account", `/app/v/${encodeURIComponent(p.label)}/sharing`, `/app/v/${encodeURIComponent(p.label)}`, "/app"]) {
      expect(await (await get(path, m.cookie)).text()).not.toContain(secret);
    }
    expect(await (await get("/app/settings/account", p.o.cookie)).text()).toContain(secret);
  });

  it("a new project can start from a guide template", async () => {
    const u = await makeUser("tpl");
    const name = `work${Math.floor(Math.random() * 1e6)}`;
    expect((await postForm("/app/projects", u.cookie, { name, template: "team" })).status).toBe(303);
    expect((await getVault(env, u.user.id, name))?.guide).toContain("Shared work notes for the team.");
  });
});
