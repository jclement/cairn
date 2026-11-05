// bm_schema fix 2 (.lead/reports/review-schemafix.md): frontmatter values inside the work budget,
// valid bounded JSON with continuation, explicit incompleteness, severity-preserving overflow.
// The CPU-bound cases also run in scripts/probe-schema-parser.mjs under an isolated 2 s deadline.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/directory";
import { diffSchema, diffText as diffSchemaText, parsePicoschema, parseSchemaNote, type SchemaNote, validateNote, WORK, Work } from "../src/schema/picoschema";
import { caller, defaultVault, makeUser } from "./helpers";
import { mcp } from "./oauth";

async function call(token: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  const text: string = r.error ? String(r.error.message) : (r.result.content?.[0]?.text ?? "");
  return { text, isError: !!r.error || !!r.result.isError };
}

const note = (frontmatter: Record<string, unknown>, extra: Partial<SchemaNote> = {}): SchemaNote => ({
  permalink: "n",
  title: "n",
  file_path: "n.md",
  type: "t",
  frontmatter,
  observations: [],
  relations: [],
  ...extra,
});
const big = Array.from({ length: 100_000 }, () => "bad");

describe("1. frontmatter values can't escape the work budget", () => {
  it("Codex's repro: 200 declarations of one field are refused", () => {
    const schema = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`x(array, variant ${i})`, "integer"]));
    expect(JSON.stringify(schema).length).toBeLessThan(16 * 1024);
    expect(() => parsePicoschema(schema)).toThrow(/field "x" is declared more than once/);
    expect(() => parsePicoschema({ x: "string", "X?": "string" })).toThrow(/declared more than once/);
  });

  it("200 fields over 100,000-element arrays: bounded checks, reported incomplete, never valid", () => {
    const fields = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}(array)`, "integer"]));
    const fm = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, big]));
    const schema = parseSchemaNote({ entity: "t", schema: fields }, "s");
    const t0 = performance.now();
    const work = new Work(WORK.perCall);
    const r = validateNote(note(fm), schema, undefined, work);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.complete).toBe(false);
    expect(r.incomplete?.join(" ")).toMatch(/more than 100 values/);
    expect(r.incomplete?.join(" ")).toMatch(/needs more checks than one note is allowed/);
    expect(WORK.perCall - work.left).toBeLessThanOrEqual(WORK.perNote);
  }, 2000);

  it("multi-note diff over large arrays stays within the call budget and says when it stopped", () => {
    const one = parseSchemaNote({ entity: "t", schema: { "x(array)": "integer" } }, "s");
    const two = parseSchemaNote({ entity: "t", schema: { "x(array)": "integer", "y(array)": "integer" } }, "s");
    const notes = Array.from({ length: 500 }, (_, i) => ({ ...note({ x: big, y: big }), permalink: `n${i}` }));
    const t0 = performance.now();
    const a = diffSchema(one, "t", notes);
    // 500 × (1 + 100) checks fit in the budget, but only 100 of each array's values were compared:
    // that is not complete (review-roundup finding 3).
    expect(a.complete).toBe(false);
    expect(a.incomplete?.join(" ")).toMatch(/frontmatter x has more than 100 values/);
    const b = diffSchema(two, "t", notes);
    expect(b.complete).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(a.type_mismatches.length).toBeLessThanOrEqual(101);
  }, 2000);
});

describe("roundup 3: diff never calls a capped comparison complete", () => {
  it("100 valid values then an invalid 101st: incomplete, not 'no drift'", () => {
    const schema = parseSchemaNote({ entity: "t", schema: { "x(array)": "integer" } }, "s");
    const values = [...Array.from({ length: 100 }, (_, i) => String(i)), "not-a-number"];
    const d = diffSchema(schema, "t", [note({ x: values })]);
    expect(d.type_mismatches).toEqual([]);
    expect(d.complete).toBe(false);
    expect(d.incomplete?.join(" ")).toMatch(/only the first 100 were compared/);
    expect(diffSchemaText(d)).not.toContain("No drift: the notes match the schema.");
    expect(diffSchemaText(d)).toContain("Incomplete: frontmatter x has more than 100 values");
    // Within the cap the same comparison is complete and catches the bad value.
    const small = diffSchema(schema, "t", [note({ x: ["1", "two"] })]);
    expect(small.complete).toBe(true);
    expect(small.type_mismatches[0]).toMatch(/"two" is not an integer/);
  });

  it("truncated note facts make the diff incomplete", () => {
    const schema = parseSchemaNote({ entity: "t", schema: { "x?": "string" } }, "s");
    const d = diffSchema(schema, "t", [note({}, { truncated: { observations: true } })]);
    expect(d.complete).toBe(false);
    expect(d.incomplete?.join(" ")).toMatch(/1 note\(s\) have more observations or relations/);
  });
});

describe("3. capped reads never pass as complete", () => {
  it("a required fact at position 201: incomplete, not valid (and not reported missing)", async () => {
    const { user } = await makeUser("sf2");
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), {
      identifier: "schema/Thing.md",
      content: "x",
      note_type: "schema",
      metadata: { title: "Thing", entity: "thing", schema: { must: "string", "rel?(array)": "Person" }, settings: { validation: "strict" } },
    });
    const filler = Array.from({ length: 200 }, (_, i) => `- [other] fact ${i}`).join("\n");
    await v.stub.writeNote(v.ref, caller(user), { title: "Deep", note_type: "thing", content: `${filler}\n- [must] here at 201` });
    const r = await call(pat, "check_schema", { command: "validate", identifier: "deep" });
    expect(r.text).toContain("- **deep** — incomplete");
    expect(r.text).toContain("incomplete: the note has more observations than are read per note");
    expect(r.text).toContain("incomplete: must: not among the observations read");
    expect(r.text).not.toContain("Missing required field: must");
    expect(r.text).toContain("Valid: 0");
    expect(r.text).toContain("Incomplete: 1");
  });

  it("a schema beyond the listed catalog is still found", async () => {
    const { user } = await makeUser("sf2c");
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const v = await defaultVault(user.id);
    for (const e of ["Oldest", "Middle", "Newest"]) {
      await v.stub.writeNote(v.ref, caller(user), {
        identifier: `schema/${e}.md`,
        content: "x",
        note_type: "schema",
        metadata: { title: e, entity: e, schema: { name: "string" } },
      });
    }
    await v.stub.writeNote(v.ref, caller(user), { title: "O1", note_type: "oldest", content: "- [name] o" });
    await v.stub.setLimitsForTest({ schemaCatalog: 2 });
    expect((await call(pat, "check_schema", { command: "validate", note_type: "Oldest" })).text).toContain("Notes: 1 | Valid: 1");
    expect((await call(pat, "check_schema", { command: "validate" })).text).toContain("more schema notes exist than are listed per call");
  });
});

describe("2. JSON stays valid and keeps its continuation", () => {
  it("a diagnostic-heavy report is split by bytes into parseable pages that cover every note", async () => {
    const { user } = await makeUser("sf2j");
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const v = await defaultVault(user.id);
    const fields = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${"f".repeat(80)}${i}`, "string"]));
    await v.stub.writeNote(v.ref, caller(user), {
      identifier: "schema/Wide.md",
      content: "x",
      note_type: "schema",
      metadata: { title: "Wide", entity: "wide", schema: fields },
    });
    for (let i = 0; i < 8; i++) await v.stub.writeNote(v.ref, caller(user), { title: `W${i}`, note_type: "wide", content: "x" });
    await v.stub.setLimitsForTest({ schemaReportBytes: 6000 });
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await call(pat, "check_schema", { command: "validate", note_type: "wide", output_format: "json", ...(cursor ? { cursor } : {}) });
      const j = JSON.parse(r.text) as { results: { note_identifier: string }[]; next_cursor: string | null };
      for (const x of j.results) {
        expect(seen.has(x.note_identifier)).toBe(false);
        seen.add(x.note_identifier);
      }
      cursor = j.next_cursor;
      pages++;
    } while (cursor && pages < 20);
    expect(seen.size).toBe(8);
    expect(pages).toBeGreaterThan(1);
  });
});

describe("4. overflowed diagnostics keep their severity", () => {
  const strict = parseSchemaNote({ entity: "person", schema: { "works_at?(array)": "Organization" }, settings: { validation: "strict" } }, "s");
  const rels = (n: number, type: string | null) => Array.from({ length: n }, (_, i) => ({ type: "works_at", target: `Co${i}`, targetType: type }));
  it("warning-only overflow stays a warning; mixed overflow counts each severity", () => {
    const warnOnly = validateNote(note({}, { relations: rels(21, null) }), strict);
    expect(warnOnly.passed).toBe(true);
    expect(warnOnly.errors).toEqual([]);
    expect(warnOnly.warnings.length).toBe(21);
    expect(warnOnly.warnings.at(-1)).toBe("…and 1 more warning(s)");
    expect(warnOnly.more_warnings).toBe(1);
    const mixed = validateNote(note({}, { relations: [...rels(20, null), ...rels(3, "person"), ...rels(2, null)] }), strict);
    expect(mixed.passed).toBe(false); // the wrong-type errors are beyond the 20 listed, but still errors
    expect(mixed.more_errors).toBe(3);
    expect(mixed.more_warnings).toBe(2);
    expect(mixed.errors).toEqual(["…and 3 more error(s)"]);
  });
});
