// BM parity round: Jeff's four Basic Memory skills (memory-notes, memory-continue, memory-capture,
// memory-tasks), replayed call by call as written, against Cairn's MCP surface; plus the contract
// details they rely on (strict parameters, JSON shapes, section indexes, time windows, move/find/man).
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPat, createVault } from "../src/directory";
import { mdLinkTarget, parseNote, parseQualifier, readAuthoredPoint } from "../src/markdown/parse";
import { supersede } from "../src/memory/supersede";
import { parsePicoschema } from "../src/schema/picoschema";
import { matchFilters } from "../src/vault/filters";
import { parseSince } from "../src/vault/time";
import { defaultVault, makeUser, ORIGIN } from "./helpers";
import { fetchWorker, mcp, setWorkerEnv } from "./oauth";

// Basic Memory's skills call the bm_* names: they run against Cairn with BM_COMPAT on.
beforeAll(() => setWorkerEnv({ BM_COMPAT: "true" }));
afterAll(() => setWorkerEnv(null));

type R = { text: string; isError: boolean; json: () => Record<string, unknown> };

/** Call a tool the way an agent sees it: protocol-level refusals count as errors too. */
async function call(token: string, name: string, args: Record<string, unknown>): Promise<R> {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  const text = r.error ? String(r.error.message) : (r.result.content?.[0]?.text ?? "");
  return { text, isError: !!r.error || !!r.result.isError, json: () => JSON.parse(text) as Record<string, unknown> };
}

/** A call the skill expects to succeed. */
async function ok(token: string, name: string, args: Record<string, unknown>): Promise<R> {
  const r = await call(token, name, args);
  if (r.isError) throw new Error(`${name}(${JSON.stringify(args)}) failed: ${r.text}`);
  return r;
}

async function newPat(scopes = ["memory:read", "memory:write"]) {
  const { user, cookie } = await makeUser("bmp");
  return { user, cookie, pat: await createPat(env, user.id, "skill-replay", scopes, null) };
}

const P = { project: "main" };

/** memory-tasks' schema note, exactly as the skill gives it. */
const TASK_SCHEMA = `---
title: Task
type: schema
entity: Task
version: 1
schema:
  description: string, what needs to be done
  status?(enum, current state): [active, blocked, done, abandoned]
  assigned_to?: string, who is working on this
  steps?(array): string, ordered steps to complete
  current_step?: integer, which step number we're on (1-indexed)
  context?: string, key context needed to resume after memory loss
  started?: string, when work began
  completed?: string, when work finished
  blockers?(array): string, what's preventing progress
  parent_task?: Task, parent task if this is a subtask
settings:
  validation: warn
---`;

describe("strict parameters", () => {
  it("refuses a parameter Cairn doesn't take, by name, and does nothing", async () => {
    const { pat } = await newPat();
    const w = await call(pat, "bm_write", { title: "Nope", content: "x", frobnicate: true, ...P });
    expect(w.isError).toBe(true);
    expect(w.text).toContain('does not take "frobnicate"');
    expect((await call(pat, "bm_read", { identifier: "nope", ...P })).text).toContain("NOT_FOUND");
    const s = await call(pat, "bm_search", { query: "x", review_mode: "raw", ...P });
    expect(s.isError).toBe(true);
    expect(s.text).toContain('"review_mode"');
    expect((await call(pat, "bm_context", { identifier: "x", depth: 6, ...P })).isError).toBe(true);
  });

  it("refuses time windows it can't read instead of searching all time", async () => {
    const { pat } = await newPat();
    for (const since of ["7d", "24h", "3 days", "1 week", "2 weeks ago", "today", "yesterday", "last week", "1 month", "2026-10-01"]) {
      await ok(pat, "bm_project", { command: "recent", since, ...P });
    }
    const bad = await call(pat, "bm_project", { command: "recent", since: "a while back", ...P });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/INVALID: "a while back" is not a time window/);
  });
});

