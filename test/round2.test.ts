// Round 2: Jev re-ranking and write hints (fake Jev), AI usage log, per-person invites, admin, stats.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WebAuthnVerifier } from "../src/auth/webauthn";
import { createInvite, createPat, getUser, getUserByName, listInvites } from "../src/directory";
import * as Q from "../src/jev/questions";
import { createApp } from "../src/web/app";
import { buckets } from "../src/web/round2";
import { caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { callTool, fetchWorker } from "./oauth";

const aiRows = async (userId: string) =>
  (
    await env.DB.prepare("SELECT model, purpose, calls, failed, input_tokens, estimated_calls FROM ai_daily WHERE user_id = ?").bind(userId).all<{
      model: string;
      purpose: string;
      calls: number;
      failed: number;
      input_tokens: number;
      estimated_calls: number;
    }>()
  ).results;

describe("Jev search re-ranking", () => {
  it("reorders the top candidates by Jev relevance and logs the call", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Solar", content: "solar solar solar solar notes" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Roof work", content: "Panel installation guide for solar roofs." });
    await v.stub.writeNote(v.ref, caller(user), { title: "Misc", content: "installation of a shelf" });
    const r = await v.stub.search(v.ref, { query: "solar panel installation" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.rerank).toMatchObject({ applied: true });
    expect(r.value.modes_used).toContain("jev");
    expect(r.value.hits[0].permalink).toBe("roof-work");
    const rel = r.value.hits.map((h) => h.relevance ?? -1);
    expect([...rel].sort((a, b) => b - a)).toEqual(rel);
    expect((await aiRows(user.id)).find((x) => x.purpose === "search_rerank")).toMatchObject({ calls: 1, failed: 0 });
  });

  it("asks one Score per candidate (abstention is computed from them), with every question from questions.ts", () => {
    expect(Q.relevanceQuestion("acme").instructions).toBe("How directly does `candidates.acme` answer `query`?");
    expect((Q.relevanceQuestion("acme").criteria as string[]).length).toBe(4);
    expect(Q.MATCH_LEVEL).toBe(2);
    expect([Q.band(0.8), Q.band(0.5), Q.band(0.2)]).toEqual(["yes", "unsure", "no"]);
  });

  it("flags 'no strong match' when Jev says nothing answers (abstention)", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    for (const t of ["zqa", "zqb", "zqc"]) await v.stub.writeNote(v.ref, caller(user), { title: t, content: `${t} filler` });
    const r = await v.stub.search(v.ref, { query: "zq" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.rerank).toMatchObject({ applied: true, any_match_band: "no" });
    const pat = await createPat(env, user.id, "t", ["memory:read"], null);
    const text = (await callTool(pat, "search_notes", { query: "zq" })).content[0].text;
    expect(text).toMatch(/^No strong match — consider rephrasing/);
  });

  it("skips Jev for fewer than 3 candidates", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Only", content: "lonely note" });
    const r = await v.stub.search(v.ref, { query: "lonely" });
    expect(r.ok && r.value.rerank).toBeUndefined();
  });

  it("degrades to fused order when Jev fails or times out, and logs the failure", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    for (const t of ["alpha one", "alpha two", "alpha three"]) await v.stub.writeNote(v.ref, caller(user), { title: t, content: `${t} alpha` });
    const base = await v.stub.search(v.ref, { query: "alpha" });
    for (const mode of ["fail", "slow"]) {
      await v.stub.setJevTestMode({ CAIRN_FAKE_JEV: mode });
      const r = await v.stub.search(v.ref, { query: "alpha" });
      if (!r.ok || !base.ok) throw new Error("search failed");
      expect(r.value.rerank?.applied).toBe(false);
      expect(r.value.rerank?.error).toMatch(mode === "fail" ? /fake Jev failure/ : /timed out/);
      expect(r.value.hits.length).toBe(3);
      expect(r.value.hits.every((h) => h.relevance === undefined)).toBe(true);
    }
    await v.stub.setJevTestMode({ JEV_MODEL: "" });
    const off = await v.stub.search(v.ref, { query: "alpha" });
    expect(off.ok && off.value.rerank).toBeUndefined();
    await v.stub.setJevTestMode(null);
    const rows = (await aiRows(user.id)).filter((x) => x.purpose === "search_rerank");
    expect(rows.reduce((n, x) => n + x.failed, 0)).toBe(2);
  });
});

