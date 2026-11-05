// Parity review should-fixes 2–6 (.lead/reports/review-parity.md): bounded filter/find work,
// exact cross-project pages, a resumable graph upgrade, undoable moves, per-note folder writes.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPat, createVault, getVault } from "../src/directory";
import { admitWrites } from "../src/stats/limits";
import { FILTER_LIMITS, filtersProblem } from "../src/vault/filters";
import { parseSince } from "../src/vault/time";
import { caller, defaultVault, makeUser } from "./helpers";
import { mcp } from "./oauth";

async function call(token: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  const text: string = r.error ? String(r.error.message) : (r.result.content?.[0]?.text ?? "");
  return { text, isError: !!r.error || !!r.result.isError, json: () => JSON.parse(text) as Record<string, unknown> };
}

async function setup() {
  const { user } = await makeUser("pfx");
  const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
  return { user, pat, v: await defaultVault(user.id) };
}

describe("2. filter and find work is bounded", () => {
  it("refuses oversized or oddly shaped filters before scanning", () => {
    expect(filtersProblem({ status: { $in: Array.from({ length: FILTER_LIMITS.listItems + 1 }, (_, i) => `s${i}`) } })).toMatch(/at most 50 values/);
    expect(filtersProblem({ tags: Array.from({ length: 51 }, () => "x") })).toMatch(/at most 50 values/);
    expect(filtersProblem({ title: "x".repeat(501) })).toMatch(/at most 500 characters/);
    expect(filtersProblem({ owner: { $gt: { nested: 1 } } })).toMatch(/strings, numbers, booleans or null/);
    expect(filtersProblem({ owner: { name: "x" } })).toMatch(/unknown operator name/);
    expect(filtersProblem({ "a.b.c.d.e.f": 1 })).toMatch(/dot paths/);
    expect(filtersProblem({ "a..b": 1 })).toMatch(/dot paths/);
    expect(filtersProblem(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, "y".repeat(300)])))).toMatch(/at most 4096 bytes/);
    expect(filtersProblem({ status: { $in: ["active", "blocked"] }, priority: { $gte: 2 }, owner: null, tags: ["a"] })).toBeNull();
  });

  it("find_notes stops after its scan budget and says so; it honours the search limiter", async () => {
    const { pat, v } = await setup();
    for (const t of ["a1", "a2", "a3", "a4", "a5"])
      await v.stub.writeNote(v.ref, caller({ id: v.vault.owner_id, username: "u" } as never), { title: t, content: "x" });
    await v.stub.setLimitsForTest({ findScanMax: 3 });
    const r = await call(pat, "find_notes", { name: "a*", project: "main" });
    expect(r.text).toContain("— 3+ note(s), page 1 (stopped after looking at 3 notes; narrow it with path)");
    const j = (await call(pat, "find_notes", { name: "a*", output_format: "json", project: "main" })).json();
    expect(j).toMatchObject({ total: 3, total_is_exact: false, scanned: 3 });
    // A filter-only search is bounded the same way.
    const s = await call(pat, "search_notes", { filters: { type: "note" }, project: "main" });
    expect(s.text).toContain("filter-only search stopped after 3 matching notes (3 looked at)");
    await v.stub.setLimitsForTest({ findScanMax: 20_000 });
    expect((await call(pat, "find_notes", { name: "a*", output_format: "json", project: "main" })).json()).toMatchObject({ total: 5, total_is_exact: true });
    await v.stub.setFaults(["search-limited"]);
    expect((await call(pat, "find_notes", { name: "*", project: "main" })).text).toMatch(/^RATE_LIMITED/);
    await v.stub.setFaults([]);
  });
});

