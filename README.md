# Cairn

Cairn is long-term memory for AI assistants that you run on your own Cloudflare account. Your
memory is a set of markdown notes with typed observations (`- [decision] …`), relations
(`- depends_on [[Other note]]`) and tags. Claude and other MCP clients read and write them over
OAuth; you browse, edit, search and export them in a web app. Search uses keywords and meaning
together, and every write returns a receipt saying what was saved, where and by which app.

It is one Cloudflare Worker: passkey sign-in (no passwords, no email), room for several people,
one SQLite Durable Object per project, and an export that hands back exactly the markdown you
wrote. The note format and tool behaviour follow [Basic Memory](https://github.com/basicmachines-co/basic-memory),
so Basic Memory projects and Obsidian vaults import as they are, and the export drops back into
either.

*(The landing page calls it a revolutionary emotionally intelligent recall paradigm. It is a
notes database with good manners.)*

## Contents

[Features](#features) · [Screenshots](#screenshots) · [Deploy your own](#deploy-your-own) ·
[Connect Claude](#connect-claude-and-other-assistants) · [Deploy from GitHub Actions](#deploy-from-github-actions) ·
[Costs and limits](#costs-and-limits) · [Security](#security) · [Backups and export](#backups-and-export) ·
[Upgrading](#upgrading) · [Troubleshooting](#troubleshooting) · [Development](#development) ·
[Licence](#licence)

## Features

**Memory and tools.** A remote MCP server at `/mcp` (streamable HTTP, OAuth 2.1 with PKCE,
dynamic client registration and client ID metadata documents, or a personal access token), with
these tools:

| Tool | What it does |
|---|---|
| `write_note` | Create or replace a note (by path, or title + folder); returns a receipt and write hints |
| `read_note` | Read by permalink, `memory://` URL, path or title; a section, line range or token budget |
| `edit_note` | Append, prepend, find/replace, replace or insert around a section, set frontmatter; checksum-guarded |
| `delete_note` | Delete a note, or a folder with `recursive` (the text stays in history) |
| `move_note` | Move or rename a note or folder; permalinks stay, so links keep resolving |
| `search_notes` | Hybrid search with tags, types, folders, frontmatter filters, observation categories, dates and paging |
| `find_notes` | Recursive find by file-name glob or frontmatter, with the fields you choose |
| `list_notes` | One folder level |
| `build_context` | A note and its linked notes in both directions, to a depth you choose |
| `recent_activity` | What changed lately, and which app changed it |
| `projects` | List or create projects (up to 20 per person) |
| `core_memory` | The always-loaded memory: an index note plus every `pinned: true` note, within a byte budget (also a prompt) |
| `supersede` | Replace a fact without losing it: the old one moves under `## Superseded`, dated |
| `attach_file` | Attach a file from a URL or base64 and embed it in a note |
| `check_schema` | Validate notes against [Picoschema](https://github.com/basicmachines-co/basic-memory) schemas, infer one, or show drift (`SCHEMA_ENABLED`) |
| `help` | The manual, generated from the tools' own schemas |

Every Basic Memory parameter is honoured or refused with a typed `INVALID` error, never silently
ignored. Set `BM_COMPAT=true` to also register Basic Memory's `bm_*` tool names, so skills
written for Basic Memory run unchanged.

**Around the notes.**

- Hybrid search: SQLite FTS5 fused with Workers AI embeddings in Vectorize. The top results are
  re-ranked by Jev, a small judgement model, which also says when nothing matches well. It falls
  back to keyword-only search without those bindings.
- Write hints: likely duplicates, conflicting facts and unresolved links come back with the
  receipt.
- Supersession and expiry: `(expires 2027-01-01)` facts retire themselves nightly. They are
  moved, never deleted.
- History for every note, with line diffs, one-click undo, and "undo everything app X did since T".
- Nightly gardening (opt-out): a checklist note of contradictions, orphans, unresolved links,
  near-duplicates and stale notes. A weekly digest on Mondays. Neither edits your notes.
- Web app: search as you type, a Ctrl/Cmd-K palette, a CodeMirror editor with `[[` completion,
  a link graph, GitHub-flavoured markdown with code highlighting, mermaid, callouts and footnotes,
  and light and dark themes.
- Capture: drag, paste or attach files (stored in R2; images get an AI caption so search finds
  them), a bookmarklet clipper, sharing from a phone (installable web app), and email in
  (optional).
- Import a Basic Memory project or Obsidian vault (.zip), keeping Basic Memory's permalinks and
  rewriting links to images and files. Export everything as a zip at any time.
- Accounts: passkeys, recovery codes, open or invite-only sign-up, invite links, admins who can
  disable accounts but cannot read anyone's notes, and deleting your own account (everything,
  vectors included).
- Agent skills (`cairn-notes`, `cairn-continue`, `cairn-capture`, `cairn-gardening`,
  `cairn-tasks`), served by your instance and packaged as a Claude Code plugin.

## Screenshots

*(To be added:)*

1. A note: observations, relations, backlinks and the receipt trail
2. Search with filters, and the Ctrl/Cmd-K palette
3. The editor with `[[` completion and live preview
4. The project graph
5. Activity: what each connected app changed, with undo
6. The consent page an assistant sends you to
7. Settings: connected apps, tokens, invites

## Deploy your own

About 15 minutes. You end up with Cairn at a URL you choose, and Claude connected to it.

### Prerequisites

- **A Cloudflare account.** [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/)
  ($5/month) is recommended. Everything Cairn uses exists on the Free plan, but Free allows 10 ms
  of CPU per request. Cairn hasn't been measured against that limit, and search, imports and
  exports can exceed it.
- **Node 24** (or [mise](https://mise.jdx.dev), which installs it from `mise.toml`), plus git
  and openssl.
- **Optional: a domain** whose DNS zone is on the same Cloudflare account. Without one, Cairn
  runs at `https://cairn.<your-subdomain>.workers.dev`. You need a domain for email capture.

**Choose the URL first.** Passkeys are bound to the hostname in `PUBLIC_URL`, and OAuth metadata
is built from it. If you change it after people sign up, every passkey stops working, and people
can only get back in with recovery codes.

### 1. Get the code and log in

```sh
git clone https://github.com/jclement/cairn.git
cd cairn
npm ci
npx wrangler login
```

If you will deploy from CI, fork the repository first and clone your fork, so you can commit
your `wrangler.jsonc`.

### 2a. One command

```sh
npm run setup:cloudflare -- --url https://cairn.example.com    # a custom domain on your account
npm run setup:cloudflare                                        # or: your workers.dev URL
```

`scripts/setup-cloudflare.mjs` runs these steps, and is safe to run again:

1. It checks the login.
2. It creates whatever doesn't exist yet: the D1 database `cairn`, the KV namespace
   `cairn-oauth`, the Vectorize index `cairn-notes` (1024 dimensions, cosine) and the R2 bucket
   `cairn-files`.
3. It writes their ids, `PUBLIC_URL`, the route and the sign-up policy into your
   `wrangler.jsonc`.
4. It builds, applies the D1 migrations and deploys. On workers.dev it reads the URL from the
   deploy and deploys again with that URL.
5. It generates `CAIRN_SETUP_TOKEN` and prints it once.

Options:

- `--open-signup`: anyone can sign up. The default is invite-only; you get in with the setup
  token.
- `--email cairn@example.com`: email capture (see [Email capture](#email-capture-optional)).
- `--dry-run`: show what exists and what would change, without changing anything.

Then go to [First sign-in](#4-first-sign-in). The manual steps below do the same thing by hand.

### 2b. By hand: create the resources

```sh
npx wrangler d1 create cairn
npx wrangler kv namespace create cairn-oauth
npx wrangler vectorize create cairn-notes --dimensions=1024 --metric=cosine
npx wrangler r2 bucket create cairn-files
```

Keep the D1 `database_id` and the KV `id` they print. The Durable Object, rate limiters, Workers
AI and static assets need no setup. The index must be 1024-dimensional, to match the default
embedding model `@cf/qwen/qwen3-embedding-0.6b`.

### 3. By hand: configure and deploy

`wrangler.jsonc` in this repository holds the maintainer's instance at the top level. In your
copy, change these top-level values (leave `env.local` alone; it is for local development):

| Key | Set it to |
|---|---|
| `d1_databases[0].database_id` | your D1 id |
| `kv_namespaces[0].id` | your KV id |
| `routes` | `[{ "pattern": "cairn.example.com", "custom_domain": true }]`, or `[]` for workers.dev only |
| `vars.PUBLIC_URL` | the exact URL people will use: `https://cairn.example.com` or `https://cairn.<subdomain>.workers.dev` |
| `vars.OPEN_SIGNUP` | `"true"` for anyone, `"false"` for invite-only |
| `vars.INBOUND_EMAIL_ADDRESS` | your capture address, or `""` to turn email capture off |

To find your workers.dev subdomain, open the Cloudflare dashboard and go to **Workers & Pages**.
The subdomain is shown there.

Set the setup token, then migrate and deploy:

```sh
openssl rand -base64 32 | tee /dev/tty | npx wrangler secret put CAIRN_SETUP_TOKEN
npm run deploy
```

`tee /dev/tty` shows the token once: save it in your password manager. `npm run deploy` builds
the browser bundles and CSS, runs `wrangler d1 migrations apply DB --remote`, then
`wrangler deploy`. `mise run deploy` does the same.

Check the deployment:

```sh
curl https://cairn.example.com/health            # {"ok":true,"version":"…"}
curl -i -X POST https://cairn.example.com/mcp    # 401 with a WWW-Authenticate header
```

### 4. First sign-in

1. Open `PUBLIC_URL` and choose **Sign up**. Pick a username and open **Setup token (admins
   only)**. Paste the token, then create your passkey. The token makes you an admin, and it
   lets you sign up even when sign-up is invite-only.
2. Save the 10 recovery codes it shows. Each one signs you in once, to add a new passkey.
3. Add a second passkey (Settings → Account), so losing one device isn't a recovery event.
4. Invite people from Settings → Invites. Each person may hold `INVITES_PER_USER` (default 5)
   open invite links, and admins have no limit. If you didn't use the token at sign-up, you can
   become admin later in Settings → Admin.

### Email capture (optional)

1. Set `vars.INBOUND_EMAIL_ADDRESS` (for example `cairn@example.com`) and deploy.
2. In the Cloudflare dashboard, open your domain and go to **Email → Email Routing**.
3. Enable Email Routing. It adds MX and TXT records.
4. Under **Routing rules**, create the custom address and set the action to **Send to a Worker**
   → `cairn`.
5. Optionally, turn on **subaddressing** in its settings, so `cairn+KEY@example.com` works.

Each person creates a private inbox key in Settings → Capture. Mail sent to `cairn+KEY@…`, with
`[k:KEY]` in the subject, or from a trusted sender that passes DMARC/DKIM becomes a note in
`inbox/`, with its attachments.

### AI features and Jev (optional)

Cairn calls Workers AI for four things:

- embeddings
- Jev (`typesafe/jev`): write hints and search re-ranking
- image captions
- the weekly digest

Jev is a third-party model served through Workers AI and billed to your account like the
others. Each call is time-boxed and charged to a per-user daily token budget
(`AI_DAILY_TOKENS`, default 1,000,000). When a user's budget runs out, the AI extras stop for the
rest of the day. Search and writes keep working.

To turn features off, set the model variable to `""`: `JEV_MODEL` for hints and re-ranking,
`VISION_MODEL` for captions. Usage per user and per model is shown at `/app/stats`. Without the
`AI` and `VECTORIZE` bindings Cairn still works, with keyword-only search and no extras.

### All settings

| `vars` key | In `wrangler.jsonc` | Meaning |
|---|---|---|
| `PUBLIC_URL` | (required) | The URL people use; passkeys and OAuth are bound to it |
| `APP_NAME` | `Cairn` | Shown in the app and on the consent page |
| `OPEN_SIGNUP` | `"true"` | `"false"` (or unset) makes sign-up invite-only |
| `INVITES_PER_USER` | `5` | Open invite links a non-admin may hold |
| `IMPORT_ENABLED` | `"true"` | The .zip import in Settings → Import (off unless `"true"`) |
| `SCHEMA_ENABLED` | `"true"` | The `check_schema` tool (off unless `"true"`) |
| `BM_COMPAT` | `"false"` | Also register Basic Memory's `bm_*` tool names |
| `EMBEDDING_MODEL` | `@cf/qwen/qwen3-embedding-0.6b` | Must match the index's 1024 dimensions; changing it means re-embedding |
| `JEV_MODEL` | `typesafe/jev` | `""` turns hints and re-ranking off |
| `VISION_MODEL` | (unset: `@cf/meta/llama-4-scout-17b-16e-instruct`) | Image captions; `""` turns them off |
| `DIGEST_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | The weekly digest |
| `AI_DAILY_TOKENS` | `1000000` | Per-user daily AI budget |
| `INBOUND_EMAIL_ADDRESS` | the maintainer's | Email capture address; `""` turns capture off |

The one secret is `CAIRN_SETUP_TOKEN`. `package.json` → `cloudflare.bindings` describes every
binding. [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) has the long version of each step.

## Connect Claude and other assistants

Your MCP URL is `PUBLIC_URL` + `/mcp`, and Settings in the app shows it. The first connection
sends you to Cairn, where you sign in with your passkey and allow **read** or **read and write**.

- **claude.ai and Claude Desktop:** Settings → Connectors → **Add custom connector**, then paste
  the URL.
- **Claude Code:**

  ```sh
  claude mcp add --transport http cairn https://cairn.example.com/mcp
  ```

  Then run `/mcp` in Claude Code, pick `cairn` and choose **Authenticate**. Alternatively, the
  repository is a plugin marketplace that adds the connection, the skills and a session-start
  reminder:

  ```sh
  export CAIRN_URL=https://cairn.example.com        # before starting Claude Code
  # in Claude Code:
  /plugin marketplace add jclement/cairn
  /plugin install cairn@cairn
  ```

  Use one way or the other, not both.
- **Codex CLI:** run `codex mcp add cairn --url https://cairn.example.com/mcp`, then
  `codex mcp login cairn`.
- **Anything else:** add a streamable-HTTP MCP server at the URL. A client without OAuth can use
  a personal access token from Settings: send `Authorization: Bearer cairn_pat_…`.

**Then paste one line into the assistant:**

```
Set up Cairn for me: read https://cairn.example.com/setup.md and follow it.
```

`/setup.md` is generated by your instance. It has the assistant check the connection and ask how
you'll use Cairn. Then it installs the matching skills from `/skills/` in the way that suits your
client, or gives you the download links on claude.ai. Settings → Connected apps lists every grant
with a revoke button.

## Deploy from GitHub Actions

`.github/workflows/deploy.yml` runs on every push to `main`:

1. A `check` job runs `mise run check` (typecheck, lint, tests, probes).
2. If that is green, a `deploy` job runs in the `production` environment. It runs
   `mise run deploy` (migrations, then deploy) and smoke-tests `/health`, the OAuth metadata and
   `/mcp` at the `PUBLIC_URL` in `wrangler.jsonc`.

For your fork:

1. Commit your `wrangler.jsonc` (ids, route and `PUBLIC_URL`; there are no secrets in it).
2. In GitHub, go to **Settings → Environments** and create `production`. Add a **secret**
   `CLOUDFLARE_API_TOKEN` and a **variable** `CLOUDFLARE_ACCOUNT_ID`. The account id is shown in
   the dashboard's account home and in `npx wrangler whoami`.
3. Create the token at **My Profile → API Tokens → Create Token → Custom token**, with only these
   permissions:

   | Scope | Permission | Why |
   |---|---|---|
   | Account | Workers Scripts: Edit | upload the Worker, its assets, Durable Object and cron |
   | Account | D1: Edit | `d1 migrations apply --remote` |
   | Account | Workers KV Storage: Edit | the `OAUTH_KV` binding |
   | Account | Workers R2 Storage: Edit | the `FILES` binding |
   | Account | Vectorize: Edit | the `VECTORIZE` binding |
   | Account | Account Settings: Read | wrangler's account lookup |
   | Zone (your zone only) | Workers Routes: Edit | the custom-domain route; omit for workers.dev |
   | User | User Details: Read, Memberships: Read | wrangler's identity check |

   Scope it to your account (and your zone only). If a deploy fails with an authorization
   error naming a resource, add that resource's permission. `mise run prod:status` (the health
   report under [Troubleshooting](#troubleshooting)) reuses this token: it queries D1, reads the
   Vectorize index and lists deployments, all covered above.

The secret `CAIRN_SETUP_TOKEN` is set once with `wrangler secret put`. It survives deploys, and
CI never needs it.

## Costs and limits

From the estimates in [docs/research/cloudflare.md §6](docs/research/cloudflare.md):

| | Heavy personal user | 10-person family or team |
|---|---|---|
| Workers, Durable Objects, D1, KV | within Paid's included amounts | ~$0.15 |
| Vectorize | ~$0.45 | ~$3.70 |
| Workers AI (embeddings, Jev, captions, digest) | ~$0–2 | ~$2–8 |
| R2 (attachments) | pennies | pennies |
| **Total** | **≈ $5/month** (the Paid minimum) | **≈ $5–15/month** |

These are estimates, not measurements. `AI_DAILY_TOKENS` caps what any one person can spend on
AI.

Built-in limits per person:

- 1 MB per note
- 50 MB in all (notes, history and attachments)
- 20 projects
- 10 MB per file and 5,000 files
- 60 writes and 60 searches a minute
- imports of up to 20 MB and 5,000 files per zip

Sign-in and OAuth are rate-limited per IP, and invite changes per person.

## Security

The full threat model and how to report a vulnerability are in [docs/SECURITY.md](docs/SECURITY.md).

- **Passkeys only**, bound to `PUBLIC_URL`. Recovery codes are hashed and single-use, and are
  good only for adding a passkey.
- **Sessions** are opaque, hashed, `__Host-` cookies (HttpOnly, Secure, SameSite=Lax). Every
  POST must carry `PUBLIC_URL`'s Origin. Exports, account deletion and changes to credentials
  need a fresh passkey check.
- **Isolation:** each project is its own Durable Object with its own SQLite database. It is
  reached only after D1 confirms you own it. Admins cannot read notes.
- **OAuth:** 1-hour access tokens and rotating refresh tokens. Read or write scope is chosen at
  consent, and grants can be revoked. Tokens and PATs are stored only as hashes.
- **Untrusted content:** notes render without raw HTML under a strict CSP. Tools return note
  text as data. Attachments are served by sniffed type, and non-images download. Server-side
  fetches refuse private addresses.
- **Your data stays in your account:** nothing leaves Cloudflare. The AI calls go to Workers AI
  on your own account.

## Backups and export

- **Export:** Settings → **Download everything** gives a zip of every project. Notes are
  byte-for-byte as stored, attachments are included, and there is an index. It drops into Basic
  Memory or Obsidian. Each note also has a raw `.md` download.
- **D1** (accounts and the directory): `npx wrangler d1 time-travel restore cairn --timestamp=…`
  restores to any point in the last 30 days (Paid) or 7 days (Free).
- **Notes** live in Durable Object SQLite, which Cloudflare keeps with point-in-time recovery.
  There is no Cairn command for that restore yet, so the export is your portable backup.

## Upgrading

```sh
git pull                 # or merge upstream into your fork
npm ci
npm run deploy           # applies new D1 migrations (migrations/), then deploys
```

The Durable Objects upgrade their own SQLite schema on first use. With CI, pushing the merge to
`main` does all of this. Read the commit log before jumping many versions.

## Troubleshooting

`mise run prod:status` (with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set) reports:

- the deployed version
- migrations applied vs pending
- AI failure rates
- the last nightly run
- stuck imports
- email ingestion
- the Vectorize index

It exits non-zero on a red flag. Admins see the same at `/app/admin/health`.

| Symptom | Cause |
|---|---|
| Every form says *Cross-origin request refused* | The browser's URL doesn't match `PUBLIC_URL` exactly (scheme, host, port). This is common when the site is opened at workers.dev while `PUBLIC_URL` is the custom domain, or the other way round. |
| Passkey prompt fails or finds no passkey | Passkeys belong to `PUBLIC_URL`'s hostname. A passkey made on workers.dev doesn't work on your custom domain, or the other way round. If `PUBLIC_URL` changed after sign-up, use a recovery code and add a new passkey. |
| claude.ai can't connect | `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` must return JSON naming your `PUBLIC_URL`. A custom domain must be the route, not just DNS. |
| `Exceeded CPU` in the logs | You're on the Free plan; move to Workers Paid. |
| Search ignores meaning | No `AI`/`VECTORIZE` binding, or the index isn't 1024-dimensional. |
| *daily AI budget reached* | That person spent `AI_DAILY_TOKENS`. The budget resets at midnight UTC. |
| Uploads say attachments aren't configured | The `FILES` R2 bucket is missing. |
| Email never arrives | Check, in order: the Email Routing rule, `INBOUND_EMAIL_ADDRESS`, subaddressing for `+KEY`, and the sender's DMARC/DKIM. Worker logs show rejections. |
| `wrangler deploy` says *You must use a real database* | `database_id` is still the maintainer's. Put yours in (step 3). |

## Development

```sh
mise run setup                   # npm ci
cp .dev.vars.example .dev.vars   # optional: a local setup token, offline semantic search
mise run dev                     # http://localhost:8787 (local D1 migrations + bundles first)
mise run test                    # vitest inside workerd, offline
mise run check                   # lint + tests + parser probes: the gate for every change
```

Other tasks:

- `mise run lint` (typecheck, biome, plugin-skill drift; read-only)
- `mise run fmt`
- `mise run build:client`
- `mise run migrate:local`
- `mise run plugin:sync` (copies `skills/` into the plugin and the Worker)

`mise tasks` lists them all.

The `local` environment in `wrangler.jsonc` has no Workers AI or Vectorize, because both need a
Cloudflare login even under `wrangler dev`. Search there is keyword-only unless you set
`CAIRN_FAKE_EMBEDDINGS=1`. Locally only, `GET /app/dev-login?u=<name>` signs you in without a
passkey, for headless UI checks.

**Live checks against your instance.** Both scripts create a throwaway account and delete it
afterwards, and both need Playwright with Chromium:

```sh
npm install --no-save playwright && npx playwright install chromium    # once
CAIRN_URL=https://cairn.example.com mise run smoke:live    # sign-up, app pages, PAT, MCP, export, deletion
CAIRN_URL=https://cairn.example.com mise run oauth:live    # Claude Code, claude.ai and DCR OAuth flows
```

With an existing install, point the scripts at it with `PLAYWRIGHT=/path/to/playwright/index.mjs`
and `CHROMIUM_PATH=/path/to/chrome`. Your instance must allow sign-up (`OPEN_SIGNUP="true"`) for
the throwaway account.

### Layout

```
src/index.ts      Worker entry: OAuth provider, /mcp, email() and scheduled() handlers
src/vault/        VaultDO, one SQLite Durable Object per project: notes, FTS5, revisions, search
src/mcp/          the MCP tools, receipts, instructions, the core_memory prompt
src/memory/       supersession, history, nightly gardening and digest
src/capture/      attachments (R2), email, clipper, SSRF-guarded fetch
src/jev/          Jev hints and re-ranking
src/web/          the Hono app: viewer, editor, settings, consent, export, import
src/client/       browser code, bundled into public/app/dist/
migrations/       D1 migrations
skills/, plugin/  agent skills and the Claude Code plugin
docs/             DESIGN.md, SELF-HOSTING.md, SECURITY.md, research/
```

## Licence

Not chosen yet. The proposal is **MIT**: a short, permissive licence that suits a self-hosted
tool people are meant to fork. `package.json` already says `MIT`, but no licence is granted until
a `LICENSE` file is added. Cairn's note format and tool names follow Basic Memory's published
documentation; it contains no Basic Memory (AGPL) code. owg-css is MIT.
