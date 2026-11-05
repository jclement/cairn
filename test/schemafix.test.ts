// check_schema hardening (.lead/reports/review-schema.md): bounded key parsing, structural caps,
// bounded reports with continuation, owner admission, move-undo commit guard, entity target types.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/directory";
import { parseFieldKey, parsePicoschema, parseSchemaNote, SCHEMA_LIMITS, SchemaError, validateNote } from "../src/schema/picoschema";
import { caller, defaultVault, makeUser } from "./helpers";
import { mcp } from "./oauth";

async function call(token: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  const text: string = r.error ? String(r.error.message) : (r.result.content?.[0]?.text ?? "");
  return { text, isError: !!r.error || !!r.result.isError, json: () => JSON.parse(text) as Record<string, unknown> };
}

describe("1. field keys parse in linear time", () => {
  // Deadline: this test's own timeout (2 s). The worker runtime has no child processes, so a
  // runaway parse would fail the test by timing out rather than hang the suite.
  it("adversarial keys are refused quickly", () => {
    const t0 = performance.now();
    const bad = [
      `x(object,${" ".repeat(30_000)}!`,
      `x(object,${" ".repeat(150)}!`,
      `x(enum,${" , ".repeat(60)}`,
      `${"a".repeat(199)}(`,
      `x?((((((((((array))))))))))`,
      `x(${"(".repeat(150)}`,
      `x(array,${"\t ".repeat(90)}`,
    ];
    for (let i = 0; i < 200; i++) for (const k of bad) expect(parseFieldKey(k)).toBeNull();
    expect(() => parsePicoschema({ [bad[0]]: "string" })).toThrow(SchemaError);
    expect(performance.now() - t0).toBeLessThan(1500);
  }, 2000);

  it("valid keys", () => {
    expect(parseFieldKey("name")).toEqual({ name: "name", optional: false, kind: null, description: null });
    expect(parseFieldKey("status?(enum, current state)")).toEqual({ name: "status", optional: true, kind: "enum", description: "current state" });
    expect(parseFieldKey("tags?(array)")).toEqual({ name: "tags", optional: true, kind: "array", description: null });
    expect(parseFieldKey("meta(object)")).toMatchObject({ kind: "object" });
    expect(parseFieldKey("x(list)")).toBeNull();
    expect(parseFieldKey("x(array) extra")).toBeNull();
    expect(parseFieldKey("9lives")).toBeNull();
    expect(parseFieldKey("k".repeat(SCHEMA_LIMITS.keyChars + 1))).toBeNull();
  });
});

describe("2. schemas are structurally bounded", () => {
  it("refuses oversize, wide, deep and long schemas before walking them", () => {
    const many = Object.fromEntries(Array.from({ length: SCHEMA_LIMITS.fields + 1 }, (_, i) => [`f${i}`, "string"]));
    expect(() => parsePicoschema(many)).toThrow(/at most 200 fields/);
    let deep: Record<string, unknown> = { leaf: "string" };
    for (let i = 0; i < SCHEMA_LIMITS.depth + 1; i++) deep = { [`n${i}(object)`]: deep };
    expect(() => parsePicoschema(deep)).toThrow(/nest at most/);
    expect(() => parsePicoschema({ "s(enum)": Array.from({ length: 51 }, (_, i) => `v${i}`) })).toThrow(/at most 50 values/);
    expect(() => parsePicoschema({ "s(enum)": ["x".repeat(101)] })).toThrow(/at most 100 characters/);
    expect(() => parsePicoschema({ x: `string, ${"d".repeat(600)}` })).toThrow(/too long/);
    expect(() => parsePicoschema({ [`x(array, ${"d".repeat(195)})`]: "string" })).toThrow(SchemaError);
    const big = { title: "Big", type: "schema", entity: "big", schema: { a: `string, ${"x".repeat(450)}` }, settings: { pad: "y".repeat(17_000) } };
    expect(() => parseSchemaNote(big, "schema/big")).toThrow(/at most 16 KB/);
    // A budget shared by schema and settings.frontmatter.
    const half = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`f${i}?`, "string"]));
    expect(() => parseSchemaNote({ entity: "x", schema: half, settings: { frontmatter: half } }, "s")).toThrow(/at most 200 fields/);
  });

  it("diagnostics are capped per note and reports continue with a cursor", async () => {
    const { user } = await makeUser("sfx");
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const v = await defaultVault(user.id);
    const fields = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, "string"]));
    await v.stub.writeNote(v.ref, caller(user), {
      identifier: "schema/Wide.md",
      content: "x",
      metadata: { title: "Wide", entity: "wide", schema: fields },
      note_type: "schema",
    });
    for (let i = 0; i < 12; i++) await v.stub.writeNote(v.ref, caller(user), { title: `W${i}`, note_type: "wide", content: "nothing" });
    await v.stub.setLimitsForTest({ schemaValidateNotes: 5, schemaDiagnostics: 50 });
    const first = (await call(pat, "check_schema", { command: "validate", note_type: "wide", output_format: "json" })).json();
    const results = first.results as { warnings: string[] }[];
    // 20 kept per note plus one "…and N more" line; the call stops once 50 diagnostics are in.
    expect(results[0].warnings.length).toBe(21);
    expect(results[0].warnings.at(-1)).toBe("…and 40 more warning(s)");
    expect(results.length).toBe(3);
    expect(first.next_cursor).toMatch(/^\d+$/);
    // Walk the cursor: every note is checked exactly once.
    const seen = new Set<string>();
    let cursor: unknown = null;
    for (let i = 0; i < 10; i++) {
      const r = (await call(pat, "check_schema", { command: "validate", note_type: "wide", output_format: "json", ...(cursor ? { cursor } : {}) })).json();
      for (const x of r.results as { note_identifier: string }[]) {
        expect(seen.has(x.note_identifier)).toBe(false);
        seen.add(x.note_identifier);
      }
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(12);
    const textRun = await call(pat, "check_schema", { command: "validate", note_type: "wide" });
    expect(textRun.text).toMatch(/more notes to check: check_schema\(command="validate", note_type="wide", cursor="\d+"\)/);
    expect((await call(pat, "check_schema", { command: "validate", note_type: "wide", cursor: "abc" })).text).toMatch(/^INVALID: cursor/);
    // infer and diff sample a bounded number of notes and say so.
    await v.stub.setLimitsForTest({ schemaAnalyzeNotes: 4 });
    expect((await call(pat, "check_schema", { command: "infer", note_type: "wide" })).text).toContain("(analysed 4 of 12 notes: a sample, bounded per call)");
    // Owner-level admission covers every command, identifier validation included.
    await v.stub.setFaults(["search-limited"]);
    for (const a of [
      { command: "validate", identifier: "w1" },
      { command: "infer", note_type: "wide" },
      { command: "diff", note_type: "wide" },
      { command: "validate" },
    ]) {
      expect((await call(pat, "check_schema", a)).text).toMatch(/^RATE_LIMITED/);
    }
    await v.stub.setFaults([]);
  });

  it("a poisoned schema note doesn't affect validating another type", async () => {
    const { user } = await makeUser("sfx2");
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), {
      identifier: "schema/Bad.md",
      content: "x",
      note_type: "schema",
      metadata: { title: "Bad", entity: "bad", schema: { [`x(object,${" ".repeat(5000)}!`]: "string" } },
    });
    await v.stub.writeNote(v.ref, caller(user), {
      identifier: "schema/Good.md",
      content: "x",
      note_type: "schema",
      metadata: { title: "Good", entity: "good", schema: { name: "string" } },
    });
    await v.stub.writeNote(v.ref, caller(user), { title: "G1", note_type: "good", content: "- [name] g" });
    expect((await call(pat, "check_schema", { command: "validate", note_type: "good" })).text).toContain("Notes: 1 | Valid: 1");
    expect((await call(pat, "check_schema", { command: "validate", note_type: "bad" })).text).toMatch(
      /^INVALID: schema note schema\/bad: schema: can't read field/,
    );
  });
});