describe("memory-notes skill, replayed", () => {
  it("writes, finds observations by category, edits by section, reads by checksum, moves", async () => {
    const { pat } = await newPat();
    expect((await ok(pat, "bm_project", { command: "list" })).text).toContain("main (default)");
    for (const q of ["Kubernetes Migration", "k8s migration", "container migration"]) await ok(pat, "bm_search", { query: q, ...P });

    const created = await ok(pat, "bm_write", {
      title: "API Design Decisions",
      directory: "architecture",
      tags: ["api", "architecture"],
      content:
        "# API Design Decisions\n\nThe API team evaluated REST and GraphQL.\n\n## Observations\n- [decision] Use REST for public API #api\n- [requirement] Support API versioning from v1\n- [status] draft\n\n## Relations\n- implements [[API Specification]]\n- relates_to [[Backend Architecture]]\n",
      ...P,
    });
    expect(created.text).toMatch(/^saved main\/architecture\/api-design-decisions rev/);
    expect(created.text).toContain("file_path architecture/API Design Decisions.md");

    // Categories are queryable: bm_search(items=["observation"], categories=["decision"]) with no query.
    const decisions = await ok(pat, "bm_search", { items: ["observation"], categories: ["decision"], ...P });
    expect(decisions.text).toContain("[decision] Use REST for public API #api");
    expect(decisions.text).not.toContain("[requirement]");

    await ok(pat, "bm_edit", {
      identifier: "API Design Decisions",
      command: "insert_after_section",
      section: "Observations",
      content: "- [decision] Switched to OpenAPI 3.1 for spec generation #api",
      ...P,
    });
    await ok(pat, "bm_edit", {
      identifier: "API Design Decisions",
      command: "find_replace",
      find_text: "- [status] draft",
      content: "- [status] approved",
      ...P,
    });
    await ok(pat, "bm_edit", {
      identifier: "API Design Decisions",
      command: "insert_after_section",
      section: "Relations",
      content: "- depends_on [[Rate Limiter]]",
      ...P,
    });
    await ok(pat, "bm_edit", { identifier: "API Design Decisions", command: "prepend", content: "> Updated 2026-05-28: auth approach finalized.\n", ...P });

    // Destructive edits: read as JSON, pass note["checksum"].
    const note = (await ok(pat, "bm_read", { identifier: "API Design Decisions", output_format: "json", ...P })).json();
    expect(note).toMatchObject({
      title: "API Design Decisions",
      permalink: "architecture/api-design-decisions",
      file_path: "architecture/API Design Decisions.md",
    });
    expect(note.checksum).toMatch(/^[0-9a-f]{64}$/);
    await ok(pat, "bm_edit", {
      identifier: "API Design Decisions",
      command: "replace_section",
      section: "Summary",
      content: "Concise, current summary of the decision and its rationale.",
      expected_checksum: note.checksum,
      ...P,
    });
    const stale = await call(pat, "bm_edit", { identifier: "API Design Decisions", command: "append", content: "x", expected_checksum: note.checksum, ...P });
    expect(stale.text).toMatch(/^REVISION_CONFLICT/);

    const read = await ok(pat, "bm_read", { identifier: "memory://architecture/api-design-decisions", ...P });
    expect(read.text).toContain("- [status] approved");
    expect(read.text).toContain("- [decision] Switched to OpenAPI 3.1");
    expect(read.text).toContain("- depends_on [[Rate Limiter]]");
    expect(read.text).toMatch(/^> Updated 2026-05-28/m);
    expect(read.text).toContain("## Summary\nConcise, current summary");

    // memory:// URLs, project-qualified URLs and folder patterns.
    expect((await ok(pat, "bm_context", { identifier: "memory://architecture/api-design-decisions", ...P })).text).toContain(
      "implements [[API Specification]]",
    );
    await ok(pat, "bm_context", { identifier: "memory://main/architecture/api-design-decisions", ...P });
    expect((await ok(pat, "bm_context", { identifier: "memory://architecture/*", ...P })).text).toContain("# API Design Decisions");

    // When a claim holds: qualifiers, searched by valid time.
    await ok(pat, "bm_write", {
      title: "Cache layer",
      directory: "decisions",
      content:
        "- [decision] @effective:2026-06-10 The cache layer uses Redis\n- [event] @occurred:2026-10-14 Launch sync moved the date to Thursday\n- [deadline] @due:2026-10-20 Draft ready for review\n- [stage] @valid:2026-10 Series B, about 200 employees\n- [decision] @effective[2026-06-10,2026-10-14) Launch on Friday\n- [note] Undated fact\n",
      ...P,
    });
    const july = await ok(pat, "bm_search", { valid_at: "2026-07-01", items: ["observation"], ...P });
    expect(july.text).toContain("The cache layer uses Redis");
    expect(july.text).toContain("Launch on Friday");
    expect(july.text).not.toContain("Undated fact");
    expect(july.text).not.toContain("Draft ready");
    const due = await ok(pat, "bm_search", { time_kind: "due", valid_overlaps: "[2026-10-14,2026-10-21)", items: ["observation"], ...P });
    expect(due.text).toContain("Draft ready for review");
    expect(due.text).not.toContain("Redis");

    // Moving: the permalink stays, so links keep resolving.
    const moved = await ok(pat, "bm_move", { identifier: "API Design Decisions", destination: "archive/api-design-decisions.md", ...P });
    expect(moved.text).toContain("from architecture/API Design Decisions.md to archive/api-design-decisions.md");
    const after = (await ok(pat, "bm_read", { identifier: "architecture/api-design-decisions", include_content: false, output_format: "json", ...P })).json();
    expect(after).toMatchObject({ permalink: "architecture/api-design-decisions", file_path: "archive/api-design-decisions.md" });

    // Overwrite by the file_path bm_read returned, with its checksum.
    const cur = (await ok(pat, "bm_read", { identifier: "architecture/api-design-decisions", output_format: "json", ...P })).json();
    const over = await ok(pat, "bm_write", {
      identifier: cur.file_path,
      title: "API Design Decisions",
      content: "# API Design Decisions\n\n- [decision] Use REST\n",
      overwrite: true,
      expected_checksum: cur.checksum,
      ...P,
    });
    expect(over.text).toMatch(/^updated main\/architecture\/api-design-decisions/);
  });
});

