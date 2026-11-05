// help: the manual, generated from the registered tools' own schemas (so it can't drift from
// what the server accepts), plus a few concept pages. Page names follow Basic Memory's
// ("search-notes(3)", "note-format(7)"); a bare tool name ("search_notes") works too.

import { z } from "zod";
import { BM_NAMES } from "./names";

export interface ToolDoc {
  name: string;
  description: string;
  schema?: z.ZodType;
  annotations?: Record<string, unknown>;
}

interface JsonProp {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  anyOf?: JsonProp[];
  items?: JsonProp;
  minimum?: number;
  maximum?: number;
}

const CONCEPTS: Record<string, { summary: string; text: string }> = {
  "schema(7)": {
    summary: "Picoschema note schemas: schema notes, field syntax, how fields map to notes",
    text: `# schema(7)

A schema is a note with type: schema whose entity names the note type it describes:

---
title: Task
type: schema
entity: Task
version: 1
schema:
  description: string, what needs to be done
  status?(enum, current state): [active, blocked, done, abandoned]
  steps?(array): string, ordered steps
  current_step?: integer, which step we're on
  parent_task?: Task, parent task if this is a subtask
settings:
  validation: warn          # warn (default) or strict; anything else is refused
  frontmatter:
    tags?(array): string
---

## Fields
name: type, description      required          name?: type      optional
name?(array): type           several values    name?(enum): [a, b] one of these values
name?(object): {...}         nested (presence only)
Types: string, integer, number, boolean, any, or a capitalised note type (a relation).

## How fields map to a note
- A scalar or enum field is an observation: - [status] active. In Cairn a frontmatter key of the
  same name also counts (status: active), so a field needn't be written twice.
- A capitalised type is a relation: - parent_task [[Other Task]].
- settings.frontmatter declares frontmatter keys (presence, enum values, number types).
- Observations and relations the schema doesn't name are reported as info, never as problems.

## Which schema applies
1. An inline schema: {...} dict in the note's own frontmatter.
2. schema: Name — the schema note with that entity (or that permalink or title).
3. The schema note whose entity matches the note's type (Task matches type: task).

## Relations to other notes
A capitalised type (works_at?: Organization) checks the target too: a target of another type is a
problem (an error in strict mode); a target that doesn't exist yet is always only a warning, since
links to future notes are allowed.

## Limits
A schema is at most 16 KB, 200 fields, 4 levels of (object) nesting, 50 enum values; keys up to 200
characters, descriptions up to 500. Each note shows at most 20 problems ("…and N more"). One validate
call checks at most 200 notes and stops early after 1,000 problems, returning next_cursor; pass it
back as cursor to continue. infer and diff analyse at most 500 notes and say when they sampled.
A field is declared once (x, x? and x(array) are the same field). Checks are budgeted: a field
reads at most 100 frontmatter values, a note gets 5,000 checks, a call 100,000. A note whose checks
didn't all run (budget spent, more than 200 observations or relations, an over-long frontmatter
list) is reported "incomplete", never "valid", with what wasn't checked.

## Commands
check_schema(command="validate", note_type="Task")    every task against the Task schema
check_schema(command="validate", identifier="tasks/x") one note
check_schema(command="validate")                       every type that has a schema
check_schema(command="infer", note_type="person")      suggest a schema from usage (95%+ = required)
check_schema(command="diff", note_type="Task")         new, dropped and changed fields
`,
  },
  "note-format(7)": {
    summary: "the note format: frontmatter, observations, relations, qualifiers, memory:// URLs",
    text: `# note-format(7)

Cairn notes are Basic Memory notes: Markdown with optional YAML frontmatter.

## Frontmatter
- title — the note's name (default: the file name). [[Links]] resolve by title or permalink.
- type — note type, normalised to snake_case (Task -> task). search_notes note_types filters on it.
- tags — a list or "a, b". permalink — stable address; derived from folder + title when absent, and
  kept across moves. pinned: true — part of core memory (core_memory). Any other key is kept and can be
  matched with search_notes / find_notes filters.

## Observations
- [category] fact #tag (context)
  Categories are free text; search_notes categories=["decision"] finds them. A bullet with #tags but no
  category gets category Note. Checkboxes (- [ ], - [x]) and links (- [t](url)) are not observations.

## Authored time
Put a qualifier in an observation to say when it holds:
- [decision] @effective:2026-06-10 The cache layer uses Redis
- [deadline] @due:2026-10-20 Draft ready for review
- [stage] @valid:2026-10 Series B
- [decision] @effective[2026-06-10,2026-10-14) Launch on Friday
Kinds: valid (default), effective, occurred, due, mentioned. A year or month covers that span; a day
runs from that day onward; [start,end) ranges may be open at either end. Search them with search_notes
valid_at / valid_overlaps / time_kind. Cairn also reads "(since 2026-01-01)", "(until …)" and
"(expires …)" in the context; expired facts move to "## Superseded" overnight.

## Relations
- relation_type [[Target]] (context)    typed edge; a bare - [[Target]] is relates_to
[[Target]] in prose                     links_to
[text](other-note.md)                   links_to (relative links to .md files)
Links to notes that don't exist yet are fine; they resolve when the note appears.

## Sections
read_note / edit_note section names a heading: "Decisions", "Auth/Decisions" (under Auth),
"Decisions[1]" (the second Decisions heading: counting starts at 0). Matching ignores case.

## memory:// URLs
memory://<permalink>, memory://<folder>/<file>.md, memory://<title>; patterns for build_context:
memory://specs/*, memory://SPEC-24* (case-insensitive). A memory://<project>/... prefix naming the
current project is accepted.
`,
  },
  "cairn(7)": {
    summary: "how Cairn differs from Basic Memory: receipts, history, core memory, supersede",
    text: `# cairn(7)

Cairn keeps Basic Memory's note format and tool parameters (under its own tool names; BM_COMPAT
also registers the bm_* names) on Cloudflare, multi-user, with these differences:

- Receipts: every write returns "saved <project>/<permalink> rev <checksum8> at <time> — <url>".
  Quote it; no receipt means nothing was saved.
- History: every write is a revision with provenance (user, app, tool). Deletes go to a trash; the
  web app (Activity) can undo any change, or everything one app did since a time. delete_note is
  therefore recoverable, unlike Basic Memory's.
- Core memory: core_memory loads memory/index plus every pinned note within a byte budget. Call it at
  the start of a session.
- Superseding: supersede replaces a fact and keeps the old one under "## Superseded" with an
  @effective[start,end) range; search_notes as_of=YYYY-MM-DD searches memory as it was then.
- project is optional (the user's default project); Basic Memory requires it. Passing it is fine.
- Unsupported parameters are refused (INVALID) rather than ignored.
- Schemas: check_schema validates, infers and diffs Picoschema note schemas as Basic Memory does; a
  field may also be satisfied by a frontmatter key of the same name (Basic Memory reads only
  observations and relations), so status can live in frontmatter alone.
- Not available: workspaces, binary file reads (files
  are attachments: attach_file stores them and read_note lists their URLs), build_context note bodies
  (read chosen notes with read_note).
- Search: hybrid keyword + semantic fused by RRF and re-ranked by a small AI judge, which also
  says when nothing matches ("No note answers this directly").
- Limits: 1 MB a note, 50 MB an account (history included), 60 writes a minute.
`,
  },
};

