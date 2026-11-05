import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/directory";
import { outlineLine, outlineOf } from "../src/markdown/outline";
import { caller, defaultVault, makeUser } from "./helpers";
import { callTool, mcp } from "./oauth";

// Shaped like the eval's multi-part failure: a plan note whose later sections enumerate items that a
// summary of the first sections tends to drop.
const PLAN = `---
title: Fleet right-sizing
type: project
---
# Fleet right-sizing

## Why
- The main host has 16 GB and swaps under load
- The workload is memory-bound

## Plan
1. Upsize the main host to 32 GB
2. Move third-party apps to their own host

## Retire
- Decommission the old test host
- Decommission the unused CRM droplet

## Cost

| item | before | after |
|---|---|---|
| hosts | 190 | 361 |

\`\`\`
## not a heading (code)
- not an item
\`\`\`

- relates_to [[Hardware analysis]]
- part_of [[Ops 2026]]
`;

describe("outlineOf", () => {
  it("lists headings with their line, list items and table rows; skips frontmatter and code", () => {
    const o = outlineOf(PLAN);
    expect(o.entries.map((e) => [e.line, e.level, e.heading, e.items, e.rows])).toEqual([
      [5, 1, "Fleet right-sizing", 0, 0],
      [7, 2, "Why", 2, 0],
      [11, 2, "Plan", 2, 0],
      [15, 2, "Retire", 2, 0],
      [19, 2, "Cost", 2, 1],
    ]);
    expect(outlineLine(o)).toBe(
      "L5 # Fleet right-sizing · L7 ## Why (2 items) · L11 ## Plan (2 items) · L15 ## Retire (2 items) · L19 ## Cost (2 items; table, 1 row)",
    );
    const many = Array.from({ length: 45 }, (_, i) => `## S${i}\n- x`).join("\n");
    expect(outlineOf(many).omitted).toBe(5);
    expect(outlineLine(outlineOf(many))).toMatch(/\+5 more headings$/);
  });
});

describe("answer pack", () => {
  it("top search hits carry the outline and links; later hits, grep mode and partial reads don't", async () => {
    const { user } = await makeUser("pack");
    const v = await defaultVault(user.id);
    const w = await v.stub.writeNote(v.ref, caller(user), { directory: "projects", title: "Fleet right-sizing", content: PLAN });
    if (!w.ok) throw new Error(w.message);
    for (let i = 0; i < 4; i++)
      await v.stub.writeNote(v.ref, caller(user), {
        directory: "misc",
        title: `Fleet note ${i}`,
        content: `# Fleet note ${i}\n\n## A\n- fleet a\n\n## B\n- fleet b`,
      });
    const pat = await createPat(env, user.id, "t", ["memory:read"], null);

    const r = await v.stub.search(v.ref, { query: "fleet right-sizing decommission", page_size: 10 });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.hits[0].permalink).toBe(w.value.note.permalink);
    expect(r.value.hits[0].outline?.entries.find((e) => e.heading === "Retire")?.items).toBe(2);
    expect(r.value.hits[0].relations).toEqual([
      { type: "relates_to", target: "Hardware analysis" },
      { type: "part_of", target: "Ops 2026" },
    ]);
    expect(r.value.hits.slice(3).every((h) => !h.outline && !h.relations)).toBe(true);

    const t = (await callTool(pat, "search_notes", { query: "fleet right-sizing decommission" })).content[0].text;
    expect(t).toContain("outline: L5 # Fleet right-sizing · L7 ## Why (2 items)");
    expect(t).toContain("L15 ## Retire (2 items)");
    expect(t).toContain("links: relates_to [[Hardware analysis]], part_of [[Ops 2026]]");
    // Only the first three results shown carry it.
    expect(t.match(/ {3}outline: /g)?.length).toBeLessThanOrEqual(3);

    // Grep-style (lines) and one-note searches stay as they were.
    const grep = await v.stub.search(v.ref, { query: "decommission", lines: 1 });
    if (!grep.ok) throw new Error(grep.message);
    expect(grep.value.hits.every((h) => !h.outline)).toBe(true);

    // Whole-note reads start with the outline (text and JSON); a partial read doesn't.
    const whole = (await callTool(pat, "read_note", { identifier: w.value.note.permalink })).content[0].text;
    expect(whole.split("\n")[3]).toBe(
      "outline: L5 # Fleet right-sizing · L7 ## Why (2 items) · L11 ## Plan (2 items) · L15 ## Retire (2 items) · L19 ## Cost (2 items; table, 1 row)",
    );
    const j = JSON.parse((await callTool(pat, "read_note", { identifier: w.value.note.permalink, output_format: "json" })).content[0].text);
    expect(j.outline).toHaveLength(5);
    const part = (await callTool(pat, "read_note", { identifier: w.value.note.permalink, section: "Retire" })).content[0].text;
    expect(part).not.toContain("outline:");

    const init = await mcp(pat, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.instructions).toContain("check every listed item you need made it into the answer");
  });
});