describe("memory-continue skill, replayed", () => {
  it("rebuilds context from the graph, recent activity and search", async () => {
    const { pat } = await newPat();
    await ok(pat, "bm_write", {
      title: "SPEC-24: Postgres Database Migration",
      directory: "specs",
      content: "# SPEC-24\n\n## Status\n- [status] in progress\n\n## Plan\nMove the async client refactor first.\n- requires [[Async Client Refactor]]\n",
      ...P,
    });
    await ok(pat, "bm_write", { title: "Async Client Refactor", content: "- [status] done\n- part_of [[SPEC-24: Postgres Database Migration]]", ...P });

    const ctx = await ok(pat, "bm_context", { identifier: "memory://SPEC-24*", depth: 2, since: "7d", ...P });
    expect(ctx.text).toContain("# SPEC-24: Postgres Database Migration");
    expect(ctx.text).toContain("Async Client Refactor");
    expect((await ok(pat, "bm_context", { identifier: "memory://topic-or-note-name", ...P }).catch((e) => ({ text: String(e) }))).text).toContain("NOT_FOUND");

    for (const since of ["3d", "today", "yesterday", "3 days", "1 week", "2 weeks", "1 month"]) {
      expect((await ok(pat, "bm_project", { command: "recent", since, ...P })).text).toContain("SPEC-24");
    }
    expect((await ok(pat, "bm_search", { query: "async client refactor", page_size: 10, ...P })).text).toContain("Async Client Refactor");
    const compact = await ok(pat, "bm_search", { query: "async client refactor", compact: true, ...P });
    expect(compact.text).not.toMatch(/^\s+\d+: /m);

    const spec = await ok(pat, "bm_read", { identifier: "SPEC-24: Postgres Database Migration", ...P });
    expect(spec.text).toContain("## Plan");
    const status = await ok(pat, "bm_read", { identifier: "SPEC-24: Postgres Database Migration", section: "Status", ...P });
    expect(status.text).toMatch(/\d+: - \[status\] in progress/);
    expect(status.text).not.toContain("## Plan");
    const slice = await ok(pat, "bm_read", { identifier: "specs/spec-24-postgres-database-migration", start_line: 1, end_line: 3, ...P });
    expect(slice.text).toContain("lines 1-3 of");

    await ok(pat, "bm_search", { query: "topic keywords", projects: ["main"] });
    expect((await ok(pat, "bm_search", { query: "refactor", all_projects: true })).text).toContain("Async Client Refactor");
  });
});

describe("memory-capture skill, replayed", () => {
  it("finds the thread note by thread_id and rewrites it in place", async () => {
    const { pat } = await newPat();
    const before = await ok(pat, "bm_search", { filters: { thread_id: "7c1d4a2e" }, ...P });
    expect(before.text).toMatch(/^No matches for those filters/);

    const first = await ok(pat, "bm_write", {
      title: "Visual identity — initial decisions",
      content: "# Visual identity — initial decisions\n\n## Observations\n- [decision] Accent color is orange #branding\n",
      directory: "threads",
      tags: ["branding", "design"],
      metadata: { thread_id: "7c1d4a2e" },
      ...P,
    });
    expect(first.text).toMatch(/^saved /);
    await ok(pat, "bm_write", { title: "Unrelated", content: "orange juice", metadata: { thread_id: "other" }, ...P });

    const found = (await ok(pat, "bm_search", { filters: { thread_id: "7c1d4a2e" }, output_format: "json", ...P })).json();
    const results = found.results as { permalink: string; file_path: string }[];
    expect(results.map((r) => r.permalink)).toEqual(["threads/visual-identity-initial-decisions"]);

    const existing = (await ok(pat, "bm_read", { identifier: results[0].permalink, output_format: "json", ...P })).json();
    const rewrite = await ok(pat, "bm_write", {
      identifier: existing.file_path,
      title: "Visual identity — initial decisions",
      content:
        "# Visual identity — initial decisions\n\n## Observations\n- [decision] Accent color is coral, warmer than the orange we tried first #branding\n",
      tags: ["branding", "design"],
      metadata: { thread_id: "7c1d4a2e" },
      overwrite: true,
      expected_checksum: existing.checksum,
      ...P,
    });
    expect(rewrite.text).toMatch(/^updated main\/threads\/visual-identity-initial-decisions/);
    const again = (await ok(pat, "bm_search", { filters: { thread_id: "7c1d4a2e" }, output_format: "json", ...P })).json();
    expect((again.results as unknown[]).length).toBe(1);
    const conflict = await call(pat, "bm_write", {
      identifier: existing.file_path,
      content: "x",
      overwrite: true,
      expected_checksum: existing.checksum,
      ...P,
    });
    expect(conflict.text).toMatch(/^REVISION_CONFLICT/);
  });
});