const toolPage = (name: string) => `${name.replace(/_/g, "-")}(3)`;

function typeOf(p: JsonProp): string {
  if (p.enum) return p.enum.map((e) => JSON.stringify(e)).join(" | ");
  if (p.anyOf) return p.anyOf.map(typeOf).join(" | ");
  const t = Array.isArray(p.type) ? p.type.join(" | ") : (p.type ?? "any");
  if (t === "array" && p.items) return `array of ${typeOf(p.items)}`;
  return t;
}

function renderTool(d: ToolDoc): string {
  const lines = [
    `# ${toolPage(d.name)}`,
    "",
    "## NAME",
    "",
    `**${d.name}** — ${d.description.split(/(?<=\.)\s/)[0]}`,
    "",
    "## DESCRIPTION",
    "",
    d.description,
    "",
  ];
  if (d.schema) {
    const js = z.toJSONSchema(d.schema, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, JsonProp>; required?: string[] };
    const req = new Set(js.required ?? []);
    lines.push("## PARAMETERS", "");
    for (const [k, p] of Object.entries(js.properties ?? {})) {
      const range = p.minimum !== undefined || p.maximum !== undefined ? `, ${p.minimum ?? ""}..${p.maximum ?? ""}` : "";
      lines.push(`- **${k}** (${typeOf(p)}${range}, ${req.has(k) ? "required" : "optional"})${p.description ? ` — ${p.description}` : ""}`);
    }
    lines.push("", "Any other parameter is refused with INVALID (nothing is done).", "");
  }
  if (d.annotations?.readOnlyHint) lines.push("Read-only.");
  lines.push("", "## SEE ALSO", "", "- note-format(7), cairn(7)");
  return lines.join("\n");
}

function index(docs: ToolDoc[]): string {
  const lines = ["# Cairn manual", "", "Read a page with help(page=...).", "", "## Section 3 — MCP tools", ""];
  for (const d of [...docs].sort((a, b) => a.name.localeCompare(b.name))) lines.push(`- ${toolPage(d.name)} — ${d.description.split(/(?<=\.)\s/)[0]}`);
  lines.push("", "## Section 7 — Concepts", "");
  for (const [k, v] of Object.entries(CONCEPTS)) lines.push(`- ${k} — ${v.summary}`);
  return lines.join("\n");
}

function normalise(page: string): string {
  let p = page
    .trim()
    .replace(/^memory:\/\/man\//, "")
    .toLowerCase();
  // Basic Memory's names ("bm_search", "bm-search(3)") reach the Cairn tool's page.
  const old = /^(bm[-_][a-z]+)(\(3\))?$/.exec(p);
  const renamed = old ? BM_NAMES[old[1].replace(/-/g, "_")] : undefined;
  if (renamed) p = renamed;
  if (/\(\d\)$/.test(p)) return p.replace(/_/g, "-");
  return `${p.replace(/_/g, "-")}(${CONCEPTS[`${p}(7)`] ? 7 : 3})`;
}

export function manPage(docs: ToolDoc[], page?: string): { page: string; text: string } | null {
  if (!page) return { page: "index", text: index(docs) };
  const want = normalise(page);
  if (CONCEPTS[want]) return { page: want, text: CONCEPTS[want].text };
  const d = docs.find((x) => toolPage(x.name) === want);
  return d ? { page: want, text: renderTool(d) } : null;
}

export function manSearch(docs: ToolDoc[], query: string): { page: string; summary: string }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pages = [
    ...docs.map((d) => ({ page: toolPage(d.name), summary: d.description.split(/(?<=\.)\s/)[0], text: renderTool(d) })),
    ...Object.entries(CONCEPTS).map(([page, c]) => ({ page, summary: c.summary, text: c.text })),
  ];
  return pages.filter((p) => words.every((w) => p.text.toLowerCase().includes(w))).map(({ page, summary }) => ({ page, summary }));
}