describe("3. cross-project pages are exact beyond result 100", () => {
  it("returns a dominant project's results 101+ in the merged order", async () => {
    const { user, pat, v } = await setup();
    await createVault(env, user.id, "side");
    const side = (await getVault(env, user.id, "side"))!;
    const sideRef = { id: side.id, name: side.name, ownerId: side.owner_id };
    const sideStub = env.VAULT.getByName(side.id);
    const who = caller(user);
    for (let i = 0; i < 115; i++) await v.stub.writeNote(v.ref, who, { title: `Zeta main ${String(i).padStart(3, "0")}`, content: "zeta" });
    for (let i = 0; i < 5; i++) await sideStub.writeNote(sideRef, who, { title: `Zeta side ${i}`, content: "zeta" });
    const page12 = (
      await call(pat, "search_notes", { query: "zeta", mode: "text", projects: ["main", "side"], page: 12, page_size: 10, output_format: "json" })
    ).json();
    expect(page12.total).toBe(120);
    expect((page12.results as unknown[]).length).toBe(10);
    expect(page12.has_more).toBe(false);
    const page11 = (
      await call(pat, "search_notes", { query: "zeta", mode: "text", projects: ["main", "side"], page: 11, page_size: 10, output_format: "json" })
    ).json();
    expect(page11.has_more).toBe(true);
    // Every result appears exactly once across the pages.
    const seen = new Set<string>();
    for (let p = 1; p <= 3; p++) {
      const r = (await call(pat, "search_notes", { query: "zeta", mode: "text", all_projects: true, page: p, page_size: 50, output_format: "json" })).json();
      for (const h of r.results as { project: string; permalink: string }[]) seen.add(`${h.project}/${h.permalink}`);
    }
    expect(seen.size).toBe(120);
    expect((await call(pat, "search_notes", { query: "zeta", projects: ["main", "side"], page: 101, page_size: 10 })).text).toMatch(/at most result 1000/);
  }, 120_000); // 120 writes: slow under a loaded full-suite run
});

describe("4. the graph upgrade is resumable and bounded", () => {
  it("re-projects a few notes per pass, keeps its cursor, and finishes", async () => {
    const { user, v } = await setup();
    const who = caller(user);
    for (let i = 0; i < 4; i++) {
      await v.stub.writeNote(v.ref, who, {
        title: `Legacy ${i}`,
        directory: "notes",
        content: `- [deadline] @due:2026-10-2${i} Ship ${i}\nSee [the guide](../guides/g.md).`,
      });
    }
    await v.stub.writeNote(v.ref, who, { title: "Plain", content: "no qualifiers here" });
    // Make the vault look like it was written before the upgrade.
    await runInDurableObject(v.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE observations SET time_kind = NULL, t_start = NULL, t_end = NULL");
      state.storage.sql.exec("DELETE FROM relations WHERE to_name = 'guides/g'");
      state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('graph_version', '1')");
    });
    const kinds = () =>
      runInDurableObject(v.stub, (_i, state) => ({
        due: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM observations WHERE time_kind = 'due'").one().n,
        links: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM relations WHERE to_name = 'guides/g'").one().n,
        version: state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'graph_version'").one().value,
        cursor: state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'graph_cursor'").toArray()[0]?.value ?? null,
      }));
    await v.stub.setLimitsForTest({ graphUpgradeBatch: 2 });
    expect(await v.stub.continueGraphUpgrade()).toBe(false);
    const half = await kinds();
    expect(half).toMatchObject({ due: 2, links: 2, version: "1" });
    expect(half.cursor).not.toBeNull();
    // An interruption here is harmless: the next pass resumes after the cursor (via the alarm).
    for (let i = 0; i < 5 && (await runDurableObjectAlarm(v.stub)); i++);
    expect(await kinds()).toEqual({ due: 4, links: 4, version: "2", cursor: null });
    expect(await v.stub.continueGraphUpgrade()).toBe(true);
  });
});