describe("memory-tasks skill, replayed", () => {
  it("creates tasks, queries them by frontmatter, updates metadata with a checksum, finds what's due", async () => {
    const { pat } = await newPat();
    const write = (title: string, status: string, extra = "") =>
      ok(pat, "bm_write", {
        title,
        directory: "tasks",
        note_type: "Task",
        metadata: {
          status,
          priority: status === "active" ? "high" : "low",
          assigned_to: "claude",
          current_step: 1,
          steps: ["First step", "Second step", "Third step"],
        },
        tags: ["task"],
        content: `# ${title}\n\n## Observations\n- [description] What needs to be done\n- [status] ${status}\n${extra}\n## Steps\n1. [ ] First concrete step\n2. [ ] Second concrete step\n\n## Context\nKey files.\n`,
        ...P,
      });
    await write("Descriptive task name", "active", "- [deadline] @due:2026-10-20 Draft ready for review\n");
    await write("Blocked task", "blocked", "- [blockers] Waiting on the API keys\n");
    await write("Old task", "done");

    const active = await ok(pat, "bm_search", { note_types: ["task"], filters: { status: "active" }, ...P });
    expect(active.text).toContain("Descriptive task name");
    expect(active.text).not.toContain("Blocked task");
    expect((await ok(pat, "bm_search", { note_types: ["Task"], ...P })).text).toContain("3 result(s)");
    expect((await ok(pat, "bm_search", { note_types: ["task"], filters: { status: "blocked" }, ...P })).text).toContain("Blocked task");
    expect((await ok(pat, "bm_search", { note_types: ["task"], filters: { assigned_to: "claude" }, ...P })).text).toContain("3 result(s)");
    expect((await ok(pat, "bm_search", { note_types: ["task"], filters: { status: { $in: ["active", "blocked"] } }, ...P })).text).toContain("2 result(s)");
    expect((await ok(pat, "bm_search", { query: "blockers", note_types: ["task"], ...P })).text).toContain("Blocked task");
    const dueThisWeek = await ok(pat, "bm_search", { note_types: ["task"], time_kind: "due", valid_overlaps: "[2026-10-14,2026-10-21)", ...P });
    expect(dueThisWeek.text).toContain("Descriptive task name");
    expect(dueThisWeek.text).not.toContain("Old task");

    const task = (await ok(pat, "bm_read", { identifier: "tasks/descriptive-task-name", output_format: "json", ...P })).json();
    await ok(pat, "bm_edit", {
      identifier: "tasks/descriptive-task-name",
      command: "set_metadata",
      metadata: { current_step: 3 },
      expected_checksum: task.checksum,
      ...P,
    });
    const step = (await ok(pat, "bm_find", { filters: { current_step: 3 }, fields: ["current_step", "status"], output_format: "json", ...P })).json();
    expect(step.results).toEqual([expect.objectContaining({ permalink: "tasks/descriptive-task-name", fields: { current_step: 3, status: "active" } })]);
    await ok(pat, "bm_edit", {
      identifier: "tasks/descriptive-task-name",
      command: "set_metadata",
      metadata: { status: "done", completed: "2026-11-04" },
      ...P,
    });
    expect((await ok(pat, "bm_search", { note_types: ["task"], filters: { status: "active" }, ...P })).text).toMatch(/^No matches/);

    // Schemas: no schema yet is NOT_FOUND with how to make one; infer suggests one from the tasks.
    const none = await call(pat, "bm_schema", { command: "validate", note_type: "Task", ...P });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/^NOT_FOUND: # No Schema Found for 'Task'/);
    const inferred = await ok(pat, "bm_schema", { command: "infer", note_type: "Task", ...P });
    expect(inferred.text).toContain("# Schema Inference: task");
    expect(inferred.text).toContain("- **description** (observation) — 100% (3/3) [required]");
    expect(inferred.text).toContain("  description: string");

    // The skill's schema note, written as the skill shows it (schema/Task.md).
    const schemaNote = await ok(pat, "bm_write", { identifier: "schema/Task.md", content: `${TASK_SCHEMA}\n# Task\n\nA unit of multi-session work.\n`, ...P });
    expect(schemaNote.text).toContain("file_path schema/Task.md");
    const valid = await ok(pat, "bm_schema", { command: "validate", note_type: "Task", ...P });
    expect(valid.text).toContain("# Schema Validation: Task");
    expect(valid.text).toContain("Notes: 3 | Valid: 3 | Warnings: 0 | Errors: 0");

    // A sloppy task: warnings, not errors (validation: warn).
    await ok(pat, "bm_write", {
      title: "Sloppy task",
      directory: "tasks",
      note_type: "Task",
      content: "- [status] someday\n- [current_step] two\n- [mood] tired\n- parent_task [[Blocked task]]\n",
      ...P,
    });
    const warned = await ok(pat, "bm_schema", { command: "validate", note_type: "Task", ...P });
    expect(warned.text).toContain("Notes: 4 | Valid: 4 | Warnings: 3 | Errors: 0");
    expect(warned.text).toContain("warning: Missing required field: description (expected [description] observation)");
    expect(warned.text).toContain('warning: Field status: "someday" is not one of [active, blocked, done, abandoned]');
    expect(warned.text).toContain('warning: Field current_step: "two" is not an integer');
    expect(warned.text).toContain("info: unmatched observations: [mood] ×1");
    const one = (await ok(pat, "bm_schema", { command: "validate", identifier: "tasks/sloppy-task", output_format: "json", ...P })).json();
    expect(one).toMatchObject({ total_notes: 1, valid_count: 1, warning_count: 3, error_count: 0 });
    expect((await ok(pat, "bm_schema", { command: "validate", ...P })).text).toContain("Notes: 4");

    const drift = await ok(pat, "bm_schema", { command: "diff", note_type: "Task", ...P });
    expect(drift.text).toContain("# Schema Drift: task");
    expect(drift.text).toContain("## New Fields (in notes but not in schema)");
    expect(drift.text).toMatch(/\*\*deadline\*\* \(observation\) — 25% \(1\/4\)/);
    expect(drift.text).toContain("## Type Mismatches");

    // Strict mode turns the same problems into errors.
    await ok(pat, "bm_edit", { identifier: "schema/Task.md", command: "set_metadata", metadata: { settings: { validation: "strict" } }, ...P });
    const strictRun = await ok(pat, "bm_schema", { command: "validate", note_type: "Task", ...P });
    expect(strictRun.text).toContain("Notes: 4 | Valid: 3 | Warnings: 0 | Errors: 3");
    expect(strictRun.text).toContain("- **tasks/sloppy-task** — invalid");
  });
});