describe("3. move undo re-checks the destination at commit", () => {
  it("a move that lands while the undo is in flight wins; the undo is a conflict", async () => {
    const { user } = await makeUser("sfx3");
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const v = await defaultVault(user.id);
    await call(pat, "write_note", { title: "Roamer", directory: "a", content: "x" });
    await call(pat, "move_note", { identifier: "a/roamer", destination: "b/" });
    const rev = (await v.stub.noteHistory(v.ref, "a/roamer"))!.revisions.find((r) => r.action === "move")!;
    const note = await v.stub.readNote(v.ref, { identifier: "a/roamer" });
    const sum = note.ok ? note.value.note.checksum : "";
    await v.stub.pauseAt("after-reserve");
    const undo = v.stub.revertRevision(v.ref, caller(user, "web", "web:revert"), rev.id, sum);
    await v.stub.untilPaused("after-reserve");
    // Another move commits meanwhile (same content, so the same checksum).
    await runInDurableObject(v.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE notes SET folder = 'c', file_path = 'c/Roamer.md' WHERE permalink = 'a/roamer'");
    });
    await v.stub.resumeAt("after-reserve");
    expect(await undo).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    const now = await v.stub.readNote(v.ref, { identifier: "a/roamer" });
    expect(now.ok && now.value.note.file_path).toBe("c/Roamer.md");
  });
});

describe("4. entity references check the target's type", () => {
  const schema = parseSchemaNote({ entity: "Person", schema: { "works_at?": "Organization" }, settings: { validation: "strict" } }, "schema/person");
  const note = (relations: { type: string; target: string; targetType: string | null }[], frontmatter: Record<string, unknown> = {}) => ({
    permalink: "people/dana",
    title: "Dana",
    file_path: "people/Dana.md",
    type: "person",
    frontmatter,
    observations: [],
    relations,
  });
  it("matching, wrong-type, unresolved and frontmatter-only targets", () => {
    expect(validateNote(note([{ type: "works_at", target: "Acme", targetType: "organization" }]), schema).passed).toBe(true);
    const wrong = validateNote(note([{ type: "works_at", target: "Sam", targetType: "person" }]), schema);
    expect(wrong.passed).toBe(false);
    expect(wrong.errors).toEqual(["Field works_at: [[Sam]] is a person, not a Organization"]);
    // A link to a note that doesn't exist yet is allowed by the format: a warning, even in strict mode.
    const pending = validateNote(note([{ type: "works_at", target: "NewCo", targetType: null }]), schema);
    expect(pending).toMatchObject({ passed: true, warnings: ["Field works_at: [[NewCo]] doesn't resolve to a note yet (expected a Organization)"] });
    const types: Record<string, string> = { Acme: "organization", Sam: "person" };
    expect(validateNote(note([], { works_at: "Acme" }), schema, (n) => types[n] ?? null).passed).toBe(true);
    expect(validateNote(note([], { works_at: "Sam" }), schema, (n) => types[n] ?? null).errors[0]).toMatch(/is a person, not a Organization/);
  });
});
