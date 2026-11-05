# Basic Memory: what it is, how it works, and what Cairn should take from it

Researched 2026-11-04 by the `bm` worker for cairn-lead.

Sources:
- Upstream repo `basicmachines-co/basic-memory` at `c143040` (2026-11-04), shortly after **v1.0.0
  (2026-10-29)**. Paths below are relative to that repo: https://github.com/basicmachines-co/basic-memory
- Jeff's live connector in this session (`mcp__claude_ai_Basic_Memory__bm_*`, project `main`), used
  **read-only**: `bm_man`, `bm_project list/recent`, `bm_list`, `bm_search`, `bm_context`,
  `bm_schema infer` and `bm_read`.
- Jeff's installed skills: `~/.local/share/claude-agent/global/skills/basic-memory/` (one wrapper
  plus four upstream skills pinned at `bf46a43`).
- GitHub issues, read with `gh`.

Anything marked *(inferred)* is my reading, not something a source states.

---

## 1. Data model

### The note is the unit, and the Markdown file is canonical

Every note is one Markdown file inside a **project**, which is a directory. The database is a
derived projection: entities, observations, relations, the FTS index and vectors "must be
rebuildable or reconcilable from canonical Markdown state" (`docs/DOMAIN_MODEL.md`). This
invariant is the core of the product. It is why export is trivial, why Obsidian and git work
alongside it, and why "no lock-in" is credible.

**Frontmatter** (`NOTE-FORMAT.md`):

| Field | Default | Meaning |
|---|---|---|
| `title` | filename stem | Display name; also how `[[wikilinks]]` resolve. Mutable, not identity. |
| `type` | `note` | Note type. Normalised to snake_case (`Task` → `task`). Drives schemas and `note_types` filters. |
| `tags` | `[]` | A list or a comma string. Searchable and filterable. |
| `permalink` | slug of directory + title | The stable semantic address. Survives moves unless `update_permalinks_on_move` is set. |
| `schema` | — | An inline Picoschema dict, or a string naming a schema note. |
| `created` / `modified` | file ctime/mtime | Canonical semantic timestamps (1.0). |
| `locked: true` | — | One-way write protection through the API (`docs/LOCKED_NOTES.md`). |
| `bm_parse_semantics: false` | — | Opts the note out of the graph. |
| anything else | — | Stored as `entity_metadata` (JSON) and queryable through `filters`. |

YAML is normalised: numbers and booleans become strings and dates become ISO strings. Aliases
and merge keys are refused.

**Observations** are list items that start with `[category]`:

```
- [category] content text #tag1 #tag2 (context)
- [decision] @effective:2026-06-10 The cache layer uses Redis
- [deadline] @due:2026-10-20 Draft ready for review
```

- The category is free text. Repeating a category is how "array" fields work.
- The parser excludes checkboxes (`- [ ]`, `- [x]`, `- [-]`) and Markdown links (`- [t](url)`).
- A bullet with `#tags` but no category gets category `Note`.
- New in 2026: **temporal qualifiers**. `@valid` (the default), `@effective`, `@occurred`, `@due`
  and `@mentioned` take points (`@2026-06`) or half-open ranges (`@effective[2026-06-10,)`). They
  are indexed into a `memory_time_index` table and searched with `valid_at`, `valid_overlaps` and
  `time_kind`. This is a bitemporal idea done in plain text, and it is good.

**Relations** come in three forms:

- `- relation_type [[Target]] (context)`. A typed, directed edge. A bare `- [[Target]]` gets
  `relates_to`.
- A `[[Target]]` inside prose becomes an implicit `links_to` edge. Upstream's own skill calls this
  `references`; the docs disagree.
- Since 1.0, ordinary Markdown links to files in the same project (`[guide](../g.md)`) also become
  `links_to` edges (`docs/MARKDOWN_RELATIONS.md`).

