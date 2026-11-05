import { describe, expect, it } from "vitest";
import { LONG_PATTERN_MAX } from "../src/vault/do";
import { caller, defaultVault, makeUser } from "./helpers";

// Durable Object SQLite refuses LIKE/GLOB patterns over 50 bytes ("LIKE or GLOB pattern too complex").
// Every path that used to hand a user-sized string to LIKE or GLOB must still answer correctly past that.
const LONG = "a-folder-name-that-is-comfortably-longer-than-fifty-bytes";

describe("long search patterns and folder names (past SQLite's 50-byte LIKE/GLOB cap)", () => {
  it("search, context, list, find and folder operations work with long patterns", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    const who = caller(user);
    const write = async (directory: string, title: string) => {
      const w = await stub.writeNote(ref, who, { directory, title, content: `# ${title}\n\nbody of ${title}\n` });
      if (!w.ok) throw new Error(w.message);
      return w.value.note;
    };
    const deep = await write(`projects/${LONG}`, "Quarterly Planning Notes For The Long Folder");
    const deeper = await write(`projects/${LONG}/sub`, "Nested Child");
    // A sibling whose folder starts with the same text must not count as being under it.
    const sibling = await write(`projects/${LONG}-sibling`, "Sibling Note");
    const short = await write("misc", "Short One");
    expect(deep.permalink.length).toBeGreaterThan(50);

    const permalinks = async (args: Parameters<typeof stub.search>[1]) => {
      const r = await stub.search(ref, args);
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return r.value.hits.map((h) => h.permalink).sort();
    };

    // Permalink mode: exact, prefix, wildcard in the middle, memory:// URL (with and without project).
    expect(await permalinks({ query: deep.permalink, mode: "permalink" })).toEqual([deep.permalink]);
    expect(await permalinks({ query: `projects/${LONG}`, mode: "permalink" })).toEqual([deep.permalink, deeper.permalink, sibling.permalink].sort());
    expect(await permalinks({ query: `projects/${LONG}/*child`, mode: "permalink" })).toEqual([deeper.permalink]);
    expect(await permalinks({ query: `projects/${LONG}/?uarterly*`, mode: "permalink" })).toEqual([deep.permalink]);
    expect(await permalinks({ query: `memory://${deep.permalink}` })).toEqual([deep.permalink]);
    expect(await permalinks({ query: `memory://main/${deep.permalink}` })).toEqual([deep.permalink]);
    expect(await permalinks({ query: `projects/${LONG}/no-such-note`, mode: "permalink" })).toEqual([]);
    // Short patterns still take the SQL path.
    expect(await permalinks({ query: "misc/*", mode: "permalink" })).toEqual([short.permalink]);
    // Title mode: a long substring.
    expect(await permalinks({ query: "planning notes for the long folder", mode: "title" })).toEqual([deep.permalink]);

    const tooLong = await stub.search(ref, { query: "x".repeat(LONG_PATTERN_MAX + 1), mode: "permalink" });
    expect(tooLong).toMatchObject({ ok: false, code: "INVALID" });

    // build_context with a long glob: by permalink, by file path, and by title (slug form), paged.
    const ctx = async (identifier: string, page_size?: number, page?: number) => {
      const r = await stub.buildContext(ref, { identifier, page_size, page });
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return { permalinks: r.value.primary.map((p) => p.permalink).sort(), has_more: r.value.has_more };
    };
    expect((await ctx(`projects/${LONG}/*`)).permalinks).toEqual([deep.permalink, deeper.permalink].sort());
    expect((await ctx(`memory://main/projects/${LONG}/*.md`)).permalinks).toEqual([deep.permalink, deeper.permalink].sort());
    expect((await ctx("Quarterly Planning Notes For The Long*")).permalinks).toEqual([deep.permalink]);
    const p1 = await ctx(`projects/${LONG}*`, 2, 1);
    const p2 = await ctx(`projects/${LONG}*`, 2, 2);
    expect(p1.has_more).toBe(true);
    expect(p2.has_more).toBe(false);
    expect([...p1.permalinks, ...p2.permalinks].sort()).toEqual([deep.permalink, deeper.permalink, sibling.permalink].sort());
    expect(await stub.buildContext(ref, { identifier: `${"y".repeat(LONG_PATTERN_MAX)}*` })).toMatchObject({ ok: false, code: "INVALID" });

    // Folder prefixes: count, list, find, move.
    expect(await stub.countUnder(ref, `projects/${LONG}`)).toBe(2);
    const listed = await stub.listDirectory(ref, { path: `projects/${LONG}` });
    expect(listed.notes.map((n) => n.permalink)).toEqual([deep.permalink]);
    expect(listed.folders.map((f) => f.name)).toEqual(["sub"]);
    const parent = await stub.listDirectory(ref, { path: "projects" });
    expect(parent.folders.map((f) => f.name).sort()).toEqual([LONG, `${LONG}-sibling`]);
    const found = await stub.find(ref, { path: `projects/${LONG}` });
    if (!found.ok) throw new Error(found.message);
    expect(found.value.results.map((r) => r.permalink).sort()).toEqual([deep.permalink, deeper.permalink].sort());

    const moved = await stub.moveFolder(ref, who, { path: `projects/${LONG}`, destination: `archive/${LONG}`, max: 10 });
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.value).toMatchObject({ moved: 2, remaining: 0 });
    expect(await stub.countUnder(ref, `archive/${LONG}`)).toBe(2);
    expect(await stub.countUnder(ref, `projects/${LONG}-sibling`)).toBe(1);
  });
});