describe("Jev write-time hints", () => {
  it("returns duplicate and conflict hints, never edits anything", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const first = await v.stub.writeNote(v.ref, caller(user), {
      title: "Acme Corp",
      content: "- [contact] Main contact is Dana Roe\n- [industry] Water supply company",
    });
    if (!first.ok) throw new Error(first.message);
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const w = await callTool(pat, "write_note", { title: "Acme Corp", directory: "orgs", content: "- [contact] Main contact is Sam Lee" });
    const text = w.content[0].text;
    expect(text).toMatch(/^saved main\/orgs\/acme-corp/);
    expect(text).toContain("likely duplicate of Acme Corp (acme-corp)");
    expect(text).toContain('possible conflict with Acme Corp (acme-corp): "Main contact is Dana Roe" vs new "Main contact is Sam Lee"');
    const orig = await v.stub.readNote(v.ref, { identifier: "acme-corp" });
    expect(orig.ok && orig.value.note.checksum).toBe(first.value.note.checksum);
    // edits: only newly added observations are checked
    const e = await v.stub.editNote(v.ref, caller(user), { identifier: "orgs/acme-corp", command: "append", content: "- [industry] Water supply consultancy" });
    expect(e.ok && e.value.hints?.conflicts.map((c) => c.old)).toEqual(["Water supply company"]);
    expect(e.ok && e.value.hints?.duplicates).toEqual([]);
    expect((await aiRows(user.id)).find((x) => x.purpose === "write_hints")?.calls).toBe(2);
  });

  it("skips hints with a note when Jev fails; the write still succeeds", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Widget", content: "- [price] 10 dollars" });
    await v.stub.setJevTestMode({ CAIRN_FAKE_JEV: "fail" });
    const w = await v.stub.writeNote(v.ref, caller(user), { title: "Widget", directory: "x", content: "- [price] 12 dollars" });
    await v.stub.setJevTestMode(null);
    expect(w.ok).toBe(true);
    expect(w.ok && w.value.hints?.skipped).toMatch(/write hints unavailable/);
  });
});

describe("AI usage log", () => {
  it("records embedding and query-embedding calls with estimated tokens", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Garden", content: "Tomatoes need sun." });
    await v.stub.embedPending();
    await v.stub.search(v.ref, { query: "tomatoes", mode: "semantic" });
    const rows = await aiRows(user.id);
    const embed = rows.find((r) => r.purpose === "embed");
    expect(embed).toMatchObject({ model: "fake-hash-embedder", failed: 0 });
    expect(embed?.input_tokens).toBeGreaterThan(0);
    expect(embed?.estimated_calls).toBeGreaterThan(0);
    expect(rows.find((r) => r.purpose === "query_embed")?.calls).toBe(1);
  });
});

// ---- invites, admin ----

const fakeVerifier: WebAuthnVerifier = {
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
  async verifyAuthentication({ credential }) {
    return { newCounter: credential.counter + 1 };
  },
};
const app = createApp({ verifier: fakeVerifier });
const postJson = (path: string, body: unknown, e = env) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) }, e);
async function signup(username: string, invite?: string, e = env) {
  const o = (await (await postJson("/auth/signup/options", { username, invite }, e)).json()) as { challengeId?: string; error?: string };
  if (!o.challengeId) return { status: 403, cookie: "" };
  const v = await postJson("/auth/signup/verify", { challengeId: o.challengeId, response: { id: `cred-${username}` } }, e);
  return { status: v.status, cookie: /(__Host-cairn_session=[^;]+)/.exec(v.headers.get("set-cookie") ?? "")?.[1] ?? "" };
}
const form = (cookie: string, data: Record<string, string>) => ({
  method: "POST",
  headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});