**Forward references:** a relation row keeps `to_name` (the author's text) with `to_id = NULL`
until a note with that title or permalink appears, and is then resolved. Deleting the target
**does not** delete inbound edges. They go back to unresolved with `to_name` intact. That is the
right call: the graph never hides a broken link that the Markdown still contains.

**Identity** (`models/knowledge.py`): `Entity` has an internal `id`, an `external_id` (a UUID
that is stable across moves and is the public API identity), `file_path` (unique per project),
`permalink`, `title`, `note_type`, `entity_metadata` (JSON), `checksum` (SHA-256 of the file),
`created_by` and `last_updated_by`. Further tables:

- `Observation`: category, content, context, tags.
- `Relation`: from_id, to_id, to_name, relation_type, context.
- `NoteSection`: heading tree with line and byte offsets. This powers `section=` reads and edits.
- `MemoryTimeIndex`: the temporal qualifiers.
- `NoteContent`: accepted Markdown bytes plus `db_version`/`file_version` for the cloud "DB-first,
  materialise to file later" flow.

There is also an **accepted change journal** with a per-project monotonic `partition_position`,
which feeds the cloud activity log and OKF export history.

**Wart seen in Jeff's data:** the permalinks that get stored include the project name.
`projects/owg-css.md` has `permalink: main/projects/owg-css` **written into the file's
frontmatter**. This leaks the project name into the portable file, so renaming or importing the
project silently produces a different address. It already causes bugs (issue #2021: permalink
search misses notes whose stored permalink lacks the prefix). Cairn should keep permalinks
project-relative.

### memory:// URLs

`memory://<permalink>`, `memory://<title>`, `memory://folder/*`, `memory://auth*`,
`memory://a/*/b`. A project prefix is allowed (`memory://main/specs/x`), but since 1.0 it
**must agree with** the required `project` parameter rather than select the project. These URLs
are just address syntax. Clients never fetch them as MCP resources, except for `memory://man/...`
pages.

### Projects and workspaces

A project is the isolation boundary: every row has `project_id`. Locally a project is a
configured directory. In Cloud, a **workspace** (Personal or Team) holds projects, and a project
is addressed as `name`, `workspace/name` or its external UUID. Cross-project links resolve only
when qualified, and "authorization of the source project does not grant access to the resolved
target" (DOMAIN_MODEL).

### How the index is derived

- **Local:** SQLite. Search is an FTS5 virtual table `search_index`. Each row is a note, an
  observation or a relation, keyed `(permalink, type, project_id)`.
- **Cloud:** Postgres (Neon), with generated `tsvector` columns, GIN indexes and a
  `script_ngrams` column for CJK (`models/search.py`).
- **Vectors:** `sqlite-vec` locally, and `pgvector` (or optionally Milvus) in Cloud. The default
  embedder is FastEmbed `bge-small-en-v1.5` (384 dimensions, local ONNX); OpenAI and LiteLLM are
  options.
- **Chunking** (`docs/semantic-search.md` §Chunking): each header starts a chunk, **each bullet
  is its own chunk** (so observations embed as atomic facts), and prose merges up to about 900
  characters. Chunks are keyed by SHA-256 `source_hash`, so unchanged chunks never re-embed.
- **Hybrid fusion** is score-based, not RRF: `max(vec, fts) + bonus * min(vec, fts)`. An optional
  reranker exists. Issue #1748 (benchmark RRF) and #1718 (weak vector matches leak into results)
  are open, so they are not sure this is right either.
- Sync locally is a file watcher plus checksum-based reconciliation. Cloud is "DB-first": the
  write is accepted into `NoteContent`, a worker materialises the file to Tigris S3, and the
  projections update after commit.

---

## 2. The MCP tool surface (1.0)

Since 1.0 there is exactly one tool per job, all prefixed `bm_`. The old tools are **deleted with
no aliases** (`CHANGELOG.md` v1.0.0; `man7/tools-migration(7).md`).

| Tool | Purpose | Key params |
|---|---|---|
| `bm_read` | Read a note or file | `identifier` (path, permalink, memory:// URL, title or external id); `section`; `start_line`/`end_line`; `max_tokens` (cuts at a section boundary and says where to continue); `include_content=false` (metadata + checksum only); `include_frontmatter` |
| `bm_write` | Create or replace | `identifier` (path) **or** `title`+`directory`; `content`; `tags`; `note_type`; `metadata` (merged into frontmatter); `overwrite`; `expected_checksum` (implies overwrite) |
| `bm_edit` | Partial edit | `command` ∈ `append`, `prepend`, `find_replace` (`find_text`, `expected_replacements`), `replace_section`, `insert_before_section`, `insert_after_section` (`section` such as `"Auth/Decisions"` or `"Decisions[1]"`), `set_metadata`; `replace_subsections`; `expected_checksum` |
| `bm_delete` | Delete a note or directory | `identifier` or `path` + `recursive`; `expected_checksum` |
| `bm_move` | Move or rename within a project | `identifier` or `path`, `destination` (trailing `/` means "into"), `expected_checksum`. Cross-project moves are refused here, but #2048 just added them |
| `bm_search` | Ranked search | `query` (phrases, AND/OR/NOT, `tag:x`); `mode` (`hybrid`, `text`, `semantic`, `title`, `permalink`); `filters` (Mongo-ish: `$gt/$in/$contains/$exists/$between`, dot paths); `note_types`; `items` (note, observation, relation); `categories`; `since`; `path`; `identifier`; `lines` (grep-style context); `compact`; `min_similarity`; temporal `valid_at`/`valid_overlaps`/`time_kind`; scope `project`, `projects` or `all_projects` |
| `bm_context` | Graph walk | `identifier` (note or pattern), `depth` 1–5, `since` (default **7d**), `max_related`, `compact`, paging |
| `bm_list` | One folder level | `path`, `glob`, `sort` |
| `bm_find` | Recursive find by filename glob **or** frontmatter filter | `name` or `filters` + `fields`, `depth` |
| `bm_project` | Projects | `command` ∈ `list`, `create`, `recent` (`since`, `items`); Cloud adds `info` |
| `bm_schema` | Picoschema | `command` ∈ `validate`, `infer` (`threshold`), `diff` |
| `bm_man` | Manual pages | `page` (`bm-search(3)`) or `query` (apropos) |
| `bm_project_delete` | Opt-in, off by default | — |
| Cloud only | `bm_agent` (scheduled agents that are notes of `type: agent`), `bm_log` (cursor-paged audit log of who changed what), `bm_review` (CriticMarkup comment and suggestion threads), `bm_open` (MCP Apps UI: gallery, note, search, graph), ChatGPT `search`/`fetch` | — |

Pre-1.0 names, which still appear in lots of blog posts and third-party skills:

- `write_note`, `read_note`, `read_content`, `view_note`, `edit_note`, `move_note`, `delete_note`
- `search_notes`, `build_context`, `recent_activity`
- `list_directory`, `list_memory_projects`, `create_memory_project`
- `canvas`
- `schema_validate`, `schema_infer`, `schema_diff`
- `sync_status`, `cloud_info`

Behaviours worth copying:

- **Optimistic concurrency everywhere.** Every mutating tool takes `expected_checksum` (the
  SHA-256 of the file as read). A mismatch is a typed `REVISION_CONFLICT` error.
- **Typed refusals:** `NOT_FOUND`, `ALREADY_EXISTS`, `REVISION_CONFLICT`, `LOCKED` and
  `OUTSIDE_PROJECT` are MCP tool errors, not empty successes. #1534 was the bug where "empty
  index" and "no match" looked the same; it is fixed.
- **Pagination:**
  - Search, recent and context use `page`/`page_size` with `has_more` and `total_is_exact`.
  - `bm_read` returns `has_more`, `next_start_line` and `next_end_line`.
  - Text output ends with the exact next call to make.
  - `bm_log` uses an opaque cursor.
- **Similar-note advisory on write:** `bm_write` lists near-duplicates so the agent can decide
  whether it meant to extend one instead.
- **The manual ships in the server.** `bm_man` serves man(1)/(3)/(7) pages that are generated
  from the tool schemas and checked by tests. Agents look up exact usage instead of guessing.
- **`required project`:** every scoped call must name the project, even when there is only one.
  This prevents silent wrong-project writes, at the cost of verbosity.

What the live server returned (Jeff's `main`, 264 entities):

- `bm_search` in JSON returns **the whole note body plus a `matched_chunk` that repeats most of
  it plus a title/permalink tail**. Three hits for "decision" came to about 12 KB, which is very
  token-heavy unless you pass `compact`.
- `compact` observation search returns only `title: "decision"` with **no observation text**,
  which makes it useless for its obvious purpose. You need `lines`, or a full search.
- `bm_context` depth 2 in compact text mode is concise and readable (about 15 lines), but it pulls
  in the neighbour's unrelated inbound edges (`[[Dana Roe]] works_at [[Acme Corp]]`). The
  defaults are `since=7d` and `depth=1`, so a cold call on an old note returns little.
- `bm_schema infer` works and is cheap: "works_at 89% (8/9)" for `person`.

### Schemas (Picoschema)

A schema is itself a note (`type: schema`, `entity: Person`, `schema:` dict in Google Dotprompt's
Picoschema notation, `settings.validation: warn`). Fields map onto **existing syntax**: a scalar
field is a `[field] value` observation, and a capitalised type (`works_at?: Organization`) is a
relation. Attachment order: an inline dict, then a string reference, then implicit by `type`.
Validation only warns; there are no hard rejects. `infer` proposes a schema from the frequency of
fields, and `diff` reports drift.

This is the cleverest part of the design. Structure is optional, sits on top of plain text, and
the agent learns no new syntax.

---

## 3. The skills: what actually makes it work

Upstream ships about 20 skills (`skills/`):

- notes, continue, capture, tasks, schema, reflect, defrag, curate, lifecycle
- ingest, research, metadata-search, onboarding, doctor, okf, comark, agents
- ci-capture, literary-analysis, quest

The plugins (`plugins/claude-code`, `plugins/codex`) add hooks: **SessionStart** briefs the agent
from the graph, and **PreCompact** checkpoints the session into a note.

Jeff runs four of them (notes, continue, capture, tasks) behind a wrapper skill. The wrapper is
where most of the practical value is, and it overrides upstream in important ways:

- **Default destination:** "note/remember" with no place named goes to BM. Write at once, with no
  question.
- **Save unprompted, but only from interactive sessions.** Decisions and why, meeting outcomes,
  research conclusions, and what a person cares about. Never from unattended workers or loops,
  which "would flood the store". This flatly overrides the server instruction "Do not write
  unprompted".
- **Name everything.** Put people, customers and projects in the title, the tags *and* the
  `[[relations]]`, so any of them finds the note.
- **One note per decision, meeting or topic, kept current.** Search first with several wordings,
  extend with `bm_edit`, and create a note only when nothing fits.
- **Never store secrets.** After saving, say in one line what was saved and where.

The behaviours that, in my judgement, make the system work in practice, in order:

1. **Search before write, then extend rather than duplicate.** Every upstream skill repeats this.
   Duplicates are the main way a memory store decays. The server helps with the similar-notes
   advisory on `bm_write`.
2. **Rewrite-in-place capture** (`memory-capture`). A thread note keyed by `thread_id`
   frontmatter is *re-synthesised*, not appended to. Superseded decisions are replaced inline and
   there is no changelog. Notes stay readable as current truth.
3. **A dual structured layer.** Prose for meaning; `[category]` observations and typed relations
   for precision; frontmatter `metadata` for `filters`. `memory-tasks` deliberately writes status
   both as frontmatter (for `filters`) and as an observation (for schema validation). That is
   redundancy the format forces on you, which is a design smell Cairn can fix.
4. **Checksum discipline:** read as JSON, keep `checksum`, pass `expected_checksum`, and re-read on
   conflict.
5. **Context rebuild at session start.** Use `bm_project recent` when the topic is unknown,
   `bm_context` on a `memory://` anchor when it is known, and `bm_search` otherwise.
6. **Pre-compaction flush.** Update the active task notes before context is lost.
7. **Periodic hygiene:** `memory-reflect` (fold recent activity into the right notes, 1–2 times a
   day) and `memory-defrag` (split bloated notes, merge scattered facts, retire stale ones).
   Upstream treats this as necessary, which says the graph degrades without it.

A local inconsistency: Jeff's wrapper says the connector is `mcp__claude_ai_SimpleMemory__bm_*`,
but in this session it is `mcp__claude_ai_Basic_Memory__bm_*`, and the project is listed as
`main (local)`. The tool *names* match, which is the point: **skills are written against the
`bm_*` names, not the connector name.** *(inferred: Jeff exposes a local BM through a remote
connector, and the wrapper text is stale.)*

---

## 4. Sync, cloud, multi-user, export

- **Local OSS:**
  - Python 3, run with `uvx basic-memory mcp`. stdio or streamable HTTP. SQLite plus a watcher.
  - Licensed **AGPL-3.0**. **Cairn must not copy code.** Re-implementing the file format and the
    tool contract is fine; port nothing from `src/`.
  - Single-user by design: no auth on the local server.
- **Cloud** ($15–19 a month, one plan, 7-day trial):
  - Built on WorkOS AuthKit, Neon Postgres and Tigris S3 (README).
  - Remote MCP with **OAuth 2.1 + PKCE**. The CLI uses OAuth Device Authorization against WorkOS,
    plus API keys (`bm cloud api-key create`).
  - Personal and Team workspaces. Team uses per-project access over WebDAV.
  - Web app and mobile, snapshots with point-in-time restore, `bm_log` audit trail, scheduled
    agents, review threads, and an MCP Apps UI (`bm_open`).
- **Sync:** 1.0 **removed** rclone `sync`/`bisync` (they were too fragile; issues #459 and #460
  were TigrisFS and bisync failures). What is left is additive-only `bm cloud push`/`pull`, which
  never deletes on the destination. In practice there is no true two-way sync any more. Concurrent
  edits are handled by checksums at the API, not by merge.
- **Export:**
  - Notes are already Markdown.
  - `bm okf export` writes an **Open Knowledge Format v0.2** bundle. Wikilinks are rewritten to
    standard Markdown links, `index.md` files are generated, and a root `log.md` comes from the
    journal.
  - Typed relations are preserved in a frontmatter `bm.okf_export.relations` list, because plain
    links lose edge types.
  - `okf-check` validates a bundle.
  - **There is no OKF importer.**

  This matches Jeff's "download as markdown with links" requirement closely, and it is a ready
  reference design.

---

## 5. Pain points and weaknesses

From issues, docs and my own use:

1. **Agents claim to have saved when they did not** (#1341). Two harnesses and two models gave a
   confident "recorded" with no write. Upstream calls this "close to the worst failure mode" for a
   memory product. A server cannot fully fix it, but skills and tool results can make the receipt
   impossible to fake (see the recommendations).
2. **Token-heavy reads.** Search returns full bodies plus duplicated chunks by default. #686 asked
   for L0/L1/L2 progressive loading. `compact` exists but drops the very text you wanted for
   observations. #1746 (rank by id, then fetch text for the page only) is still open.
3. **Index drift.** Duplicate `search_index` rows on SQLite (#1771); checksum reconciliation that
   can never repair a wrong row (#1538); an editor autosave file clobbering an entity (#1537);
   stale `entity_metadata` (#634); a migration that cannot be restarted (#1853). The dual-authority
   file↔DB design produces a steady stream of convergence bugs. **A Worker with D1 as the only
   authority avoids this whole class.**
4. **Frontmatter round-trip loss** (#1653: overwrite silently drops or merges keys, and #2005).
   `permalink` with a project prefix written into files (#2021). Folder case splits into twins
   (#1796).
5. **Breaking churn.** 1.0 deleted every tool name with no aliases. Every third-party skill,
   allowlist and prompt broke. The tool count went from about 20 to 12, which is good, but the
   migration cost fell on users.
6. **Verbosity and ceremony.** `project` is required on every call; skills have to restate scope
   rules in every file; there are seven edit commands.
7. **Sync gave up.** Bisync was removed. Local and Cloud are effectively two stores with
   additive copy between them.
8. **Startup and ops weight.** Python plus FastAPI plus ONNX. MCP import is slow enough that
   clients time out (#1731). Intel Macs lost FastEmbed. Brute-force vector scan on SQLite (#1996).
9. **The graph degrades without curation.** The existence of reflect, defrag, curate and doctor
   skills says so. Nothing in the server nudges hygiene: no orphan or duplicate report and no
   staleness signal in results. (#1588 proposes stale-fact marking in core.)
10. **Relation semantics are inconsistent.** Inline links are `links_to` in the docs and
    `references` in a skill. Relation types are free text with no normalisation (`relates_to`
    vs `related_to`). There are no inverse names, so the reverse direction is shown as raw
    inbound edges.
11. **Multi-user is Cloud-only and closed.** OSS has no auth at all. Teams, review, the audit log
    and agents are proprietary. That gap is exactly Cairn's opening.

---

## 6. Compatibility recommendation

**Yes: make Cairn's Markdown file-compatible with Basic Memory, and mirror the `bm_*` tool
contract.** The cost is low and the benefit is large:

- Jeff's skills, and upstream's ~20 skills, run against Cairn unchanged.
- His existing `main` project (about 264 notes) imports by copying files.
- He can leave Cairn at any time by exporting.

Concretely:

- **File format (must match):**
  - Frontmatter keys `title`, `type`, `tags`, `permalink`, `schema`, `created`, `modified`,
    `locked`; unknown keys pass through **byte-for-byte**.
  - `- [category] text #tag (context)` observations, including the `@kind:` temporal qualifiers.
  - `- type [[Target]] (context)` relations, inline `[[links]]` and relative Markdown links as
    `links_to`.
  - The same exclusions (checkboxes, links).
  - Picoschema schema notes.

  Write a conformance test suite from `NOTE-FORMAT.md`, not from their code (AGPL).
- **Deviate deliberately in two places:**
  - Store permalinks **project-relative** and accept a `project/` prefix on import by stripping
    it.
  - Never write a permalink into frontmatter unless the user set one. Derive it, so renames do not
    leave stale keys. *(This is a behaviour difference on write, not a format incompatibility. BM
    reads either form.)*
- **Tool names:** mirror the 1.0 `bm_*` set exactly (`bm_read`, `bm_write`, `bm_edit`,
  `bm_delete`, `bm_move`, `bm_search`, `bm_context`, `bm_list`, `bm_find`, `bm_project`,
  `bm_schema`, `bm_man`), with the same parameter names and the same typed error codes.
  - *Extensions* are new optional parameters or new tools; never rename.
  - Do **not** ship pre-1.0 aliases. Upstream already broke them, and Jeff's skills use 1.0 names.
  - One judgement call: the `bm_` prefix advertises "Basic Memory". It is a trademark-ish risk
    *(inferred)* but a huge compatibility win. Keep it.
- **Import path:**
  - Upload a zip or folder, or point at a git repo, through the web UI or CLI.
  - Walk the files, strip the project prefix from permalinks, keep unknown frontmatter, resolve
    forward references after the whole batch is loaded, and report unresolved links.
  - Also accept an OKF v0.2 bundle and restore typed edges from `bm.okf_export.relations`.
    Upstream has no importer, so Cairn would be the first.
- **Export:**
  - A BM-native zip (identical files).
  - An OKF v0.2 bundle (wikilinks rewritten to relative `.md` links, `index.md` per folder, typed
    relations in frontmatter). This *is* Jeff's "downloads as markdown with links".

---

## Recommendations for Cairn

Ranked. Each item gives what to do, then how.

1. **Adopt BM's file format as Cairn's canonical format, with a conformance suite.**
   - D1 holds the accepted Markdown bytes as the single authority.
   - Entities, observations, relations, sections and the time index are projections rebuilt from
     those bytes in the same request (or one Queue hop).
   - R2 holds attachments and export snapshots.
   - There is no filesystem, so there is no file↔DB reconciliation. This deletes BM's largest bug
     class (§5.3).
2. **Mirror the `bm_*` 1.0 tool contract exactly**, including `expected_checksum`, the typed
   refusals, `section` addressing (`A/B`, `X[1]`) and the seven `bm_edit` commands. Ship
   `bm_man` with pages generated from the tool schemas. It is cheap and agents use it.
3. **Make the write receipt unfakeable** (fixes #1341). Every mutating tool returns a short receipt:
   - `saved <permalink> rev <short-checksum> at <time>`, and a web URL.
   - Cairn skills say "quote the receipt; if you have no receipt you did not save".
   - Add a per-user "recent writes" view in the web viewer, so a human can verify at a glance.
4. **Progressive disclosure by default** (fixes the token cost in §5.2).
   - `bm_search` defaults to L0: title, permalink, type, tags, score and **the matching lines**,
     about 60 tokens a hit.
   - `detail="observations"` gives L1 and `detail="full"` gives L2.
   - Observation hits always include the observation text.
   - Rank by id in SQL, then fetch text only for the page.
5. **Hybrid search on Cloudflare primitives.**
   - D1 FTS5 for keywords.
   - Vectorize for embeddings, with chunking as BM does it: one chunk per bullet, headers split,
     about 900 characters of prose, chunks keyed by SHA-256 so unchanged chunks are never
     re-embedded.
   - Workers AI `bge` models for embeddings.
   - Use **RRF** first, because it is simpler and robust to score scale. Keep fusion pluggable and
     benchmark against BM's `max + bonus·min` (they have the open question in #1748).
6. **Keep temporal qualifiers and Picoschema**, and implement them early. Both are plain-text,
   optional and high-value. Use schemas to **remove the double-write wart** (§3.3): let `filters`
   match observation-backed schema fields, so `status` need not live in both frontmatter and an
   observation.
7. **Multi-user built into the core.** Passkeys for humans, and OAuth 2.1 + PKCE + Dynamic Client
   Registration for MCP. The `workers-oauth-provider` library fits here *(the auth worker covers
   this)*. Model user → workspace → project as BM Cloud does. Record `created_by` and
   `last_updated_by` per write, and keep a journal table (an audit log like `bm_log`). This is the
   feature OSS BM lacks entirely.
8. **Skills: fork Jeff's wrapper plus memory-notes, memory-continue, memory-capture and
   memory-tasks** as Cairn's first-party skills, with:
   - the connector-agnostic `bm_*` names;
   - the "save unprompted only in interactive sessions, never workers" rule;
   - the "name everything" rule;
   - the receipt rule from item 3.

   Write them fresh; they are AGPL-adjacent repo content *(inferred: the skills live in the AGPL
   repo, so treat them as AGPL)*. Add SessionStart and PreCompact hooks equivalent to BM's
   plugin.
9. **Hygiene in the server, not only in skills.** Provide a `bm_project(command="health")` (or
   similar) that reports:
   - orphans and unresolved links;
   - near-duplicate titles;
   - notes over N KB;
   - facts superseded by a later `@effective` qualifier.

   Show the same report in the web viewer. Upstream relies on reflect, defrag and doctor skills to
   compensate; Cairn can surface the signal directly.
10. **Import from BM and OKF, and export to both.** Accept a zip of files, a git repo, or an OKF
    bundle. Export a BM-identical zip and an OKF v0.2 bundle with typed relations in frontmatter.
11. **Normalise relation types gently.** Lower-case snake_case on write. Optionally declare
    inverse names in a schema (for example `works_at` ↔ `employs`), so context views read
    naturally in both directions. Choose one name for inline links (`links_to`).
12. **Project-relative permalinks** that are never auto-written into frontmatter (§1 wart, #2021).

**Deliberately leave out:**

- **File watcher and two-way file sync.** BM gave up bisync, and a Worker has no filesystem.
  Offer git or zip import/export, and perhaps a later `cairn pull/push` CLI that is additive like
  theirs.
- **Local embedding models, Milvus and LiteLLM.** Use Workers AI and Vectorize only.
- **Comark `::bm-*` live components, Cloud agents and CriticMarkup review threads.** They are
  real features but not the core. Revisit review threads once multi-user ships.
- **Pre-1.0 tool aliases and the ChatGPT `search`/`fetch` adapters.** Add the adapters only if
  ChatGPT becomes a target (#2030 shows the shape question is still open upstream).
- **`required project` on every call.** Default to the user's default project when omitted, and
  still accept `project`. Note that BM made this strict deliberately, to stop wrong-project writes.
  Cairn can keep BM-skill compatibility (they always pass it) while being friendlier, *if* the
  write receipt always names the project.

## Open questions

1. **Tool prefix.** Is `bm_*` acceptable branding for Cairn, or do we want `cairn_*` with `bm_*`
   aliases? I recommend `bm_*` only, for skill compatibility. That is Jeff's call if branding
   matters to him.
2. **Migration of Jeff's `main` project.** Does he want Cairn to replace BM outright (a one-time
   import), or to run both in parallel for a while? Running both would argue for a periodic
   one-way BM→Cairn import.
3. **Where Jeff's BM actually runs.** The wrapper skill says "SimpleMemory"; this session shows
   "Basic Memory", project `main (local)`. Knowing the real host tells us how to pull the files
   for import (direct file copy vs `bm okf export`).
4. **Licensing of Cairn.** BM is AGPL. A clean-room re-implementation of the format and tool
   contract is fine, but we should decide Cairn's own licence (MIT/Apache?) before anyone reads
   `src/` closely enough to port it.
5. **Temporal and schema scope for v1.** Should `@kind:` qualifiers and Picoschema validation be
   in the first release, or parsed-and-preserved only, with querying later? I lean toward
   parse-and-index in v1 because it is cheap, and validation UI later.
6. **Fusion choice.** Use RRF, or match BM's score fusion? This should be settled by a small eval
   on Jeff's own 264 notes after import, not by argument.
