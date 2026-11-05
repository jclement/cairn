# Cloudflare building blocks for Cairn

*Research for the Cairn lead, written 2026-11-04 from Cloudflare's developer docs (most pages
updated Aug–Oct 2026), the `workers-oauth-provider` README and Claude's connector docs.
Anything I inferred rather than read is marked *(inferred)*.*

**Bottom line.** Build Cairn as **one Worker**. It contains:
- `OAuthProvider`, from `@cloudflare/workers-oauth-provider`, acting as the authorization server, with our own passkey login page;
- a stateless `createMcpHandler` endpoint at `/mcp`, built on MCP SDK v2;
- a Hono app for the REST API and auth pages;
- Workers Static Assets for the viewer.

Storage is **one SQLite Durable Object per *vault*** rather than per user. Each vault DO is the source of truth for its notes, links and FTS5 index, and runs a background embedding loop on its alarm. Other storage:
- **D1** for the shared directory: users, passkeys, vaults, memberships;
- **Vectorize**, with one namespace per vault, for semantic search;
- **R2** only for attachments and stored exports.

Your lean is right with one change: key the DO by **vault, not user**, so a shared family or team vault is simply another DO. Two big API changes since early 2025: **`McpAgent` is now deprecated**, and **SSE is gone**.

---

## 1. Remote MCP on Workers

### 1.1 The current API: `createMcpHandler`, stateless, Streamable HTTP only

