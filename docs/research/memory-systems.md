# Agent memory: the state of the art, and what Cairn should take

*Research brief for Cairn, November 2026. Author: research worker `systems`. Sources are cited
inline; anything I inferred rather than read is marked (inferred). Vendor benchmark numbers are
self-reported unless stated otherwise.*

## TL;DR

1. **The benchmarks do not crown an architecture.** LoCoMo is badly broken as a yardstick (one
   product scored 58 to 95 depending on who ran it), and the most-cited result of 2025 was a
   plain *file + grep + semantic search* agent beating the dedicated memory layers. What does
   show up consistently across papers is: **write quality, temporal handling of changing facts,
   fine-grained indexing, hybrid retrieval, and letting the agent search iteratively.**
2. **The field converged on files.** Anthropic's memory tool is a `/memories` directory; Claude
   Code's auto memory is a `MEMORY.md` index plus topic files; Letta rebuilt its memory in 2026
   as git-backed markdown ("context repositories"); Karpathy's "LLM Wiki" is an agent-maintained
   Obsidian vault. Cairn's markdown-first premise is not a handicap; it is where the field went.
3. **The ideas worth stealing** are mostly *metadata and process*, not storage engines: validity
   intervals and supersession (Zep/Graphiti), provenance back to the source episode (Graphiti),
   a small pinned core memory with a hard budget (Letta, Claude Code), an index note plus
   progressive disclosure (Claude Code, Letta, Karpathy), background reflection/lint jobs (Letta
   sleep-time, Karpathy lint), and observation-level indexing with BM25 + vectors + entity
   boosts fused by rank (Mem0 v3, Graphiti, LongMemEval).
4. **Cairn's structural advantage:** the client is already an LLM. Most of the expensive
   write-time intelligence (extraction, contradiction judgement, entity resolution) can be done
   by the connected agent, guided by tool responses and skills, so the Worker stays cheap and
   deterministic. Server-side LLM work (Workers AI) should be optional and asynchronous.

## 1. What the evidence actually says

### Benchmarks and their problems