describe("long-pattern fallback has a work cutoff and search admission (roundup item 4)", () => {
  it("stops after globScanMax notes and says so; build_context admits long patterns like a search", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    const who = caller(user);
    for (let i = 0; i < 12; i++) {
      const w = await stub.writeNote(ref, who, { directory: "bulk", title: `Note ${String(i).padStart(2, "0")}`, content: `n${i}` });
      if (!w.ok) throw new Error(w.message);
    }
    expect(await stub.setLimitsForTest({ globScanMax: 5 })).toBe(true);
    // No literal prefix, matches nothing, longer than 50 bytes: the worst case for the fallback.
    const miss = `*${"q".repeat(60)}*`;

    const s = await stub.search(ref, { query: miss, mode: "permalink" });
    if (!s.ok) throw new Error(s.message);
    expect(s.value.hits).toEqual([]);
    expect(s.value.notes?.some((n) => n.includes("stopped after looking at 5 notes"))).toBe(true);

    const c = await stub.buildContext(ref, { identifier: miss });
    expect(c).toMatchObject({ ok: false, code: "NOT_FOUND" });
    if (!c.ok) expect(c.message).toContain("among the first 5 notes");

    // A long pattern whose matches lie past the cap: the page it found is flagged incomplete.
    const hit = `bulk/note-*${"*".repeat(45)}`; // matches every note, past 50 bytes
    const found = await stub.buildContext(ref, { identifier: hit, page_size: 50 });
    if (!found.ok) throw new Error(found.message);
    expect(found.value.primary.length).toBeLessThanOrEqual(5);
    expect(found.value.incomplete).toEqual({ scanned: 5 });

    // Short patterns stay on SQLite: never cut off.
    const short = await stub.buildContext(ref, { identifier: "bulk/*", page_size: 50 });
    if (!short.ok) throw new Error(short.message);
    expect(short.value.primary).toHaveLength(12);
    expect(short.value.incomplete).toBeUndefined();

    // Admission: when the owner's search limit is spent, a long pattern is refused; a short one is not.
    await stub.setFaults(["search-limited"]);
    expect(await stub.buildContext(ref, { identifier: miss })).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect((await stub.buildContext(ref, { identifier: "bulk/*" })).ok).toBe(true);
    await stub.setFaults([]);
  });
});
