// Round 3a: core memory, supersession + expiry, history/activity/revert, gardening + digest cron.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPat, setUserDisabled } from "../src/directory";
import { parseNote, parseTemporal } from "../src/markdown/parse";
import { isoWeek, runNightly } from "../src/memory/cron";
import { diffLines } from "../src/memory/diff";
import { expire, supersede } from "../src/memory/supersede";
import { caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { callTool, fetchWorker, mcp } from "./oauth";

const today = () => new Date().toISOString().slice(0, 10);
const form = (cookie: string, data: Record<string, string>) => ({
  method: "POST",
  headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});

describe("temporal grammar and supersession (pure)", () => {
  it.each([
    ["since 2026-01-01", { validFrom: "2026-01-01", validTo: null, expires: null }],
    ["since 2026-01-01; until 2026-06-30; moved", { validFrom: "2026-01-01", validTo: "2026-06-30", expires: null }],
    ["expires 2026-12-16", { validFrom: null, validTo: null, expires: "2026-12-16" }],
    ["2026-03-14 → 2026-10-01; replaced by Dana", { validFrom: "2026-03-14", validTo: "2026-10-01", expires: null }],
    ["via call", { validFrom: null, validTo: null, expires: null }],
  ])("%s", (ctx, want) => expect(parseTemporal(ctx)).toEqual(want));

  it("marks observations under Superseded", () => {
    const p = parseNote("# X\n- [a] live\n## Superseded\n- [a] old (until 2026-01-01)\n");
    expect(p.observations.map((o) => [o.content, o.superseded, o.validTo])).toEqual([
      ["live", false, null],
      ["old", true, "2026-01-01"],
    ]);
  });

  it("supersede moves the old line and writes the new one in place", () => {
    const md = "---\ntitle: Acme\n---\n# Acme\n\n## Observations\n- [contact] Main contact is Sam Lee #people (since 2026-03-14)\n- [industry] Water\n";
    const r = supersede(md, { match: "[contact] Sam", replacement: "Main contact is Dana Roe #people", reason: "Sam left", today: "2026-11-04" });
    if (!r.ok) throw new Error(r.message);
    expect(r.markdown).toBe(
      "---\ntitle: Acme\n---\n# Acme\n\n## Observations\n- [contact] @effective:2026-11-04 Main contact is Dana Roe #people\n- [industry] Water\n\n## Superseded\n- [contact] @effective[2026-03-14,2026-11-04) Main contact is Sam Lee #people (Sam left)\n",
    );
    expect(supersede(r.markdown, { match: "Sam Lee", replacement: "x", today: "2026-11-04" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(supersede(md, { match: "a", replacement: "x", today: "2026-11-04" })).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("expire moves due observations and keeps the text", () => {
    const md = "# P\n- [status] Pilot running (expires 2026-01-01)\n- [status] Other (expires 2099-01-01)\n";
    const r = expire(md, "2026-11-04");
    expect(r.moved).toEqual(["- [status] Pilot running (until 2026-01-01; expired)"]);
    expect(r.markdown).toContain("Other (expires 2099-01-01)");
    expect(r.markdown).toContain("## Superseded\n- [status] Pilot running");
  });

  it("diffLines finds the change", () => {
    const ops = diffLines("a\nb\nc", "a\nB\nc");
    expect(ops.map((o) => o.op)).toEqual(["eq", "del", "add", "eq"]);
    expect(isoWeek(new Date("2026-11-04T00:00:00Z"))).toBe("2026-W45");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});

describe("core memory", () => {
  it("core_memory creates the index, includes pinned notes, and warns over budget", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    await v.stub.writeNote(v.ref, caller(user), { title: "Prefs", content: "- [style] Short answers", metadata: { pinned: true } });
    await v.stub.writeNote(v.ref, caller(user), { title: "Unpinned", content: "nope" });
    const t = (await callTool(pat, "core_memory", {})).content[0].text;
    expect(t).toContain("## Core memory index (memory/index)");
    expect(t).toContain("## Pinned: Prefs (prefs)\n- [style] Short answers");
    expect(t).not.toContain("nope");
    expect(t).toMatch(/core memory for main: [\d.]+ KB of a 8.0 KB budget; 1 pinned note/);
    expect((await v.stub.readNote(v.ref, { identifier: "memory/index" })).ok).toBe(true);
    await env.DB.prepare("UPDATE users SET core_budget = 400 WHERE id = ?").bind(user.id).run();
    await v.stub.writeNote(v.ref, caller(user), { title: "Big", content: "x\n".repeat(600), metadata: { pinned: true } });
    const over = (await callTool(pat, "core_memory", {})).content[0].text;
    expect(over).toContain("OVER BUDGET");
    expect(over).toContain("Condense your core memory");
    expect(new TextEncoder().encode(over.split("\n— core memory")[0]).length).toBeLessThanOrEqual(400 + 20);
  });

  it("is also an MCP prompt; read-only connections don't create the index", async () => {
    const { user } = await makeUser();
    const ro = await createPat(env, user.id, "ro", ["memory:read"], null);
    const list = await mcp(ro, "prompts/list");
    expect(list.result.prompts.map((p: { name: string }) => p.name)).toContain("core_memory");
    const got = await mcp(ro, "prompts/get", { name: "core_memory" });
    expect(got.result.messages[0].content.text).toContain("core memory is empty");
    const v = await defaultVault(user.id);
    expect((await v.stub.readNote(v.ref, { identifier: "memory/index" })).ok).toBe(false);
    const init = await mcp(ro, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.instructions).toContain("call core_memory");
  });

  it("pinning from the web shows up in the /app core panel", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Goals", content: "ship it" });
    const page = await (await fetchWorker("/app/v/main/n/goals", { headers: { cookie } })).text();
    expect(page).toContain("Pin to core memory");
    expect((await fetchWorker("/app/v/main/pin", form(cookie, { permalink: "goals", pin: "1" }))).status).toBe(303);
    const r = await v.stub.readNote(v.ref, { identifier: "goals" });
    expect(r.ok && r.value.content).toContain("pinned: true");
    const home = await (await fetchWorker("/app", { headers: { cookie } })).text();
    expect(home).toContain("Core memory");
    expect(home).toMatch(/📌 <a href="\/app\/v\/main\/n\/goals">Goals<\/a>/);
  });
});

describe("supersession over MCP and search history", () => {
  it("supersede keeps history; search hides it unless as_of", async () => {
    const { user } = await makeUser();
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    await callTool(pat, "write_note", { title: "Acme", content: "- [contact] Main contact is Zelda Quux (since 2026-01-01)\n- [industry] Water" });
    const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
    const s = (
      await callTool(pat, "supersede", { note: "acme", observation: "[contact] Zelda", replacement: "Main contact is Yuri Vole", reason: "Zelda left" })
    ).content[0].text;
    expect(s).toMatch(/^updated main\/acme rev/);
    expect(s).toContain(`superseded: - [contact] @effective[2026-01-01,${today()}) Main contact is Zelda Quux (Zelda left)`);
    expect(s).toContain(`now: - [contact] @effective:${today()} Main contact is Yuri Vole`);
    const v = await defaultVault(user.id);
    const now = await v.stub.search(v.ref, { query: "Zelda", mode: "text" });
    expect(now.ok && now.value.hits[0]?.observations).toEqual([]);
    expect(now.ok && now.value.hits[0]?.matches).toEqual([]);
    const then = await v.stub.search(v.ref, { query: "Zelda", mode: "text", as_of: yesterday });
    expect(then.ok && then.value.hits[0]?.observations.map((o) => o.content)).toEqual(["Main contact is Zelda Quux"]);
    const yuri = await v.stub.search(v.ref, { query: "Yuri", mode: "text" });
    expect(yuri.ok && yuri.value.hits[0]?.observations.map((o) => o.content)).toEqual(["Main contact is Yuri Vole"]);
  });

  it("the nightly cron expires due observations", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Pilot", content: "- [status] Pilot running (expires 2020-01-01)" });
    const r = await runNightly(env, new Date());
    expect(r.expired.vaults).toBeGreaterThanOrEqual(1);
    const read = await v.stub.readNote(v.ref, { identifier: "pilot" });
    expect(read.ok && read.value.content).toContain("## Superseded\n- [status] Pilot running (until 2020-01-01; expired)");
    expect(read.ok && read.value.note.updated_by_client).toBe("cairn-cron");
  });
});

describe("history, activity and revert", () => {
  it("the activity feed shows who changed what, scoped to the user", async () => {
    const a = await makeUser("acta");
    const b = await makeUser("actb");
    const pat = await createPat(env, a.user.id, "laptop", ["memory:read", "memory:write"], null);
    await callTool(pat, "write_note", { title: "Secret plans", content: "hello" });
    const feed = await (await fetchWorker("/app/activity", { headers: { cookie: a.cookie } })).text();
    expect(feed).toContain("Secret plans");
    expect(feed).toContain("token: laptop");
    const other = await (await fetchWorker("/app/activity", { headers: { cookie: b.cookie } })).text();
    expect(other).not.toContain("Secret plans");
    expect(await (await fetchWorker("/app/activity?client=nobody", { headers: { cookie: a.cookie } })).text()).toContain("No changes yet");
  });

  it("history shows a diff and revert restores the earlier text, checksum-guarded", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    const w1 = await v.stub.writeNote(v.ref, caller(user), { title: "Doc", content: "line one\nline two" });
    const w2 = await v.stub.writeNote(v.ref, caller(user, "agent"), { title: "Doc", content: "line one\nline TWO changed", overwrite: true });
    if (!w1.ok || !w2.ok) throw new Error();
    const h = await v.stub.noteHistory(v.ref, "doc");
    const upd = h?.revisions[0];
    expect(upd?.action).toBe("update");
    const page = await (await fetchWorker(`/app/v/main/n/doc/history?rev=${upd?.id}`, { headers: { cookie } })).text();
    expect(page).toContain('class="del">line two');
    expect(page).toContain('class="add">line TWO changed');
    // stale checksum refused
    const stale = await fetchWorker("/app/v/main/revert", form(cookie, { rev: String(upd?.id), permalink: "doc", checksum: w1.value.note.checksum }));
    expect(decodeURIComponent(stale.headers.get("location") ?? "")).toContain("Not undone");
    const okr = await fetchWorker("/app/v/main/revert", form(cookie, { rev: String(upd?.id), permalink: "doc", checksum: w2.value.note.checksum }));
    expect(decodeURIComponent(okr.headers.get("location") ?? "")).toContain("Undone: note restored");
    const now = await v.stub.readNote(v.ref, { identifier: "doc" });
    expect(now.ok && now.value.content).toContain("line two");
    expect(now.ok && now.value.content).not.toContain("TWO changed");
    expect((await v.stub.noteHistory(v.ref, "doc"))?.revisions[0].client).toBe("web");
  });

  it("bulk revert undoes everything one client did since a time", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user, "web"), { title: "Kept", content: "original" });
    const since = new Date(Date.now() - 1000).toISOString();
    await v.stub.writeNote(v.ref, caller(user, "rogue"), { title: "Kept", content: "vandalised", overwrite: true });
    await v.stub.writeNote(v.ref, caller(user, "rogue"), { title: "Spam", content: "junk" });
    const confirm = await (await fetchWorker(`/app/activity/revert?client=rogue&since=${encodeURIComponent(since)}`, { headers: { cookie } })).text();
    expect(confirm).toContain("restore the text before");
    expect(confirm).toContain("delete it (it was created)");
    const fields: Record<string, string> = { client: "rogue", since };
    for (const m of confirm.matchAll(/name="(e:[^"]+)" value="([^"]*)"/g)) fields[m[1]] = m[2];
    const res = await (await fetchWorker("/app/activity/revert", form(cookie, fields))).text();
    expect(res).toContain("restored");
    expect(res).toContain("deleted");
    const kept = await v.stub.readNote(v.ref, { identifier: "kept" });
    expect(kept.ok && kept.value.content).toContain("original");
    expect((await v.stub.readNote(v.ref, { identifier: "spam" })).ok).toBe(false);
  });
});

describe("gardening and weekly digest (cron, with fakes)", () => {
  it("writes a gardening checklist without touching other notes; skips opted-out and idle users", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Lonely", content: "no links here" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Linker", content: "see [[Nowhere Land]] and [[Partner]]\n- [ceo] Main contact is Dana Roe" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Partner", content: "- [ceo] Main contact is Sam Lee" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Project Alpha", content: "a" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Project Alpha!", directory: "x", content: "b" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Status note", content: "- [status] In progress" });
    await runInDurableObject(v.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE notes SET updated_at = '2020-01-01T00:00:00.000Z' WHERE permalink = 'status-note'");
    });
    const before = await v.stub.readNote(v.ref, { identifier: "lonely" });
    const off = await makeUser("nogarden");
    const offV = await defaultVault(off.user.id);
    await offV.stub.writeNote(offV.ref, caller(off.user), { title: "Lonely too", content: "x" });
    await env.DB.prepare("UPDATE users SET garden_enabled = 0 WHERE id = ?").bind(off.user.id).run();

    await runNightly(env, new Date());
    const g = await v.stub.readNote(v.ref, { identifier: `gardening/gardening-${today()}` });
    if (!g.ok) throw new Error(g.message);
    const text = g.value.content ?? "";
    expect(text).toContain("Suggestions only: nothing was changed.");
    expect(text).toContain(
      '## Possible contradictions\n- [ ] [[linker|Linker]] says "Main contact is Dana Roe" but [[partner|Partner]] says "Main contact is Sam Lee"',
    );
    expect(text).toContain("[[Nowhere Land]] is linked from [[linker|Linker]]");
    expect(text).toContain("[[lonely|Lonely]] has no links in or out");
    expect(text).toMatch(/\[\[project-alpha\|Project Alpha\]\] and \[\[x\/project-alpha\|Project Alpha!\]\] have near-identical titles/);
    expect(text).toContain('[[status-note|Status note]]: "[status] In progress" (last updated 2020-01-01)');
    expect(g.value.note.updated_by_client).toBe("cairn-gardener");
    const after = await v.stub.readNote(v.ref, { identifier: "lonely" });
    expect(after.ok && before.ok && after.value.note.checksum).toBe(before.ok ? before.value.note.checksum : "");
    expect((await offV.stub.readNote(offV.ref, { identifier: `gardening/gardening-${today()}` })).ok).toBe(false);
    expect(
      (await env.DB.prepare("SELECT calls FROM ai_daily WHERE user_id = ? AND purpose = 'garden_check'").bind(user.id).first<{ calls: number }>())?.calls,
    ).toBe(1);
  });

  it("on Monday writes 'what your agents learned' with an AI summary and links; disabled users are skipped", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    await callTool(pat, "write_note", { title: "Learned one", content: "- [fact] The sky is blue" });
    await callTool(pat, "write_note", { title: "Learned two", content: "- [fact] Water is wet" });
    const dis = await makeUser("gone");
    const disV = await defaultVault(dis.user.id);
    await disV.stub.writeNote(disV.ref, caller(dis.user, "agent"), { title: "Hidden", content: "x" });
    await setUserDisabled(env, dis.user.id, true);
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
    monday.setUTCHours(3, 0, 0, 0);
    const r = await runNightly(env, monday);
    expect(r.digests).not.toBeNull();
    const week = isoWeek(new Date(monday.getTime() - 86400e3));
    const d = await v.stub.readNote(v.ref, { identifier: `digests/${week.toLowerCase()}` });
    if (!d.ok) throw new Error(d.message);
    expect(d.value.content).toContain(`# What your agents learned — ${week}`);
    expect(d.value.content).toContain("Summary of 2 notes this week.");
    expect(d.value.content).toContain("- [[learned-one|Learned one]] — create by token: t");
    expect((await env.DB.prepare("SELECT calls FROM ai_daily WHERE user_id = ? AND purpose = 'digest'").bind(user.id).first<{ calls: number }>())?.calls).toBe(
      1,
    );
    expect((await disV.stub.readNote(disV.ref, { identifier: `digests/${week.toLowerCase()}` })).ok).toBe(false);
  });
});

describe("memory settings", () => {
  it("saves the core budget and the gardening opt-out", async () => {
    const { user, cookie } = await makeUser();
    expect((await fetchWorker("/app/settings/memory", form(cookie, { budget_kb: "16" }))).status).toBe(303);
    const row = await env.DB.prepare("SELECT core_budget, garden_enabled FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ core_budget: number; garden_enabled: number }>();
    expect(row).toEqual({ core_budget: 16384, garden_enabled: 0 });
  });
});