- **LoCoMo** (Maharana et al., 2024) is the most-quoted and least trustworthy. An audit found
  only 10 conversations / 1,986 questions were released (not the 50 / 7,512 described), most
  published scores drop the adversarial category, and the LLM-judge prompt introduced by the
  Mem0 paper got copied everywhere ([locomo-audit](https://github.com/dial481/locomo-audit)).
  The same product (Zep) has been reported between 58.44 and ~94.7 depending on the runner,
  answer model and judge ([summary](https://braindetox.kr/en/posts/memory_benchmark_scores_reliability_2026.html)).
  The 2025 Zep-vs-Mem0 fight (Zep 84 → Mem0's re-run 58.44 → Zep's correction 75.14) is the
  canonical example.
- **LongMemEval** (Wu et al., ICLR 2025, [arXiv 2410.10813](https://arxiv.org/abs/2410.10813)):
  500 questions testing five abilities: *information extraction, multi-session reasoning,
  temporal reasoning, knowledge updates, abstention*. More useful than LoCoMo because the
  categories map to real failure modes. Its own design findings are directly actionable:
  **session decomposition** (store finer-grained units), **fact-augmented key expansion**
  (index extracted facts alongside raw text) and **time-aware query expansion** (use time cues
  to narrow search). Commercial assistants dropped ~30% accuracy over sustained interactions.
- **LongMemEval-V2** (2026, [arXiv 2605.12493](https://arxiv.org/abs/2605.12493), ICML 2026)
  moves to agent trajectories ("experienced colleague" memory); best system ~70–75%, frontier
  LLMs without the trajectory evidence ≤14%. Relevant later for "procedural" memory, not v1.
- **BEAM** (ICLR 2026) scales to 1M–10M tokens. Mem0's own BEAM numbers show where everyone is
  still weak: contradiction resolution 35.7 (1M) / 32.5 (10M), temporal reasoning 16.3 at 10M
  ([Mem0 blog](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm)).
- **"Ground Truth First"** (Spencer, July 2026, [arXiv 2607.21962](https://arxiv.org/abs/2607.21962))
  is the most interesting recent paper for us: a synthetic longitudinal benchmark with planted
  facts that have validity intervals, volatility classes and source channels. Findings:
  rankings **invert with tenure** (a budgeted curated memory led at 3 weeks but fell from 96% to
  72% recall of evicted content by 9 weeks, while a *provenance-typed graph* rose to 90%);
  full history ties the best memory at 3 weeks but costs ~2× to read; **write-stage quality
  predicts everything** (weakly written facts failed 24% of the time vs 2%); and **injection
  resistance tracked whether provenance boundaries survived** the representation.

### Claims with evidence vs marketing

| Claim | Status |
|---|---|
| A plain filesystem agent is competitive with memory layers | **Evidence.** Letta: GPT-4o-mini with `grep`, `search_files` (semantic), `open` scored 74.0% on LoCoMo vs Mem0's reported 68.5% graph variant ([Letta, Aug 2025](https://www.letta.com/blog/benchmarking-ai-agent-memory)). Self-reported, but cheap to believe and widely replicated in spirit. |
| Temporal KG beats full context on time/update/preference questions | **Evidence, with caveats.** Zep on LongMemEval: gpt-4o 60.2% → 71.2%, context 115k → 1.6k tokens, latency 28.9s → 2.6s; big gains on preference (+184%), temporal (+38%), multi-session (+31%); **regressions** on single-session-assistant (−17.7%) and knowledge-update with gpt-4o-mini ([Zep paper](https://arxiv.org/html/2501.13956)). |
| Graph memory adds a lot over plain extracted facts | **Weak.** Mem0's own paper: graph variant +~2 points on LoCoMo, *below* the full-context baseline (68.4 vs 72.9) ([arXiv 2504.19413](https://arxiv.org/abs/2504.19413)). Mem0 then **removed graph memory from its OSS package** in 2.0 and kept only entity extraction for ranking boosts ([Mem0 docs](https://docs.mem0.ai/components/graph_memory/overview), [Memgraph](https://memgraph.com/docs/ai-ecosystem/integrations/mem0)). |
| Mem0 v3 at 92.5 LoCoMo / 94.4 LongMemEval | **Self-reported, unreplicated**, judge ±1pt, models unnamed, platform has "proprietary optimizations not in OSS" ([blog](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm)). The *design* (below) is the useful part. |
| Supermemory 95–99% LongMemEval | **Marketing-grade.** Recall@15/20 "with aggregation", and the ~99% run was an agent-swarm variant, not the production engine ([report](https://supermemory.ai/research/longmembench), [review](https://dev.to/andrew-ooo/supermemory-review-1-ai-memory-engine-on-longmemeval-3k0e)). |
| A-MEM's Zettelkasten memory beats SOTA | Peer-reviewed (NeurIPS 2025, [arXiv 2502.12110](https://arxiv.org/abs/2502.12110)) but on LoCoMo, so treat the size of the gain with suspicion; the *idea* is sound. |
| HippoRAG 2 improves multi-hop retrieval | **Evidence** on standard QA sets (~+7 F1 on MuSiQue-style multi-hop over strong dense retrieval; ICML 2025, [arXiv 2502.14802](https://arxiv.org/abs/2502.14802)). Not a personal-memory benchmark. |
| Letta sleep-time agents / context repositories improve memory | **No published numbers** for context repositories ([Letta, Feb 2026](https://www.letta.com/blog/context-repositories)); sleep-time compute has a paper ([arXiv 2504.13171](https://arxiv.org/abs/2504.13171)) about test-time compute trade-offs, not memory quality. Plausible, unproven. |

**Bottom line for Cairn:** do not chase a leaderboard. Build our own small eval (section 5)
over the LongMemEval categories, especially knowledge-update, temporal and abstention, because
those are the failures a personal memory user will actually notice.

## 2. The systems, reduced to their ideas

**Mem0** ([paper](https://arxiv.org/abs/2504.19413), [v3 algorithm, Apr 2026](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm)).
v1/v2: two LLM passes, extract candidate facts then reconcile each against similar memories with
ADD/UPDATE/DELETE/NOOP. v3 (2026): *one* extraction call, **ADD-only**, nothing overwritten;
agent-confirmed actions stored with equal weight as user facts; entities (proper nouns, quoted
text, compound noun phrases) embedded into a separate lookup that **boosts** matching memories;
retrieval = semantic + keyword (with verb-form normalisation) + entity match in parallel,
**fused by rank**; ~7k tokens per query, single retrieval pass. *Ideas:* fact-level units,
entity boost, rank fusion, user/agent/session scoping via IDs. *Anti-idea for us:* ADD-only
accumulation pushes contradiction resolution to read time, and their own BEAM numbers show that
is exactly where it fails (35.7 / 32.5). In a human-readable vault, unbounded accumulation of
near-duplicates is also illegible.

**Letta / MemGPT** ([memory blocks](https://www.letta.com/blog/memory-blocks), [sleep-time](https://docs.letta.com/guides/agents/architectures/sleeptime/index.md), [context repositories](https://www.letta.com/blog/context-repositories)).
Core memory = labelled, size-limited blocks always in the system prompt, editable by the agent;
blocks can be **shared across agents**. Sleep-time agents: a second agent edits memory in the
background so the primary agent doesn't pay for it in-turn. 2026 pivot: memory is a **git-backed
directory of markdown files**; the file tree is always in the prompt; each file has frontmatter
with a `description` (like a SKILL.md); a `system/` folder marks what is fully loaded; background
**reflection** (review recent conversations, save, merge) and **defragmentation** (reorganise
into 15–25 focused files) subagents; every edit is a commit. *Ideas:* pinned core with budget,
descriptions for progressive disclosure, background consolidation, version history per edit.
This is the closest existing design to Cairn.

**Zep / Graphiti** ([paper](https://arxiv.org/html/2501.13956), [docs](https://help.getzep.com/graphiti/getting-started/overview)).
Three subgraphs: **episodes** (raw, lossless inputs: messages, text, JSON), **semantic entities
and fact edges**, and **communities** (label-propagation clusters with summaries). Every fact
edge is **bi-temporal**: `t_valid`/`t_invalid` (when it was true in the world) and
`t'_created`/`t'_expired` (when the system learned / retired it). On ingest an LLM compares a
new edge with semantically related edges; on contradiction the old edge gets `t_invalid` = new
edge's `t_valid` and is **kept, not deleted**. Entity resolution: embedding + full-text candidate
search, then an LLM decides duplicate-or-new and rewrites the summary; writes go through fixed
queries, not LLM-generated ones. Search: cosine + BM25 + BFS (seeded e.g. by recent episodes),
rerank by RRF, MMR, **episode-mentions** (frequency), **node distance** from a focal entity, or
cross-encoder. Every fact traces back to its episode for citation. *Ideas:* validity intervals,
invalidate-don't-delete, episode provenance, the reranker menu, deterministic writes. *Cost:* a
graph DB plus several LLM calls per ingest; too heavy to copy wholesale onto Workers.

**Anthropic memory tool** ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).
`{"type":"memory_20250818","name":"memory"}`, now stable on all Claude 4+ models; still the
current version. Client-side: the model issues `view`/`create`/`str_replace`/`insert`/`delete`/
`rename` against a `/memories` prefix that **your** handler maps to storage. The API injects a
protocol: *"ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE… ASSUME INTERRUPTION."*
Docs recommend size caps, paging long files, expiring unused files, and strict path-traversal
checks; it pairs with compaction/context editing. *Ideas:* the model is trained on this exact
file-editing interface, so **Cairn should be able to back it** (a `/memories` → Cairn project
adapter is cheap and makes Cairn usable from raw API agents, not just MCP clients).

**Claude's own memory.** Claude Code auto memory ([docs](https://code.claude.com/docs/en/memory)):
a per-repo directory with `MEMORY.md` as a one-line-per-entry index plus topic files with a
`type` in frontmatter; **only the first 200 lines / 25KB of the index load at session start**,
and the harness nags the model to shorten it when near the limit. Consumer Claude: chat search
plus a synthesized **memory summary refreshed every 24 hours**, user-editable
([help](https://support.anthropic.com/en/articles/11817273-how-does-claude-s-memory-work)).
*Ideas:* a hard-budgeted index, enforcement by the tool rather than by prompt, periodic
synthesis that the user can see and edit.

**ChatGPT memory** (community reverse-engineering, not official:
[llmrefs](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory),
[r/ML thread](https://redlib.hbubli.cc/r/MachineLearning/comments/1kmri3v/d_reverseengineering_openai_memory)).
Layers: explicit "saved memories" (a `bio` tool, injected verbatim each turn, user-visible),
recent-conversation snippets, and an AI-generated **user-insights profile** that is not directly
visible or editable. *Idea:* the two-tier "explicit facts + synthesized profile" split works.
*Anti-idea:* an invisible profile is the opposite of Cairn's promise; if we synthesize a profile
it must be an ordinary note the user can read and edit.

**LangMem** (LangChain). Taxonomy of **semantic** (facts/profiles), **episodic** (past
experiences / few-shot examples) and **procedural** (prompt/instruction updates) memory, with
hot-path tools plus a background memory manager. *Idea:* the taxonomy is useful vocabulary for
note types; procedural memory = Cairn skills/instructions notes. Little benchmark evidence.

**Cognee** ([docs](https://docs.cognee.ai/getting-started/introduction.md), [review](https://zby.github.io/commonplace/agent-memory-systems/reviews/cognee/)).
`add → cognify` (schema-guided entity/relation extraction into a graph) `→ memify`
(post-processing: prune stale nodes, strengthen frequent edges) `→ search`; API surface
`remember/recall/improve/forget`. Reviewers note memify is thinner than advertised. *Idea:* a
named "improve" pass as a first-class operation, and the four-verb API is a nice mental model.

**A-MEM** ([arXiv 2502.12110](https://arxiv.org/abs/2502.12110), NeurIPS 2025).
Zettelkasten for agents: each memory is a note with keywords, tags and a context description;
on write the system finds related notes and **links** them, and may **evolve** older notes'
context/tags in light of the new one. *Idea:* write-time linking + description enrichment.
Cairn already has the note/relation shape; A-MEM is the argument for doing link suggestion at
write time.

**HippoRAG 2** ([arXiv 2502.14802](https://arxiv.org/abs/2502.14802)). OpenIE triples → graph of
phrase *and* passage nodes; query-matched facts (LLM-filtered) seed **Personalized PageRank**;
passages ranked by PPR mass. Good at multi-hop ("associativity"). *Idea:* graph walk seeded by
query hits is a cheap reranking signal over Cairn's existing `[[wiki-link]]` graph; PPR over a
personal-scale graph (≤100k edges) is a few ms in a Worker (inferred).

**MemoRAG** ([arXiv 2409.05591](https://arxiv.org/abs/2409.05591)). A light long-context model
holds a compressed "global memory" and drafts **clues** (draft answers) that are used as
retrieval queries. *Idea:* query expansion via a draft answer (HyDE-like). Cairn's client agent
can do this itself by issuing several searches; not worth server machinery.

**Supermemory** ([research](https://supermemory.ai/research/longmembench)). Reported: versioned
memories with an `isLatest` flag (old versions kept, marked stale), update/extend/derive
relations, automatic expiry of temporary facts ("exam tomorrow"). Details from third-party
write-ups, unverified. *Idea:* explicit "latest" pointer and **expiring facts**; also a useful
warning from one review: *forgetting is not erasure* — user deletion must actually delete.

**Obsidian/Logseq vaults with agents; Karpathy's LLM Wiki** ([gist, Apr 2026](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)).
Raw sources (immutable) → LLM-owned wiki pages → a schema file (CLAUDE.md/AGENTS.md) that sets
conventions. Operations: **ingest** (one source touches 10–15 pages), **query** (answers with
citations; good answers are **filed back** as pages), **lint** (contradictions, stale claims,
orphans, missing links). `index.md` (one line per page, read first, replaces embeddings at
moderate scale) and an append-only `log.md`. *Ideas:* index note, activity log, lint pass,
raw/derived separation, file answers back. This is the "human-readable markdown the user owns"
camp, and it is the model Cairn users will already have in their heads.

**Security: memory poisoning.** MINJA (NeurIPS 2025) showed >95% injection success via ordinary
queries in idealised settings; a 2026 follow-up found realistic conditions cut that sharply and
proposed trust scoring plus trust-aware retrieval ([arXiv 2601.05504](https://arxiv.org/abs/2601.05504)).
Combined with the "Ground Truth First" finding, the practical lesson is: **keep provenance on
every fact and keep the source boundary visible** (who wrote this, from what input), so both
retrieval and the human can discount untrusted material.

## 3. The idea catalogue, judged for Cairn

Lens: (R) improves recall in practice; (L) keeps markdown legible and user-owned; (W) cheap on
Workers (D1, Vectorize, Workers AI, Queues, Cron, Durable Objects).

| Idea | R | L | W | Verdict |
|---|---|---|---|---|
| Observation-level indexing (each `- [cat] fact` is its own search unit, plus the note) | High (LongMemEval decomposition; Mem0 fact units) | No change to markdown | Vectorize rows per observation; cheap | **v1** |
| Hybrid retrieval: D1 FTS5 BM25 + Vectorize + recency + link-graph boost, RRF-fused | High (Graphiti, Mem0 v3) | n/a | All native | **v1** |
| Iterative agent search (good tools > clever single-shot retrieval) | High (Letta 74%) | n/a | Free | **v1** (tool design + skill) |
| Validity / supersession of facts (invalidate, don't delete) | High on knowledge-update & temporal | Good if rendered as text | D1 columns | **v1, lightweight form** |
| Provenance on every write (actor, client, time, source) | Medium recall, high trust/safety | Frontmatter + history | D1 table | **v1** |
| Pinned core memory with hard budget + index note | High (Letta, Claude Code) | Ordinary notes | Trivial | **v1** |
| Write-time dedup / entity-resolution / contradiction *hints* returned to the agent | High (write quality predicts recall) | Agent writes the prose | One search per write | **v1** |
| Human review of agent writes (activity feed, diff, revert) | Indirect | Core to ownership | D1 revisions + R2 | **v1** (feed + revert); approval queue later |
| Time-aware query handling (`since`/`as_of` filters, date parsing) | Medium-high on temporal Qs | n/a | Cheap | v1 filters; smarter parsing later |
| Background reflection / lint / defrag (sleep-time) | Plausible, unproven | Must produce visible diffs | Cron + Queues + Workers AI, or user's agent via a skill | **v1.x** (as a skill first) |
| Decay / forgetting | Low-medium as *ranking* signal | Deleting user text is hostile | Cheap | Ranking decay only; expiry only for facts marked temporary |
| Importance scoring | Low evidence | Hidden scores are illegible | Cheap | Later; use explicit `pinned`/`priority` instead |
| Cross-encoder rerank | Medium | n/a | Workers AI `bge-reranker-base` exists (inferred, check `cf` brief) | Later, behind a flag |
| Communities / generated summaries | Medium for "overview" Qs | Only as visible notes | LLM cost | Later (lint/defrag output) |
| Personalized PageRank over links | Medium for multi-hop | n/a | In-Worker compute | Later |
| Full bi-temporal KG in a graph DB, LLM triple extraction on every write | Medium | Poor: facts leave the markdown | Expensive, needs graph DB | **Leave out** |
| Opaque extracted-fact store as source of truth (Mem0-style) | Medium | Poor | Medium | **Leave out** |
| Invisible synthesized profile (ChatGPT insights) | Medium | Violates ownership | — | **Leave out** (do it as a visible note) |
| Trained memory models (MemoRAG) | — | — | Not on Workers | **Leave out** |

## 4. How the chosen ideas map onto markdown + index

Basic Memory's note shape stays the source of truth: frontmatter, `## Observations` lines
`- [category] content #tag (context)`, `## Relations` lines `- relation_type [[Target]]`
(details in the `bm` brief). Rule: **everything the index needs must be reconstructible from
the markdown plus the revision log**, so export and re-index both work. Concretely:

```markdown
---
title: Acme Corp
type: org
permalink: orgs/acme-corp
tags: [customer]
pinned: false
created: 2026-03-14T10:02:00Z
updated: 2026-10-01T16:40:00Z
updated_by: claude-code (jeff)        # actor of last write; full history in the log
sources: [conversations/2026-10-01-acme-call]
---
# Acme Corp

## Observations
- [contact] Main contact is Dana Roe #people (since 2026-10-01; via [[conversations/2026-10-01-acme-call]])
- [preference] Prefers email follow-ups over calls (2026-03-14)
- [status] Pilot ends 2026-12-15 (expires 2026-12-16)

## Relations
- uses [[Cairn]]
- contact [[Dana Roe]]

## Superseded
- [contact] ~~Main contact is Sam Lee~~ (2026-03-14 → 2026-10-01; replaced by Dana Roe)
```

The `(context)` slot Basic Memory already parses carries dates, `since`, `expires` and `via`
in a small, documented, human-readable grammar; the parser pulls them into index columns.

## Recommendations for Cairn

Ranked. v1 means "in the first usable release"; each is cheap on Workers.

**v1**

1. **Hybrid search at observation granularity.** Index every note *and* every observation as a
   row: D1 FTS5 for BM25 (with porter stemming, which covers Mem0's verb normalisation),
   Vectorize for embeddings (Workers AI embedding model; observation text prefixed with the
   note title so a bare fact keeps its subject — LongMemEval's "fact-augmented keys"). Fuse with
   **reciprocal rank fusion**, then add small boosts for: entity/title match (Mem0's entity
   boost, free since note titles *are* entities), 1-hop `[[link]]` neighbours of top hits
   (cheap graph walk), recency of `updated`, and `pinned`. Return observation hits grouped
   under their note with the note permalink, so the agent can open the whole note. Leave the
   reranker pluggable. *Why first:* it is the single biggest recall lever with evidence.

2. **Tools designed for iterative agent search, not one-shot RAG.** Letta's result says the
   agent's ability to search again matters more than the index. Ship: `search` (hybrid, with
   `types`, `tags`, `folder`, `since`/`until`, `as_of` filters and a `mode` of
   hybrid/keyword/semantic), `read_note` (with line ranges for long notes), `build_context`
   (note + N-hop neighbours), `recent_activity`, and a literal **`grep`** over the vault for
   exact strings. Keep result payloads compact (snippets + permalinks) so the agent can afford
   three or four searches. The skill teaches "search, read, search again with what you learned,
   say you don't know when nothing matches" (abstention is a LongMemEval category).

3. **Core memory: pinned notes plus an index, under a hard budget.** Notes with `pinned: true`
   (and one conventional `memory/index.md` per project, one line per important note, like
   `MEMORY.md`/Karpathy's `index.md`) are returned by a `get_core_context` tool and by the MCP
   server's instructions/prompt at session start. Enforce a byte budget in the tool (e.g.
   ~8KB default, configurable), and when exceeded return a message telling the agent to
   condense, exactly as Claude Code does at 200 lines/25KB. Users see and edit these as normal
   notes in the viewer. *Why:* the most reliable memory is the memory that is already in
   context; the budget keeps it from rotting.

4. **Supersession instead of overwrite or blind accumulation.** When a fact changes, the agent
   moves the old observation to a `## Superseded` section with a date range and writes the new
   one (format above). The index stores `valid_from`/`valid_to`/`superseded=true`; default
   search excludes or down-ranks superseded rows; `as_of` and "history" queries include them.
   This is Graphiti's invalidate-don't-delete, made legible, without a graph DB. Optional
   `expires` dates handle temporary facts (Supermemory); a Cron job marks them superseded, it
   never deletes text. Add a `supersede_observation` tool so agents do this in one call rather
   than by hand-editing.

5. **Write-time hints computed by the server, judged by the agent.** On every `write_note` /
   `edit_note`, the Worker runs one cheap search over the new observations and returns, in the
   tool result: likely **duplicate notes** (title/alias fuzzy + vector match: entity
   resolution), **possibly conflicting observations** (same category, same subject, high
   similarity, different content), and **suggested links** to existing notes (A-MEM). No LLM
   call on the server; the connected agent, already an LLM, decides whether to merge,
   supersede or link. *Why:* "Ground Truth First" found write quality predicts downstream
   recall more than anything else, and this is how to raise it at zero model cost.

6. **Provenance and revision history on every write.** Record actor (user), OAuth client name
   (e.g. "Claude Code", "claude.ai"), timestamp, tool, and optional `source` (conversation id
   / URL the agent supplies) in a D1 `revisions` table with the full prior content (or a diff)
   in R2/D1; surface `updated_by` and `sources` in frontmatter. Include provenance in search
   results so the agent can weigh a fact the user wrote above one an agent extracted from an
   email. *Why:* trust, poisoning resistance (MINJA, "Ground Truth First"), and it is the
   foundation for review.

7. **Human-in-the-loop review in the web viewer.** An "agent activity" feed: what each client
   changed, with diffs and one-click revert (driven by the revisions table). Per-client
   settings later for "agent writes land as `status: draft` until I approve". *Why:* this is
   what makes agent-written memory something the user owns rather than tolerates; no one in the
   survey does it well except via git (Letta).

8. **A "memory gardening" skill and a `/memories` adapter.** (a) A skill that runs Karpathy's
   *lint* / Letta's *reflection + defrag* using the user's own agent: find orphans,
   contradictions, stale `status` observations, overgrown notes, missing links, and refresh the
   index note — all as normal, reviewable edits. Costs Cairn nothing. (b) An optional HTTP
   adapter implementing the Anthropic memory tool commands over a Cairn project, so API-built
   agents can use Cairn with zero prompt engineering (the model is trained on that interface).

**Later (v1.x / v2)**

- **Server-side sleep-time jobs** (Cron + Queues + Workers AI): nightly lint report written as a
  note, auto-expire temporary facts, weekly synthesized "profile"/overview notes per project
  (the visible version of ChatGPT insights and Claude's 24-hour summary). Opt-in per user, all
  output as reviewable revisions.
- **Cross-encoder reranking** of the fused top-30 via Workers AI, behind a flag, once the eval
  shows it helps.
- **Time-aware query expansion**: parse "last spring", "before I moved" into `since/until`
  server-side.
- **Graph signals**: Personalized PageRank seeded by search hits over the link graph;
  episode-mention counts (how many notes/sources reference an entity) as a ranking prior.
- **Conversation/episode capture**: an optional `conversations/` folder where agents drop a
  short session summary that observations cite via `via [[...]]` — Graphiti's episode layer as
  plain notes. Useful, but adds volume; ship once review tooling exists.
- **Procedural memory**: notes of `type: instruction`/`skill` that the MCP server can surface as
  prompts (LangMem's procedural tier; Letta's `skills/` in MemFS).
- **Draft/approval queue** for agent writes, per OAuth client.

**Deliberately leave out**

- **A graph database or LLM triple extraction on every write.** Mem0 dropped its OSS graph;
  Mem0's own paper showed ~2 points of gain; Cairn's `[[links]]` and typed relations already
  are the graph, kept in markdown. D1 relation rows suffice.
- **Facts that live only in the index.** Every fact the user can be told must exist as
  markdown text. No hidden extracted-memory store, no invisible profile.
- **ADD-only accumulation** (Mem0 v3): fine for a black-box API, illegible in a vault, and the
  weakest category on their own benchmark.
- **Automatic deletion/decay of text.** Decay belongs in ranking. Real deletion happens only
  when the user (or an agent the user asked) deletes, and then it must purge index, vectors and
  revisions (forgetting ≠ erasure).
- **Hidden importance scores.** Use visible `pinned`, `priority` frontmatter instead.
- **Benchmark-driven tuning on LoCoMo.** It measures the judge as much as the system.

## Open questions

1. **Revision storage:** full snapshots vs diffs, and whether to offer git export/sync of a
   project (Letta-style) in addition to markdown zip download. Git sync would give power users
   history in their own tools, but adds an integration surface.
2. **Granularity of the `(context)` grammar:** how much metadata (`since`, `expires`, `via`)
   should live inline before observations stop being pleasant to read? Needs a quick usability
   pass with real notes; must stay compatible with Basic Memory's parser (see the `bm` brief).
3. **Embedding model and dimensions** on Workers AI, and per-user Vectorize namespaces vs a
   shared index with metadata filtering (multi-user isolation): defer to the `cf` brief.
4. **Who runs consolidation:** user's agent via skill (free, needs an active session) vs Worker
   cron with Workers AI (automatic, costs neurons, quality lower than frontier models). Probably
   both; which is the default is a product call for Jeff.
5. **Team scope:** when several users share a project, does supersession need per-user views
   ("Jeff believes X, Dana believes Y")? Graphiti handles this with per-group graphs; we can
   probably defer by keeping provenance and letting the reader judge.
6. **Eval harness:** build a small Cairn eval (synthetic personal vault, 100–200 questions over
   the five LongMemEval abilities, plus planted superseded facts in the style of "Ground Truth
   First") runnable against a local `wrangler dev`. Worth doing before tuning ranking weights;
   who owns it?