describe("contract details", () => {
  it("bm_edit: section only for section commands, identity keys refused, metadata merges with any command, replace_subsections", async () => {
    const { pat } = await newPat();
    await ok(pat, "bm_write", { title: "Doc", content: "## A\none\n### A1\ndeep\n## B\ntwo\n", ...P });
    expect((await call(pat, "bm_edit", { identifier: "doc", command: "append", section: "A", content: "x", ...P })).text).toMatch(/^INVALID: section is for/);
    expect((await call(pat, "bm_edit", { identifier: "doc", command: "set_metadata", metadata: { title: "New" }, ...P })).text).toMatch(/identity/);
    expect(
      (await call(pat, "bm_edit", { identifier: "doc", command: "find_replace", find_text: "x", content: "y", expected_replacements: 0, ...P })).isError,
    ).toBe(true);
    await ok(pat, "bm_edit", { identifier: "doc", command: "append", content: "tail", metadata: { status: "x" }, ...P });
    await ok(pat, "bm_edit", { identifier: "doc", command: "replace_section", section: "A", content: "ONE", replace_subsections: false, ...P });
    const body = (await ok(pat, "bm_read", { identifier: "doc", ...P })).text;
    expect(body).toContain("status: x");
    expect(body).toContain("## A\nONE\n### A1\ndeep");
    expect(body).toMatch(/tail$/);
    // find_replace works on the body; frontmatter changes go through metadata.
    expect((await call(pat, "bm_edit", { identifier: "doc", command: "find_replace", find_text: "status: x", content: "status: y", ...P })).text).toMatch(
      /set_metadata/,
    );
  });

  it("bm_read: max_tokens cuts at a boundary and says where to continue; include_frontmatter=false", async () => {
    const { pat } = await newPat();
    const para = (n: number) => `Paragraph ${n} ${"word ".repeat(30)}`;
    await ok(pat, "bm_write", { title: "Long", content: [1, 2, 3, 4, 5, 6].map(para).join("\n\n"), ...P });
    const cut = await ok(pat, "bm_read", { identifier: "long", max_tokens: 60, ...P });
    expect(cut.text).toMatch(/next: start_line=\d+/);
    expect(cut.text).not.toContain("Paragraph 6");
    const nofm = await ok(pat, "bm_read", { identifier: "long", include_frontmatter: false, ...P });
    expect(nofm.text).not.toContain("title: Long");
    expect(nofm.text).toContain("Paragraph 1");
  });

  it("bm_write by path keeps the file name; bm_list paginates with glob and sort; bm_find globs names", async () => {
    const { pat } = await newPat();
    const w = await ok(pat, "bm_write", {
      identifier: "plans/launch-plan.md",
      content: "---\ntitle: Launch Plan\n---\n# Launch Plan\n",
      tags: "release, q4",
      ...P,
    });
    expect(w.text).toContain("file_path plans/launch-plan.md");
    expect(w.text).toMatch(/saved main\/plans\/launch-plan /);
    await ok(pat, "bm_write", { title: "Release Checklist", directory: "plans", content: "- [step] tag it", ...P });
    await ok(pat, "bm_write", { title: "Weekly meeting", directory: "plans/meetings", content: "notes", ...P });
    const list = await ok(pat, "bm_list", { path: "plans", glob: "*plan*", sort: "title_desc", ...P });
    expect(list.text).toContain("meetings/");
    expect(list.text).toContain("plans/launch-plan.md");
    expect(list.text).not.toContain("Release Checklist");
    const paged = await ok(pat, "bm_list", { path: "/", page_size: 1, ...P });
    expect(paged.text).toContain("plans/");
    expect((await ok(pat, "bm_find", { name: "*meeting*", ...P })).text).toContain("plans/meetings/Weekly meeting.md");
    expect((await ok(pat, "bm_find", { name: "*", path: "plans", depth: 1, ...P })).text).not.toContain("Weekly meeting");
    expect((await ok(pat, "bm_find", { filters: { tags: ["q4"] }, ...P })).text).toContain("launch-plan.md");
    expect((await call(pat, "bm_find", { name: "*", filters: { a: 1 }, ...P })).text).toMatch(/^INVALID/);
    expect((await call(pat, "bm_search", { filters: { a: { $regex: "x" } }, ...P })).text).toMatch(/unknown operator \$regex/);
  });

  it("bm_move and bm_delete handle folders; links survive a move", async () => {
    const { pat } = await newPat();
    await ok(pat, "bm_write", { title: "Alpha", directory: "drafts/2025", content: "see [[Beta]]", ...P });
    await ok(pat, "bm_write", { title: "Beta", directory: "drafts/2025/sub", content: "- [fact] b", ...P });
    expect((await call(pat, "bm_move", { identifier: "alpha", path: "drafts", destination: "x/", ...P })).text).toMatch(/^INVALID/);
    const m = await ok(pat, "bm_move", { path: "drafts/2025", destination: "archive/", ...P });
    expect(m.text).toContain("moved 2 note(s)");
    const alpha = (await ok(pat, "bm_read", { identifier: "drafts/2025/alpha", output_format: "json", include_content: false, ...P })).json();
    expect(alpha.file_path).toBe("archive/2025/Alpha.md");
    expect((await ok(pat, "bm_context", { identifier: "drafts/2025/alpha", ...P })).text).toContain("→ links_to Beta");
    expect((await call(pat, "bm_delete", { path: "archive", ...P })).text).toMatch(/recursive=true/);
    expect((await ok(pat, "bm_delete", { path: "archive", recursive: true, ...P })).text).toContain("deleted 2 note(s)");
    expect((await call(pat, "bm_read", { identifier: "drafts/2025/alpha", ...P })).text).toMatch(/^NOT_FOUND/);
  });

  it("a read-only grant can't move or delete folders; another user's project is out of reach", async () => {
    const a = await newPat();
    await createVault(env, a.user.id, "secret");
    await ok(a.pat, "bm_write", { title: "Hidden", content: "zzqx", project: "secret" });
    const ro = await createPat(env, a.user.id, "ro", ["memory:read"], null);
    expect((await call(ro, "bm_move", { path: "x", destination: "y/", ...P })).text).toMatch(/^FORBIDDEN/);
    expect((await call(ro, "bm_delete", { path: "x", recursive: true, ...P })).text).toMatch(/^FORBIDDEN/);
    const b = await newPat();
    expect((await call(b.pat, "bm_search", { query: "zzqx", projects: ["secret"] })).text).toMatch(/^NOT_FOUND/);
    expect((await call(b.pat, "bm_find", { name: "*", project: "secret" })).text).toMatch(/^NOT_FOUND/);
    expect((await ok(b.pat, "bm_search", { query: "zzqx", all_projects: true })).text).toMatch(/^No matches/);
    expect((await ok(a.pat, "bm_search", { query: "zzqx", all_projects: true })).text).toContain("secret/hidden");
  });

  it("bm_man is generated from the tools' schemas", async () => {
    const { pat } = await newPat();
    const index = (await ok(pat, "bm_man", {})).text;
    // The manual documents Cairn's names; Basic Memory's names still find the pages.
    for (const t of ["search-notes(3)", "move-note(3)", "find-notes(3)", "core-memory(3)", "check-schema(3)", "note-format(7)", "cairn(7)", "schema(7)"])
      expect(index).toContain(t);
    expect(index).not.toMatch(/bm-[a-z]+\(3\)/);
    const search = (await ok(pat, "bm_man", { page: "bm_search" })).text;
    expect(search).toContain("**filters**");
    expect(search).toContain("**valid_overlaps**");
    expect((await ok(pat, "bm_man", { page: "bm-edit(3)" })).text).toContain("**replace_subsections**");
    expect((await ok(pat, "bm_man", { query: "qualifier due" })).text).toContain("note-format(7)");
    expect((await call(pat, "bm_man", { page: "nope(3)" })).text).toMatch(/^NOT_FOUND/);
  });
});