- **`McpAgent` is "deprecated and feature-frozen".** It remains only so existing servers can migrate. The replacement is `createMcpHandler` from `agents/mcp/server`, paired with the **MCP SDK v2 package `@modelcontextprotocol/server`**. An SDK v2 server cannot run inside `McpAgent`; legacy servers pin `@modelcontextprotocol/sdk@1.32.1`. [mcp-agent-api](https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/) (updated 2026-10-29)
- **SSE is deprecated** in favour of Streamable HTTP, and `createMcpHandler` "serves Streamable HTTP only". [transport](https://developers.cloudflare.com/agents/model-context-protocol/transport/)
- **Sessions and state.** The handler is stateless and has no MCP session. Under `McpAgent`, every client session was its own Durable Object with its own SQL database, and that state was lost on reconnect, so it was never a useful place to keep data anyway. Cloudflare's guidance is to keep persistent data in a DO, D1, KV or R2, **keyed by the authenticated user, not by MCP session id**. That matches what Cairn needs.
- **Lost features.** A stateless server cannot push notifications or send server-initiated requests (elicitation, sampling) mid-session. Cairn needs none of these: every tool is request/response.
- **How tools reach the auth props.** The server factory calls `getMcpAuthContext()?.props`. It is called per request, so each request builds a fresh `McpServer` that already knows its user. [authorization](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)
- **Tool design advice from Cloudflare's MCP overview page:**
  - define `inputSchema` and `outputSchema` for every tool and return matching `structuredContent`;
  - use per-operation scopes, answering a missing scope with `insufficientScope()` so the client asks for more access step by step;
  - consider a small "search and execute" interface ("Code Mode") instead of many tools. [overview](https://developers.cloudflare.com/agents/model-context-protocol/)

Minimal shape, adapted from Cloudflare's authorization example:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";

function createServer(env: Env) {
  const server = new McpServer({ name: "cairn", version: "0.1.0" });
  const { userId, vaults, scope } = getMcpAuthContext()!.props as CairnProps;
  server.registerTool("search_notes", { /* input/output schema */ }, async (args) => {
    const vault = env.VAULT.getByName(args.vault ?? vaults[0]); // DO RPC stub
    return vault.search(args);                                   // runs inside the DO
  });
  return server;
}
export const mcpHandler = (req, env, ctx) => createMcpHandler(() => createServer(env))(req, env, ctx);
```

### 1.2 `@cloudflare/workers-oauth-provider`

What the README and Cloudflare's authorization page say ([repo](https://github.com/cloudflare/workers-oauth-provider), [authorization](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)):

- **Standards.** It targets OAuth 2.1 and **MCP authorization 2026-07-28**. It implements PKCE (RFC 7636), Dynamic Client Registration (RFC 7591), protected resource metadata (RFC 9728) through `resourceMetadata`, and **Client ID Metadata Documents** (`clientIdMetadataDocumentEnabled`, which needs the `global_fetch_strictly_public` compatibility flag). Enterprise-Managed Authorization is experimental. The library needs Node 24+ for development.
- **Two deployment shapes:**
  - **Split** (now recommended): `OAuthAuthorizationServer` runs in one Worker. `OAuthResourceServer` in the MCP Worker validates tokens by calling `validateToken` over a Service Binding.
  - **Single Worker** (still supported): `new OAuthProvider({ apiRoute: "/mcp", apiHandler, defaultHandler, authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register", scopesSupported, requiredScopes, resourceMetadata })`.
- **Storage.** Everything lives in a KV namespace bound as **`OAUTH_KV`**: clients, grants and tokens. **Tokens, codes and secrets are stored only as hashes**, and props are encrypted with a key that only the token holder can unwrap. Consequence: the server cannot read a user's props without that user's token. That is fine, because props should hold only `userId`, the vault list and scopes.
- **Plugging in our own login.** This is the designed path, not a workaround. `defaultHandler` owns `/authorize` and does three things:
  1. calls `env.OAUTH_PROVIDER.parseAuthRequest(request)`, which validates the client, redirect URI, resource and PKCE;
  2. shows our own UI: passkey sign-in, then consent with a vault picker;
  3. calls `completeAuthorization({ request, userId, scope, props, metadata })` and redirects to the URL it returns.

  The library also has helpers for a consent page that cannot be framed or forged: `describeConsent`, `beginConsent`, `approveConsent` and `denyConsent`. Use them. `beginUpstream`/`finishUpstream` exist only for delegating to a third-party IdP, which we do not want.
- **Scopes.** `requiredScopes` is *advertised, not enforced*. The handler must check `ctx.auth.scope` itself and return `insufficientScope(ctx.auth, [...])`.
- **Resource URL.** The `resource` value must exactly match the URL clients connect to, path included (`https://cairn.example.com/mcp`). Tokens are bound to it.

**Single Worker or split?** For self-hosting with one `wrangler deploy`, use the single-Worker `OAuthProvider`: one script, one domain, and `/.well-known/*` served at the root. The split shape suits a fleet of MCP servers behind one authorization server, which Cairn is not. Revisit only if we ever host many Cairns behind a shared login *(inferred)*.

### 1.3 What Claude requires today

From [claude.com/docs/connectors/building/authentication](https://claude.com/docs/connectors/building/authentication.md). The same rules apply to claude.ai, Desktop, mobile, Cowork and Claude Code.

- **Discovery.**
  - Unauthenticated `/mcp` must return **`401`** with `WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/oauth-protected-resource"`. A `WWW-Authenticate` header on a `200` is ignored.
  - In the RFC 9728 document, `resource` must equal the URL the user typed, and Claude uses **only the first** entry of `authorization_servers`.
  - The authorization server must serve RFC 8414 metadata.
  - Without the pointer, Claude probes `/.well-known/oauth-protected-resource/<path>` and then the root.
- **Client registration.** DCR and CIMD are both supported by default. Claude uses CIMD only if the AS metadata advertises `"client_id_metadata_document_supported": true` **and** `"none"` in `token_endpoint_auth_methods_supported`; otherwise it falls back to DCR. **Enable both.**
- **PKCE S256** on every request. Advertise `code_challenge_methods_supported: ["S256"]`.
- **Callbacks.**
  - Hosted apps: `https://claude.ai/api/mcp/auth_callback`.
  - Claude Code: a loopback redirect on an ephemeral port. Its CIMD declares `http://localhost/callback` and `http://127.0.0.1/callback`, so the AS must **match both with the port ignored**.
- **Tokens.** Claude adds `offline_access` if it is listed in `scopes_supported`. The token endpoint must:
  - accept `application/x-www-form-urlencoded` (DCR uses JSON);
  - return `invalid_grant` for a dead refresh token;
  - **rotate refresh tokens** for public clients.
- **Response times.** Discovery, registration and token endpoints have 10 s; refresh has 30 s. That is easy on Workers.
- **Network.** Traffic comes from `160.79.104.0/21`. Don't put a WAF challenge in front of `/.well-known` or `/oauth/*`.
- **Consent page.** It must show the redirect URI's hostname, with an extra warning when the only registered redirects are loopback addresses (MCP spec 2025-11-25).

Not confirmed against the library source, so **test before trusting**: whether its redirect matching is port-agnostic for `localhost`, and whether it rotates refresh tokens. See Open questions.

### 1.4 Templates to crib from

Cloudflare's authorization page lists demos in `cloudflare/ai/demos/`:
- `mcp-stytch-consumer-todo-list`
- `mcp-stytch-b2b-okr-manager`
- `remote-mcp-auth0`
- `remote-mcp-authkit` (WorkOS)
- `remote-mcp-server-descope-auth`

They all delegate login to an IdP. The wiring to copy is the auth-server and resource-server split in the authorization page's own example, which uses a placeholder `user` and the comment "Replace with your own sign-in and consent page". Cairn does exactly that, swapping in a passkey ceremony with SimpleWebAuthn (see `auth.md`).

---

## 2. Storage

### 2.1 Options compared

| | D1 | SQLite Durable Object | R2 |
|---|---|---|---|
| FTS5 | **Yes**, plus `fts5vocab`, JSON and math ([D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/)) | **Yes**: same extension set ([DO SQL API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) | n/a |
| Size | 10 GB per DB *(from memory of the D1 limits page; not re-read)* | **10 GB per object** (the FAQ says 1 GB on Free; the docs contradict themselves). Free accounts get 5 GB in total ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)) | effectively unlimited |
| Row / value | 2 MB | 2 MB per row/string/BLOB, 100 columns, 100 bound params, 100 KB statement | 5 TB object |
| Recovery | Time Travel | **PITR: 30 days**: `getBookmarkForTime()` plus `onNextSessionRestoreBookmark()`. Not available in local dev | versioning is your job |
| Free plan | yes | **yes** | yes |
| Isolation | shared DB, so tenancy is enforced in SQL | **physical, per object** | per key prefix |
| Compute | separate from the DB (a network hop per query) | **code runs next to the data**; single-threaded, so writes are serialised for free | n/a |

DO pricing on Paid, which uses the same row rates as D1:
- 1M requests per month included, then $0.15/M;
- 25B rows read per month included, then $0.001/M;
- 50M rows written per month included, then $1/M;
- 5 GB-month storage included, then $0.20/GB-month (storage billing began 2026-01-07).

Free gets 100k requests, 5M rows read and 100k rows written **per day**, with 5 GB in total. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

**Recommendation: a SQLite DO per vault is the source of truth.**
- Every note operation touches exactly one vault, and in a DO the FTS5 query, the link-graph walk and the write run in the same process without network hops.
- Single-threaded execution removes a whole class of races: concurrent edits from two agents, or link resolution during a rename.
- A vault's data is one file with 30-day PITR.
- Per-tenant blast radius is tiny.

D1 fits poorly as the note store because every user shares one 10 GB database, every query needs a `vault_id` predicate that is correct forever, and every FTS query pays a network hop. **D1 is the right home for the small global directory**: users, passkey credentials, vaults, memberships and invites. Those are cross-tenant lookups such as "which vaults can this user see" and "find the user by credential id", and D1 is auto-provisioned by `wrangler deploy`. A singleton "directory" DO could replace D1. That would save one binding but lose dashboard browsing and `wrangler d1 execute`, so I'd keep D1.

**Push back on "per user": key by vault.**
- Jeff wants multi-user and team use. If the unit is the user, sharing becomes cross-DO fan-out and copying.
- With vault as the unit, a personal vault is one DO, a family vault is another, and membership lives in D1.
- MCP props carry the vault ids the grant covers. Tools take an optional `vault` argument and default to the user's personal vault.
- Search across several vaults is a fan-out over 2–5 DOs followed by a merge, which is cheap at this scale.

**R2 does not hold markdown blobs.** Notes are small: a 2 MB row limit against typical notes of 1–20 KB. Keeping them in SQLite makes FTS5, links and transactions trivial. R2 holds:
- attachments (images, PDFs), keyed `vault/<id>/att/<sha256>`;
- generated export zips and scheduled backups (a markdown snapshot per vault per night, for a disaster-recovery story beyond the 30-day PITR).

DO SQLite has no built-in "dump to file" outside PITR, so our own export *is* the backup format. Make it lossless: frontmatter carries ids and timestamps.

Schema notes for the vault DO *(inferred)*:
- `notes(id, permalink, title, type, body, frontmatter_json, checksum, updated_at)`;
- `observations` and `relations` tables, Basic Memory style;
- an external-content FTS5 table (`content='notes'`) kept in sync by triggers;
- `chunks(id, note_id, ord, text, hash, embedded_model, embedded_at)`, which drives re-embedding.

Consume `sql.exec` cursors synchronously, because holding one across an `await` loses snapshot isolation. Use `transactionSync` for multi-statement writes, and watch the 50-byte `LIKE` pattern limit, which is another reason to use FTS5 for search.

### 2.2 Vectorize, not vectors in SQLite

Vectorize facts from the [limits](https://developers.cloudflare.com/vectorize/platform/limits/), [filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) and [pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) pages:

**Limits**
- 20M vectors per index, up to 1,536 dims (float32).
- **Namespaces per index: 50,000 on Paid, 1,000 on Free.**
- 10 metadata indexes per index, and only the first 64 bytes of an indexed string are filterable.
- 10 KiB of metadata per vector.
- topK is at most 50 when values or metadata are returned, 100 otherwise.
- Upserts take up to 1,000 vectors per batch from a Worker.

**Filtering**
- The namespace filter is applied before metadata filters, and filters are applied *before* the ANN search. A per-vault namespace therefore gives true isolation, not just post-filtering.
- Metadata indexes must exist **before** vectors are inserted; otherwise the vectors must be re-upserted.

**Pricing**
- Stored: 10M dims included, then $0.05 per 100M dims.
- Queried: 50M dims included, then $0.01 per 1M.
- Free includes 5M stored and 30M queried dims.
- The doc's worked example (10k vectors, 768 dims, 30k queries → $0.31) only works out if *queried dims ≈ (queries + stored vectors) × dims* per month *(inferred from the example)*. At personal scale that is cents.

**Not auto-provisioned by `wrangler deploy`** (§6), and dimensions are fixed when the index is created.

Why not embeddings in DO SQLite? There is no vector extension, so search would be brute-force cosine in JS.
- A heavy vault of ~60k chunks at 1,024 dims is ~240 MB of float32, larger than the **128 MB isolate memory**.
- Even int8 at 256 Matryoshka dims, ~15 MB, means scanning everything on every query, burning DO CPU and adding latency as the vault grows.

Vectorize is on the Free plan, cheap, and isolates by namespace. The costs: an extra resource to create, eventual consistency (new vectors become queryable after a delay *(inferred, from Vectorize's known async-mutation behaviour)*), and a hard dependency on the remote service in tests.

Mitigations:
- **SQLite stays authoritative.** Vectorize is a rebuildable index, keyed by `chunkId` with metadata `{noteId, type, updated}`.
- A `reindex` admin action replays `chunks` into Vectorize.
- Keyword search (FTS5) keeps working if Vectorize is down or still catching up, the same graceful degradation second-brain-cloudflare reports.

**Retrieval pipeline.** Hybrid by default:
1. FTS5 BM25 top-50 and Vectorize top-50 for the vault namespace.
2. Merge with reciprocal-rank fusion.
3. Optionally rerank the top-20 with `bge-reranker-base`.
4. Expand along relations by one hop for context.

Cloudflare's own Agent Memory does essentially the same thing: parallel keyword, topic-key, vector and raw search, merged with diversity, and abstaining when nothing matches ([how it works](https://developers.cloudflare.com/agent-memory/concepts/how-agent-memory-works/)).

### 2.3 Workers AI embedding and reranker models

Prices from [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (the free allocation is 10,000 neurons per day; beyond that, $0.011 per 1k neurons). Dims and context come from the model cards *(not stated on the CF catalog page)*.

| Model | Dims | Context | $/M tokens | Notes |
|---|---|---|---|---|
| `@cf/qwen/qwen3-embedding-0.6b` | 1024 (MRL, can truncate) | 32k | **$0.012** | multilingual, newest, instruction-prefixed queries |
| `@cf/baai/bge-m3` | 1024 | 8k | **$0.012** | multilingual; used by the `mcp-memory` template |
| `@cf/google/embeddinggemma-300m` | 768 | 2k | not on the pricing page | **Beta** |
| `@cf/baai/bge-small/base/large-en-v1.5` | 384/768/1024 | 512 | $0.020/$0.067/$0.204 | English-only; old and dearer |
| `@cf/pfnet/plamo-embedding-1b` | — | — | $0.019 | Japanese |
| `@cf/baai/bge-reranker-base` | reranker | — | **$0.003** | the only reranker in the catalog |

At 1,075 neurons per M tokens, the **free 10k neurons a day covers ~9M embedded tokens a day**, so embedding cost is effectively zero for personal use.

**Choose `qwen3-embedding-0.6b` at 1024 dims.** It costs the same as bge-m3, has a longer context, and scores better on MTEB *(inferred from public MTEB results, not CF docs)*. Store `embedded_model` per chunk so a model change becomes a background re-embed into a new index. Avoid the Beta embeddinggemma as a default.

---

## 3. Background work

| Mechanism | Use in Cairn |
|---|---|
| **DO alarms** | **Primary.** A note write marks its chunks dirty and sets an alarm a few seconds out (debounced). The alarm embeds in batches, upserts to Vectorize and records `embedded_at`. It retries naturally (on failure, set the alarm again with backoff). No extra resource is needed and the work runs next to the data. |
| **Workflows** | Long multi-step LLM jobs: consolidation or "dreaming" (cluster near-duplicates, propose merges, write summary notes), re-embedding a whole vault after a model change, importing a Basic Memory export. Durable steps with retries. On Free: 1,024 steps, **10 ms CPU per step**, 100 concurrent; on Paid: 10k steps and 30 s to 5 min CPU per step ([limits](https://developers.cloudflare.com/workflows/reference/limits/)). |
| **Cron Triggers** | One nightly cron that lists vaults from D1 and kicks each vault's DO, which decides whether to start a consolidation Workflow and writes the nightly R2 snapshot. |
| **Queues** | **Leave out for v1.** They are on Free (10k operations per day, 24 h retention) and auto-provisioned ([pricing](https://developers.cloudflare.com/queues/platform/pricing/)), but DO alarms already give per-vault serialisation and retries for embedding. Add Queues only for cross-vault fan-out at scale. |

Ideas worth taking from Cloudflare Agent Memory, which is in private beta and so not something to build on, but is a good design reference:
- typed memories with different lifecycles (facts and instructions supersede, events accumulate, tasks decay);
- topic keys so an update supersedes instead of duplicating;
- deterministic content-hash ids for idempotent re-ingestion;
- keeping raw source text next to extracted items.

---

## 4. Web UI, static assets and routing

Workers Static Assets with `run_worker_first` as an **array of route patterns** ([routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)):

```jsonc
"assets": {
  "directory": "./dist/client",
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/mcp", "/mcp/*", "/authorize", "/oauth/*", "/.well-known/*", "/api/*", "/auth/*", "/export/*"]
}
```

Everything else is served as an asset at no Worker CPU cost, falling back to `index.html` for client routes.

Composition, one Worker:

```
OAuthProvider
 ├─ apiRoute "/mcp"  → apiHandler: createMcpHandler(...)    (token already validated; ctx.props)
 └─ defaultHandler   → Hono app
      ├─ /authorize, /auth/passkey/*  (server-rendered Hono JSX: login + consent, no SPA dependency)
      ├─ /api/*  (viewer REST API, session cookie, same DO RPC methods the MCP tools use)
      └─ /export/*  (zip stream)
```

**Hono** is the right router. It is tiny, native to Workers and has typed `c.env`, and since `createMcpHandler` is just a fetch handler it also mounts under Hono if we ever leave `OAuthProvider`'s `apiRoute`.

For the viewer, build a small SPA with **Vite and `@cloudflare/vite-plugin`**, which runs the Worker in workerd during `vite dev` *(inferred: the plugin's documented purpose, not re-read)*. React or Preact are both fine; the graph view needs a client library such as Cytoscape or sigma.js. Keep the login and consent pages server-rendered, so they work without the SPA bundle and can carry a strict CSP and the anti-framing headers.

The viewer and MCP must share one code path: Hono `/api` and MCP tools both call the vault DO's RPC methods, so behaviour cannot drift.

---

## 5. Local development and testing

- **`wrangler dev`** runs Miniflare/workerd locally. KV, D1, R2, DO (including SQLite) and alarms work offline. **Workers AI always runs against your account and bills even locally**, and Vectorize also needs the remote service ([wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/); second-brain-cloudflare reports the same). Both therefore need `wrangler login` or remote bindings. PITR does not work locally.
- **Testing package renamed.** `@cloudflare/vitest-pool-workers` is now **`@cloudflare/vitest-plugin` 1.0**. A codemod handles the move (`npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`), the `cloudflareTest` configuration is unchanged, and outbound mocking moves to `@msw/cloudflare` ([migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/)).
- **Testing caveats** ([known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)):
  - storage is isolated *per test file*;
  - no V8 coverage (use Istanbul);
  - fake timers don't affect KV or R2;
  - no dynamic `import()` in DO handlers;
  - DO WebSockets need `--no-isolate`, which doesn't matter to us.
- **DO SQLite in tests.** Direct DO access through `runInDurableObject` from `cloudflare:test` is the long-standing API *(inferred: not re-read on the 2026 pages; confirm when scaffolding)*.
- **What to mock:** Workers AI and Vectorize. Put both behind interfaces (`Embedder`, `VectorIndex`), and in tests and offline dev use a deterministic fake embedder (hash → vector) plus an in-memory cosine index. That keeps the whole suite offline, with no Cloudflare credentials, which also suits the agent sandboxes. Add one opt-in `test:remote` smoke suite later.
- Add `mise` tasks: `dev` (wrangler or vite dev), `test` (vitest), `check` (typecheck, lint, test).

---

## 6. Self-hosting

- **Deploy to Cloudflare button** ([docs](https://developers.cloudflare.com/workers/platform/deploy-buttons/)):
  - It clones a **public GitHub or GitLab repo** into the user's account and builds it with Workers Builds.
  - It **auto-provisions KV, D1, R2, Vectorize, DO, Workers AI, Queues** and Secrets Store secrets, writing ids back into the config.
  - Secrets are listed in `.dev.vars.example`; binding help text lives under `cloudflare.bindings` in `package.json`.
  - D1 migrations run in the `deploy` script, by binding name.
  - Monorepo support is partial: the Worker must be self-contained in its directory.
  - Workflows are not listed, but they need no provisioning because they are declared in config *(inferred)*.
- **Plain `wrangler deploy`** now auto-provisions **KV, R2, D1, Queues** (plus AI Search and Agent Memory) when the binding has no id, writing the ids back to the config. **Vectorize is not included**, so the CLI path needs one `wrangler vectorize create cairn --dimensions=1024 --metric=cosine` first, plus `wrangler vectorize create-metadata-index` for `type`. Wrap that in a `mise run setup` / `npm run setup` script that is idempotent.
- **Required resources:**
  - KV `OAUTH_KV`;
  - D1 `DB`;
  - DO class `Vault` (`new_sqlite_classes` migration);
  - Vectorize `VECTORS`;
  - R2 `FILES`;
  - AI binding;
  - (later) a Workflow;
  - one cron;
  - secrets: a cookie/session signing key, and the WebAuthn RP ID and origin as vars.
  - Compatibility flags: `nodejs_compat` and `global_fetch_strictly_public` (for CIMD).

### Free vs Paid

Everything Cairn needs exists on Free: DO SQLite, Vectorize (100 indexes, 1,000 namespaces), Workers AI (10k neurons/day), Queues, Workflows and D1.

The real Free constraint is **10 ms CPU per Worker request** ([limits](https://developers.cloudflare.com/workers/platform/limits/)). The work *inside* the DO has its own 30 s budget per request ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). So if the Worker stays a thin router (OAuth token check, MCP JSON-RPC parse, an RPC to the DO), Free is plausible. Each RPC to the DO counts as a DO request (100k a day on Free), and big zips and consolidation want Paid. The MCP SDK's schema validation and the OAuth library's crypto may push individual requests past 10 ms *(inferred; measure)*.

**Position:** Free works for trying it out; recommend **Workers Paid ($5/month)** for real use.

### Cost estimates (Paid plan, $5/month minimum)

| | Heavy personal user | 10-user family/team |
|---|---|---|
| Notes / chunks | 20k / 60k | 60k / 200k (10 personal and 2 shared vaults) |
| DO + Worker requests | ~300k/mo, within the included 1M (Workers requests also have their own 10M/mo included *(from memory)*) | ~2M/mo → ~$0.15 |
| SQLite rows | well within the included 25B read / 50M written | same |
| SQLite storage | <1 GB, within the included 5 GB | ~3 GB, within 5 GB |
| Vectorize stored | 61M dims → ~$0.03 | 205M dims → ~$0.10 |
| Vectorize queried | 30k queries: (30k+60k)×1024 ≈ 92M → ~$0.42 | 200k queries: ≈ 410M → ~$3.60 *(depends on how queried dims are counted per namespace; assumed worst case)* |
| Workers AI embeddings | ~5M tokens/mo, inside the free daily neurons → ~$0 | ~30M/mo → ~$0–0.40 |
| Reranker | 20 docs × 30k queries × ~300 tokens ≈ 180M tokens → ~$0.55 | ~$3.70 |
| LLM consolidation (optional) | small model, nightly: $0.5–2 | $2–8 |
| **Total** | **≈ $5/month** (the minimum covers it) | **≈ $5–15/month** |

R2 storage for attachments is pennies until it reaches tens of GB. The reranker is the most expensive optional line, so make it a setting.

---

## 7. Zip export

- **Where it runs.** Generate inside the **vault DO**: it has the data locally and a 30 s CPU budget even on Free. Stream the result through the Worker as a `ReadableStream` response with `Content-Disposition: attachment`.
- **Library.** Use **`fflate`'s streaming `Zip`** with `ZipPassThrough` (store) or `ZipDeflate` per file, pushing chunks into a `TransformStream`. It is small, pure JS and works in Workers, but has **no ZIP64**, which is irrelevant below 4 GB or 65k entries. **`zip.js`** has ZIP64 and streaming, but in Workers, turn off the native `CompressionStream` ("deflate-raw"), which hits [workerd#992](https://github.com/gildas-lormeau/zip.js/discussions/514). Sources: [dev.to: streaming ZIP64 on Workers](https://dev.to/ryan_e200dd10ede43c8fc2e4/how-i-built-streaming-zip64-on-cloudflare-workers-128mb-ram-no-filesystem-3aaf), [3 ways to zip R2 files](https://dev.to/ryan_e200dd10ede43c8fc2e4/3-ways-to-zip-files-stored-on-cloudflare-r2-2b7d).
- **Constraints.**
  - 128 MB isolate memory: stream, and never buffer the whole archive.
  - An error halfway through leaves the client with a truncated zip, because the headers are already sent.
  - R2 multipart parts must be ≥ 5 MB except the last.
- **Two modes.** Small vaults stream directly. Large vaults, or ones with many attachments, run as a Workflow that writes `exports/<vault>/<ts>.zip` to R2 by multipart upload, then returns a signed or authenticated download link. The nightly backup reuses this second path.
- **Contents.** One `.md` per note with Basic Memory–compatible frontmatter. Use **relative markdown links** (`[Title](../folder/note.md)`) as well as, or in place of, `[[wikilinks]]` so the export reads well in any viewer. Include an `attachments/` folder and a `manifest.json` (ids, checksums, model, version) so the export doubles as a lossless import.

---

## 8. Existing "memory MCP on Cloudflare" projects

- **[puliczek/mcp-memory](https://github.com/Sarakael78/mcp-memory)** (the template most forks start from): Workers AI `bge-m3`, Vectorize at 1024 dims (cosine), D1 for text, an `McpAgent` DO. It is now pre-v2 in API terms. *Lesson:* the basic D1 + Vectorize split works, but it has no auth story and no notes or relations model.
- **[rahilp/second-brain-cloudflare](https://github.com/rahilp/second-brain-cloudflare)** (~277★, v3):
  - D1 with FTS, Vectorize at 384 dims (bge-small), KV;
  - OAuth plus a bearer-token fallback; it **removed query-string tokens** in v3;
  - a Deploy button and a nightly cron for "semantic compression";
  - dedupe and contradiction checks on capture, importance-weighted recall, Obsidian and CLI clients.

  *Lessons:*
  - keyword recall must keep working when Vectorize is down;
  - redeploy after a D1 Time Travel restore so triggers are recreated (we avoid this, because DO schema migrations run in the constructor *(inferred)*);
  - offline dev needs a harness, because the AI binding needs login;
  - English-only embeddings were a regret, which they fixed with a multilingual option.
- **foundation42/engram:** D1 + Vectorize + Queues. It consolidates memories that are >95% similar by having an LLM merge them. *Lesson:* consolidation by similarity threshold plus LLM merge is the common pattern. Make it a reviewable proposal, not a silent rewrite.
- **Cloudflare Agent Memory** (private beta since April 2026; profiles and namespaces; ingest, recall, forget, list; `agent_memory` binding): the first-party competitor and a strong design reference (§3). It is not a substitute: it is opaque extraction from conversations, with no markdown notes, relations or export, and it is beta-gated. Cairn's differentiator is human-readable, linkable notes that you own and export.
- Gap in all of them: none combines passkey multi-user, shared vaults, a markdown-with-links export and a graph viewer. That is Cairn's niche.

---

## Recommendations for Cairn

1. **One Worker, single-Worker `OAuthProvider`** (`@cloudflare/workers-oauth-provider`, latest):
   - `apiRoute: "/mcp"` goes to a stateless `createMcpHandler` using `@modelcontextprotocol/server` (SDK v2);
   - `defaultHandler` is a Hono app owning `/authorize` with our passkey login and consent (using the library's consent helpers);
   - enable **both CIMD and DCR**, advertise `offline_access` and `S256`, set the `global_fetch_strictly_public` flag.

   Do **not** use `McpAgent`, SSE or a third-party IdP.
2. **One SQLite Durable Object per vault (not per user)** is the source of truth: notes, observations, relations, an FTS5 index, a chunk table, and all business logic exposed as DO RPC methods shared by MCP and the web API. A personal vault per user is created on sign-up; shared vaults come through membership.
3. **D1 for the directory:** users, WebAuthn credentials, vaults, memberships, invites, audit log. **KV only for `OAUTH_KV`.**
4. **Vectorize with one index and a namespace per vault**, 1024 dims, cosine, with a `type` metadata index created before the first insert. Treat it as a rebuildable cache of SQLite chunks. Search is hybrid: FTS5 BM25 plus vectors, merged by RRF, with optional `bge-reranker-base` and a one-hop relation expansion.
5. **Embeddings: `@cf/qwen/qwen3-embedding-0.6b`**, with the model id recorded per chunk. Embed from a **debounced DO alarm** loop; no Queue.
6. **Workflows** for consolidation, re-embedding, import and large exports; **one nightly cron** that kicks vault DOs (consolidation proposals and an R2 markdown snapshot).
7. **R2 only for attachments, exports and nightly snapshots.** Notes stay in SQLite.
8. **Web UI:** Static Assets with a `run_worker_first` route list, server-rendered auth pages (Hono JSX), and a Vite SPA viewer with a graph library.
9. **Export:** `fflate` streaming zip generated in the DO; markdown with relative links plus `manifest.json`; an R2-backed Workflow path for big vaults.
10. **Testing:** `@cloudflare/vitest-plugin`, with fakes for `Embedder` and `VectorIndex` so CI and agents run fully offline.
11. **Self-hosting:**
    - a Deploy button for most people;
    - a `setup` script that creates the Vectorize index and metadata index (the only resource `wrangler deploy` won't make), then `wrangler deploy`;
    - document that Free works for trying it, and recommend Paid for real use.

**Deliberately leave out:**
- `McpAgent` and stateful sessions: deprecated, and nothing needs them;
- SSE;
- Queues in v1;
- the split auth/resource Workers: more deploy surface for no gain to a self-hoster;
- third-party IdPs: passkeys are the product;
- R2 as the note store;
- vectors in SQLite;
- Cloudflare **AI Search** (AutoRAG) and **Agent Memory** as backends: opaque, beta, and not built around user-owned markdown;
- query-string tokens.

## Open questions

1. **Loopback redirects and refresh rotation.** Does `workers-oauth-provider` match `localhost`/`127.0.0.1` redirects port-agnostically, and does it rotate refresh tokens for public clients? Claude Code needs the first and Claude's docs require the second. Verify in source, or with a test against the Claude Code CIMD (`https://claude.ai/oauth/claude-code-client-metadata`), early in the spike.
2. **Free-plan CPU.** Does a `/mcp` request with SDK v2 validation plus OAuth unwrap fit in **10 ms Worker CPU** on Free? Measure in the spike; if not, state "Paid required" up front.
3. **Vectorize query billing.** Is queried-dimension billing per namespace or per index (this matters for the team estimate), and how long is the insert-to-queryable lag today? Read the full pricing FAQ or measure.
4. **Embedding model lock-in.** Is Jeff comfortable with qwen3-embedding (Alibaba model, CF-hosted) as the default? Switching later means a new index and a re-embed (cheap, but a migration).
5. **Vault model.** Do we want a "personal plus shared vaults" model from day one (my recommendation), or strictly per-user, as Jeff's lean implied? This affects the DO key and the MCP tool signatures. **This one is product-shaped:** worth confirming with Jeff before scaffolding.
6. **Single Worker vs split.** Cloudflare now recommends split-role. Confirm that the single-Worker `OAuthProvider` keeps parity, including CIMD and step-up scopes, in the current major version.
7. **Testing helpers.** Does `@cloudflare/vitest-plugin` 1.x still expose `runInDurableObject` and alarm triggering for SQLite DOs? Check when scaffolding.
