import { describe, expect, it } from "vitest";
import { chunkNote, composeMarkdown, fileNameFor, findSection, parseNote, permalinkFor, slugify, stripProjectPrefix } from "../src/markdown/parse";

describe("frontmatter", () => {
  it.each([
    ["---\ntitle: Acme Corp\ntype: Org\ntags: [customer, b2b]\n---\n# Acme\n", { title: "Acme Corp", type: "org", tags: ["customer", "b2b"] }],
    ['---\ntitle: X\ntags: "a, #b ,c"\n---\nbody', { title: "X", type: "note", tags: ["a", "b", "c"] }],
    ["no frontmatter at all", { title: null, type: "note", tags: [] }],
    ["---\ntitle: 2026\n---\n", { title: "2026", type: "note", tags: [] }],
    ["---\ntype: Meeting Notes\n---\n", { title: null, type: "meeting_notes", tags: [] }],
  ])("parses %j", (md, want) => {
    const p = parseNote(md);
    expect({ title: p.title, type: p.type, tags: p.tags }).toEqual(want);
  });

  it("keeps unknown keys", () => {
    const p = parseNote("---\ntitle: T\nstatus: active\npinned: true\n---\n");
    expect(p.frontmatter.status).toBe("active");
    expect(p.frontmatter.pinned).toBe(true);
  });

  it("strips a project prefix that Basic Memory wrote into the permalink", () => {
    expect(parseNote("---\npermalink: main/projects/owg-css\n---\n", "main").permalink).toBe("projects/owg-css");
    expect(stripProjectPrefix("other/x", "main")).toBe("other/x");
  });

  it("composes frontmatter back with title first", () => {
    const md = composeMarkdown({ tags: ["a"], title: "T", custom: 1 }, "# T\n");
    expect(md).toBe("---\ntitle: T\ntags:\n  - a\ncustom: 1\n---\n# T\n");
    expect(parseNote(md).title).toBe("T");
  });
});

describe("observations", () => {
  const cases: [string, { category: string; content: string; tags: string[]; context: string | null }[]][] = [
    [
      "- [decision] Use Redis for the cache #infra (2026-06-10)",
      [{ category: "decision", content: "Use Redis for the cache #infra", tags: ["infra"], context: "2026-06-10" }],
    ],
    ["- [fact] Water boils at 100C", [{ category: "fact", content: "Water boils at 100C", tags: [], context: null }]],
    [
      "* [preference] Prefers email (since 2026-03; via call)",
      [{ category: "preference", content: "Prefers email", tags: [], context: "since 2026-03; via call" }],
    ],
    ["- [idea] f(x) is linear", [{ category: "idea", content: "f(x) is linear", tags: [], context: null }]],
    ["- [ ] a task", []],
    ["- [x] done task", []],
    ["- [-] cancelled", []],
    ["- [a link](https://example.com)", []],
    ["- plain bullet with #tag", [{ category: "Note", content: "plain bullet with #tag", tags: ["tag"], context: null }]],
    ["- plain bullet", []],
    ["```\n- [fact] in a code fence\n```", []],
  ];
  it.each(cases)("%s", (line, want) => {
    expect(parseNote(line).observations.map(({ category, content, tags, context }) => ({ category, content, tags, context }))).toEqual(want);
  });
});

describe("relations and wiki links", () => {
  it.each([
    ["- works_at [[Acme Corp]]", [{ type: "works_at", target: "Acme Corp", context: null }]],
    ["- Works At [[Acme Corp]] (since 2024)", [{ type: "works_at", target: "Acme Corp", context: "since 2024" }]],
    ["- [[Bare Link]]", [{ type: "relates_to", target: "Bare Link", context: null }]],
    ["- implements [[specs/Auth Spec|the spec]]", [{ type: "implements", target: "specs/Auth Spec", context: null }]],
    [
      "We met at [[Acme Corp]] and talked about [[Cairn]].",
      [
        { type: "links_to", target: "Acme Corp", context: null },
        { type: "links_to", target: "Cairn", context: null },
      ],
    ],
    ["- a long sentence that mentions [[Thing]] inline", [{ type: "links_to", target: "Thing", context: null }]],
    ["- [decision] adopt [[Vectorize]] for search", [{ type: "links_to", target: "Vectorize", context: null }]],
    ["`[[not a link]]` in code", []],
    ["```\n[[fenced]]\n```", []],
  ])("%s", (md, want) => {
    expect(parseNote(md).relations.map(({ line: _l, ...r }) => r)).toEqual(want);
  });

  it("records line numbers in the whole document", () => {
    const p = parseNote("---\ntitle: T\n---\n# T\n\n- uses [[X]]\n");
    expect(p.relations[0].line).toBe(6);
  });
});

describe("permalinks and file names", () => {
  it.each([
    ["", "Acme Corp", "acme-corp"],
    ["people", "Dana Roe", "people/dana-roe"],
    ["Projects/Big Things", "Café Déjà Vu!", "projects/big-things/cafe-deja-vu"],
    ["/a//b/", "C", "a/b/c"],
    ["", "???", "untitled"],
  ])("folder %j title %j -> %s", (folder, title, want) => {
    expect(permalinkFor(folder, title)).toBe(want);
  });

  it("slugify keeps non-latin letters", () => {
    expect(slugify("東京 メモ")).toBe("東京-メモ");
  });

  it("file names keep case and spaces but drop path separators", () => {
    expect(fileNameFor("Dana Roe")).toBe("Dana Roe.md");
    expect(fileNameFor("a/b:c")).toBe("a-b-c.md");
    expect(fileNameFor("../etc")).toBe("-etc.md");
  });
});

describe("sections", () => {
  const body = "# Title\nintro\n## Decisions\none\n### Sub\ndeep\n## Decisions\ntwo\n## Other\nx\n";
  it("finds the first section by name", () => {
    const r = findSection(body, "Decisions");
    expect(r).toEqual({ start: 2, end: 6, level: 2 });
  });
  it("supports [n] and parent/child paths", () => {
    // Basic Memory counts from 0: [1] is the second "Decisions", [0] the first.
    expect(findSection(body, "Decisions[1]")).toEqual({ start: 6, end: 8, level: 2 });
    expect(findSection(body, "Decisions[0]")).toEqual({ start: 2, end: 6, level: 2 });
    expect(findSection(body, "Decisions[2]")).toBeNull();
    expect(findSection(body, "Decisions/Sub")).toEqual({ start: 4, end: 6, level: 3 });
    expect(findSection(body, "## decisions")).not.toBeNull();
    expect(findSection(body, "Missing")).toBeNull();
  });
});

describe("chunking", () => {
  it("makes one chunk per bullet and splits prose by heading", () => {
    const chunks = chunkNote("Acme", "Intro text.\n## Facts\n- [a] one\n- [b] two\nMore prose.");
    expect(chunks.map((c) => c.kind)).toEqual(["prose", "observation", "observation", "prose"]);
    expect(chunks[1].text).toBe("Acme: [a] one");
    expect(chunks[3].text).toContain("Acme / Facts");
  });
});