describe("per-person invites", () => {
  it("any user can invite, within a quota; links are single-use; invited_by is recorded", async () => {
    const { user, cookie } = await makeUser("host");
    for (let i = 0; i < 5; i++) expect((await createInvite(env, user, { note: `friend ${i}` })).ok).toBe(true);
    expect(await createInvite(env, user)).toMatchObject({ ok: false });
    const page = await fetchWorker("/app/settings/invites", { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain("friend 0");
    const code = /signup\?invite=([A-Za-z0-9_-]+)/.exec(html)?.[1] ?? "";
    // open sign-up still credits the inviter
    const name = `guest${Date.now()}`;
    expect((await signup(name, code)).status).toBe(200);
    const guest = await getUserByName(env, name);
    expect(guest?.invited_by).toBe(user.id);
    expect((await listInvites(env, user.id)).find((i) => i.joined_username === name)).toBeTruthy();
    expect((await signup(`${name}x`, code, { ...env, OPEN_SIGNUP: "false" })).status).toBe(403); // used
    // revoke frees quota and kills the link
    const open = (await listInvites(env, user.id)).find((i) => !i.used_at);
    const res = await fetchWorker("/app/settings/invites/revoke", form(cookie, { id: open?.id ?? "" }));
    expect(res.status).toBe(303);
    expect((await listInvites(env, user.id)).find((i) => i.id === open?.id)?.revoked_at).toBeTruthy();
    const created = await fetchWorker("/app/settings/invites", form(cookie, { note: "for Mum", days: "3" }));
    expect(created.headers.get("location")).toBe("/app/settings/invites?created=1");
  });

  it("revoked invites don't admit anyone when sign-up is closed", async () => {
    const { user, cookie } = await makeUser("host2");
    const inv = await createInvite(env, user);
    if (!inv.ok) throw new Error();
    await fetchWorker("/app/settings/invites/revoke", form(cookie, { id: inv.id }));
    expect((await signup(`late${Date.now()}`, inv.code, { ...env, OPEN_SIGNUP: "false" })).status).toBe(403);
  });
});

describe("admin", () => {
  it("lists accounts with counts only, and disables/enables accounts", async () => {
    const admin = await makeUser("adm");
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(admin.user.id).run();
    const victim = await makeUser("vic");
    const v = await defaultVault(victim.user.id);
    await v.stub.writeNote(v.ref, caller(victim.user), { title: "Diary", content: "very-secret-diary-text" });
    const pat = await createPat(env, victim.user.id, "t", ["memory:read"], null);

    expect((await fetchWorker("/app/admin", { headers: { cookie: victim.cookie } })).status).toBe(403);
    const html = await (await fetchWorker("/app/admin", { headers: { cookie: admin.cookie } })).text();
    expect(html).toContain(victim.user.username);
    expect(html).not.toContain("very-secret-diary-text");
    expect(html).not.toContain("Diary");

    expect((await fetchWorker("/app/admin/users/disable", form(admin.cookie, { id: victim.user.id }))).status).toBe(303);
    expect((await getUser(env, victim.user.id))?.disabled_at).toBeTruthy();
    expect((await fetchWorker("/app", { headers: { cookie: victim.cookie } })).status).toBe(302); // session gone
    const mcp = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${pat}`, "content-type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(401); // PAT deleted
    // sign-in refused
    await env.DB.prepare("INSERT INTO credentials (id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, 0, ?)")
      .bind("cred-victim", victim.user.id, new Uint8Array([1]), new Date().toISOString())
      .run();
    const o = (await (await postJson("/auth/login/options", {})).json()) as { challengeId: string };
    expect((await postJson("/auth/login/verify", { challengeId: o.challengeId, response: { id: "cred-victim" } })).status).toBe(403);
    // re-enable
    await fetchWorker("/app/admin/users/enable", form(admin.cookie, { id: victim.user.id }));
    const o2 = (await (await postJson("/auth/login/options", {})).json()) as { challengeId: string };
    expect((await postJson("/auth/login/verify", { challengeId: o2.challengeId, response: { id: "cred-victim" } })).status).toBe(200);
    // admins can't disable themselves
    expect((await fetchWorker("/app/admin/users/disable", form(admin.cookie, { id: admin.user.id }))).status).toBe(400);
  });
});

describe("stats", () => {
  it("renders Mine with memory, activity, AI usage and accessible charts", async () => {
    const { user, cookie } = await makeUser();
    const pat = await createPat(env, user.id, "laptop", ["memory:read", "memory:write"], null);
    await callTool(pat, "write_note", { title: "Stat note", content: "- [fact] Something #alpha\n- uses [[Missing]]", note_type: "project", tags: ["alpha"] });
    for (const t of ["one", "two", "three"]) await callTool(pat, "write_note", { title: `Stat ${t}`, content: `stat ${t}` });
    await callTool(pat, "search_notes", { query: "stat" });
    await callTool(pat, "read_note", { identifier: "stat-note" });
    const res = await fetchWorker("/app/stats?range=7d", { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Tracking started");
    expect(html).toMatch(/<svg viewBox="0 0 640 180" role="img" aria-labelledby="saved-t saved-d"/);
    expect(html).toContain('<title id="saved-t">Notes saved (created or updated) per period</title>');
    expect(html).toMatch(/<strong>4<\/strong> by AI/);
    expect(html).toContain("token: laptop 4");
    expect(html).toContain("<code>write_note</code></td><td>4</td>");
    expect(html).toContain("<td>search_rerank</td>");
    expect(html).toContain("1</strong> unresolved links");
    expect(html).toContain("#alpha");
    expect(html).toContain("$0.042 per million input tokens");
    expect(html).not.toContain("accounts"); // Everyone is admin-only
    const everyone = await (await fetchWorker("/app/stats?scope=everyone", { headers: { cookie } })).text();
    expect(everyone).not.toContain("accounts");
  });

  it("Everyone scope for admins shows instance totals and invites", async () => {
    const { user, cookie } = await makeUser("statadm");
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(user.id).run();
    await createInvite(env, { ...user, is_admin: 1 });
    const html = await (await fetchWorker("/app/stats?scope=everyone&range=all", { headers: { cookie } })).text();
    expect(html).toContain("accounts");
    expect(html).toContain("<h2>Invites</h2>");
    expect(html).toMatch(/<strong>[1-9]\d*<\/strong> sent/);
  });

  it("buckets: daily to 30 days, weekly to ~26 weeks, monthly beyond", () => {
    const today = new Date("2026-11-04T12:00:00Z");
    expect(buckets("7d", "2026-01-01", today).length).toBe(7);
    expect(buckets("30d", "2026-01-01", today).length).toBe(30);
    expect(buckets("90d", "2026-01-01", today).length).toBe(13);
    expect(buckets("all", "2025-11-04", today).length).toBe(13);
  });
});