describe("bm_schema details", () => {
  it("inline schemas, explicit references, frontmatter-satisfied fields, broken schemas", async () => {
    const { pat } = await newPat();
    await ok(pat, "bm_write", {
      identifier: "schemas/person.md",
      content:
        "---\ntitle: Person\ntype: schema\nentity: Person\nschema:\n  name: string, full name\n  works_at?: Organization\nsettings:\n  frontmatter:\n    status(enum): [active, alumni]\n---\n",
      ...P,
    });
    // status in frontmatter only satisfies a field (Cairn extension); a missing frontmatter key warns.
    await ok(pat, "bm_write", {
      title: "Dana Roe",
      directory: "people",
      note_type: "person",
      metadata: { name: "Dana Roe", status: "active" },
      content: "- works_at [[Acme]]",
      ...P,
    });
    await ok(pat, "bm_write", { title: "Sam Lee", directory: "people", note_type: "person", content: "- [name] Sam Lee", ...P });
    const people = await ok(pat, "bm_schema", { command: "validate", note_type: "Person", ...P });
    // Dana's [[Acme]] doesn't resolve to a note yet: a warning, alongside Sam's missing status.
    expect(people.text).toContain("Notes: 2 | Valid: 2 | Warnings: 2");
    expect(people.text).toContain("warning: Field works_at: [[Acme]] doesn't resolve to a note yet (expected a Organization)");
    expect(people.text).toContain("warning: Missing required frontmatter key: status");
    // Explicit reference by entity, on a note of another type.
    await ok(pat, "bm_write", { title: "Contractor", note_type: "contact", metadata: { schema: "Person" }, content: "hi", ...P });
    expect((await ok(pat, "bm_schema", { command: "validate", identifier: "contractor", ...P })).text).toContain("Missing required field: name");
    // Inline schema.
    await ok(pat, "bm_write", {
      title: "Standup",
      note_type: "meeting",
      metadata: { schema: { "attendees(array)": "string", "blockers?(array)": "string" } },
      content: "- [attendees] Paul\n- [attendees] Sarah",
      ...P,
    });
    expect((await ok(pat, "bm_schema", { command: "validate", identifier: "standup", ...P })).text).toContain("Notes: 1 | Valid: 1 | Warnings: 0");
    // A schema that fails to parse is refused, not silently passed.
    await ok(pat, "bm_write", {
      identifier: "schemas/bad.md",
      content: "---\ntitle: Bad\ntype: schema\nentity: Widget\nschema:\n  size: huge\nsettings:\n  validation: maybe\n---\n",
      ...P,
    });
    await ok(pat, "bm_write", { title: "W1", note_type: "widget", content: "x", ...P });
    expect((await call(pat, "bm_schema", { command: "validate", note_type: "Widget", ...P })).text).toMatch(
      /^INVALID: schema note schemas\/bad: settings.validation must be warn or strict/,
    );
    expect((await call(pat, "bm_schema", { command: "infer", ...P })).text).toMatch(/^INVALID: infer needs note_type/);
    expect((await call(pat, "bm_schema", { command: "infer", note_type: "nothing", ...P })).text).toMatch(/^NOT_FOUND/);
    expect((await call(pat, "bm_schema", { command: "diff", note_type: "Person", identifier: "x", ...P })).text).toMatch(/^INVALID/);
    const empty = await newPat();
    expect((await call(empty.pat, "bm_schema", { command: "validate", ...P })).text).toMatch(/^NOT_FOUND: No schemas defined in this project/);
  });

  it("parses Picoschema syntax", () => {
    const f = parsePicoschema({
      name: "string, full name",
      "email?": "string",
      "works_at?": "Organization, employer",
      "tags?(array)": "string",
      "status?(enum, current state)": ["active", "done"],
      "meta?(object)": { "source?": "string" },
      "aliases?": "string[]",
    });
    expect(f.map((x) => [x.name, x.required, x.type, x.isArray, x.isEnum, x.isEntityRef])).toEqual([
      ["name", true, "string", false, false, false],
      ["email", false, "string", false, false, false],
      ["works_at", false, "Organization", false, false, true],
      ["tags", false, "string", true, false, false],
      ["status", false, "string", false, true, false],
      ["meta", false, "object", false, false, false],
      ["aliases", false, "string", true, false, false],
    ]);
    expect(f[0].description).toBe("full name");
    expect(f[4]).toMatchObject({ enumValues: ["active", "done"], description: "current state" });
    expect(f[5].children[0]).toMatchObject({ name: "source", required: false });
    expect(() => parsePicoschema({ "bad key!": "string" })).toThrow(/can't read field/);
    expect(() => parsePicoschema({ x: "strng" })).toThrow(/unknown type/);
    expect(() => parsePicoschema({ "x(enum)": "a" })).toThrow(/needs a list/);
  });
});

describe("import keeps file names; markdown links are relations", () => {
  it("a Basic Memory file named in kebab-case stays so, and [x](other.md) links resolve", async () => {
    const { user, cookie } = await makeUser("bmimp");
    const v = await defaultVault(user.id);
    const zip = zipSync({
      "main/projects/garden-harvest-tracking-forecasting.md": strToU8(
        "---\ntitle: Garden Harvest Tracking & Forecasting\npermalink: main/projects/garden-harvest-tracking-forecasting\n---\n# Garden Harvest\n\nSee [the guide](../guides/setup-guide.md) and [[Cairn]].\n",
      ),
      "main/guides/setup-guide.md": strToU8("---\ntitle: Setup Guide\n---\n- [step] install\n"),
    });
    const fd = new FormData();
    fd.set("file", new Blob([zip], { type: "application/zip" }), "export.zip");
    const built = new Request("https://x/", { method: "POST", body: fd });
    const body = await built.arrayBuffer();
    const res = await fetchWorker("/app/api/import", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": built.headers.get("content-type") ?? "", "content-length": String(body.byteLength) },
      body,
    });
    expect(res.status).toBe(202);
    for (let i = 0; i < 20 && (await runDurableObjectAlarm(v.stub)); i++);
    const well = await v.stub.noteView(v.ref, "projects/garden-harvest-tracking-forecasting");
    if (!well.ok) throw new Error(well.message);
    expect(well.value.note.file_path).toBe("projects/garden-harvest-tracking-forecasting.md");
    expect(well.value.relations.find((r) => r.target === "guides/setup-guide")).toMatchObject({
      type: "links_to",
      resolved: { permalink: "guides/setup-guide" },
    });
    const guide = await v.stub.noteView(v.ref, "guides/setup-guide");
    expect(guide.ok && guide.value.backlinks.map((b) => b.permalink)).toEqual(["projects/garden-harvest-tracking-forecasting"]);
  });
});