describe("5. moves are undoable from history", () => {
  it("moves back, and refuses to undo a move the note has since moved on from", async () => {
    const { user, pat, v } = await setup();
    await call(pat, "write_note", { title: "Roamer", directory: "a", content: "x", project: "main" });
    await call(pat, "move_note", { identifier: "a/roamer", destination: "b/", project: "main" });
    await call(pat, "move_note", { identifier: "a/roamer", destination: "c/Roamer.md", project: "main" });
    const hist = await v.stub.noteHistory(v.ref, "a/roamer");
    const moves = hist!.revisions.filter((r) => r.action === "move");
    expect(moves.length).toBe(2);
    const [second, first] = moves; // newest first
    const note = await v.stub.readNote(v.ref, { identifier: "a/roamer" });
    const sum = note.ok ? note.value.note.checksum : "";
    const who = caller(user, "web", "web:revert");
    expect(await v.stub.revertRevision(v.ref, who, first.id, sum)).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(await v.stub.revertRevision(v.ref, who, second.id, sum)).toMatchObject({ ok: true, value: { action: "moved back" } });
    const mid = await v.stub.readNote(v.ref, { identifier: "a/roamer" });
    expect(mid.ok && mid.value.note.file_path).toBe("b/Roamer.md");
    expect(await v.stub.revertRevision(v.ref, who, first.id, sum)).toMatchObject({ ok: true, value: { action: "moved back" } });
    const back = await v.stub.readNote(v.ref, { identifier: "a/roamer" });
    expect(back.ok && back.value.note.file_path).toBe("a/Roamer.md");
    // "Undo everything this app did" plans a move back too.
    const before = new Date().toISOString();
    await call(pat, "move_note", { identifier: "a/roamer", destination: "z/", project: "main" });
    const client = (await v.stub.noteHistory(v.ref, "a/roamer"))!.revisions[0].client as string;
    const plan = await v.stub.planClientRevert(v.ref, client, before);
    expect(plan.find((p) => p.permalink === "a/roamer")?.plan).toBe("move back");
    const undo = await v.stub.revertClient(v.ref, who, client, before, { [String(plan[0].noteId)]: plan[0].checksum }, 5);
    expect(undo).toEqual([{ permalink: "a/roamer", ok: true, message: "moved back" }]);
    const home = await v.stub.readNote(v.ref, { identifier: "a/roamer" });
    expect(home.ok && home.value.note.file_path).toBe("a/Roamer.md");
  });
});

describe("6. folder moves and deletes take a write per note", () => {
  it("admits one token per note and stops at the first refusal", async () => {
    let n = 0;
    const allow = (k: number) => ({ limit: async () => ({ success: n++ < k }) });
    n = 0;
    expect(await admitWrites({ ...env, RL_WRITE: allow(2) } as typeof env, "u", 10, 1)).toBe(3);
    n = 0;
    expect(await admitWrites({ ...env, RL_WRITE: allow(100) } as typeof env, "u", 4, 1)).toBe(4);
    expect(await admitWrites({ ...env, RL_WRITE: allow(0) } as typeof env, "u", 1, 1)).toBe(1);
  });

  it("a folder move with a partial budget moves that many and resumes", async () => {
    const { user, v } = await setup();
    const who = caller(user);
    for (let i = 0; i < 5; i++) await v.stub.writeNote(v.ref, who, { title: `N${i}`, directory: "src", content: "x" });
    expect(await v.stub.countUnder(v.ref, "src")).toBe(5);
    const first = await v.stub.moveFolder(v.ref, who, { path: "src", destination: "dst", max: 2 });
    expect(first).toMatchObject({ ok: true, value: { moved: 2, remaining: 3 } });
    const rest = await v.stub.moveFolder(v.ref, who, { path: "src", destination: "dst", max: 10 });
    expect(rest).toMatchObject({ ok: true, value: { moved: 3, remaining: 0 } });
    expect(await v.stub.countUnder(v.ref, "dst")).toBe(5);
    const del = await v.stub.deleteFolder(v.ref, who, { path: "dst", max: 4 });
    expect(del).toMatchObject({ ok: true, value: { remaining: 1 } });
    expect(del.ok && del.value.deleted.length).toBe(4);
  });
});

describe("time windows out of range", () => {
  it("are INVALID, not a thrown RangeError", () => {
    expect(parseSince("99999999999 years")).toBeUndefined();
    expect(parseSince("9999999999999999999999 days")).toBeUndefined();
  });
});