describe("pure helpers", () => {
  it("reads authored-time qualifiers as Basic Memory writes them", () => {
    expect(parseQualifier("@effective:2026-06-10 The cache")).toMatchObject({ kind: "effective", start: "2026-06-10", end: null });
    expect(parseQualifier("@2026-06 a month")).toMatchObject({ kind: "valid", start: "2026-06-01", end: "2026-07-01" });
    expect(parseQualifier("@2026 a year")).toMatchObject({ start: "2026-01-01", end: "2027-01-01" });
    expect(parseQualifier("@effective[2026-06-10,) open")).toMatchObject({ start: "2026-06-10", end: null, ranged: true });
    expect(parseQualifier("@effective[,2026-10-14) open start")).toMatchObject({ start: null, end: "2026-10-14" });
    expect(parseQualifier('@occurred:"June 10, 2026" quoted')).toMatchObject({ kind: "occurred", start: "2026-06-10" });
    expect(parseQualifier("@occurred:yesterday relative")).toBeNull();
    expect(parseQualifier("ping @jeff about it, then @due:2026-10-20")).toMatchObject({ kind: "due", start: "2026-10-20" });
    expect(parseQualifier("mail me at a@b.com")).toBeNull();
    expect(readAuthoredPoint("2026-13")).toBeNull();
    const obs = parseNote("- [decision] @effective[2026-06-10,2026-10-14) Launch on Friday #x\n").observations[0];
    expect(obs).toMatchObject({ content: "Launch on Friday #x", timeKind: "effective", validFrom: "2026-06-10", validTo: "2026-10-14" });
    expect(parseNote("- [stage] @valid:2026-10 Series B\n").observations[0]).toMatchObject({ validFrom: "2026-10-01", validTo: null, timeEnd: "2026-11-01" });
  });

  it("supersede keeps an existing qualifier's start and a replacement's own time", () => {
    const r = supersede("- [decision] @effective:2026-06-10 Redis\n", { match: "Redis", replacement: "@effective:2026-11-01 Memcached", today: "2026-11-04" });
    if (!r.ok) throw new Error(r.message);
    expect(r.markdown).toContain("- [decision] @effective:2026-11-01 Memcached\n");
    expect(r.markdown).toContain("## Superseded\n- [decision] @effective[2026-06-10,2026-11-04) Redis");
  });

  it("markdown links to notes, relative to the note's folder", () => {
    expect(mdLinkTarget("../guides/setup-guide.md", "projects")).toBe("guides/setup-guide");
    expect(mdLinkTarget("Other%20Note.md#part", "a/b")).toBe("a/b/Other Note");
    expect(mdLinkTarget("https://x.com/a.md", "")).toBeNull();
    expect(mdLinkTarget("/abs.md", "")).toBeNull();
    expect(mdLinkTarget("../../up.md", "a")).toBeNull();
    expect(mdLinkTarget("image.png", "")).toBeNull();
    expect(parseNote("![pic](x.md)\n[ok](y.md)\n", "", "f").relations.map((r) => r.target)).toEqual(["f/y"]);
  });

  it("time windows and filters", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(parseSince("3 days", now)).toBe("2026-11-01T12:00:00.000Z");
    expect(parseSince("2 weeks ago", now)).toBe("2026-10-21T12:00:00.000Z");
    expect(parseSince("today", now)).toBe("2026-11-04T00:00:00.000Z");
    expect(parseSince("yesterday", now)).toBe("2026-11-03T00:00:00.000Z");
    expect(parseSince("last week", now)).toBe("2026-10-28T12:00:00.000Z");
    expect(parseSince("1m", now)).toBe("2026-10-05T12:00:00.000Z");
    expect(parseSince("", now)).toBeNull();
    expect(parseSince("soonish", now)).toBeUndefined();
    const fm = { status: "active", priority: 2, tags: ["a", "b"], schema: { confidence: 0.8 }, owner: null };
    expect(matchFilters(fm, { status: "Active" })).toBe(true);
    expect(matchFilters(fm, { tags: ["a", "b"] })).toBe(true);
    expect(matchFilters(fm, { tags: ["c"] })).toBe(false);
    expect(matchFilters(fm, { owner: null, missing: null })).toBe(true);
    expect(matchFilters(fm, { priority: { $gte: 2, $lt: 3 } })).toBe(true);
    expect(matchFilters(fm, { "schema.confidence": { $between: [0.5, 0.9] } })).toBe(true);
    expect(matchFilters(fm, { status: { $in: ["blocked"] } })).toBe(false);
    expect(matchFilters(fm, { tags: { $contains: "b" }, owner: { $exists: false } })).toBe(true);
  });
});
