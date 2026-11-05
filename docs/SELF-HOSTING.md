# Self-hosting Cairn

The long version of the README's "Deploy your own": what you need, every setting, the optional
pieces (email, attachments, semantic search), updates, backups, and what goes wrong.

**The short way:** `npm run setup:cloudflare -- --url https://cairn.example.com` (or no `--url`
for workers.dev) does §2–§5 in one go and is safe to rerun; `--dry-run` shows what it would do.

Cairn is one Cloudflare Worker. Your notes live in Durable Objects (one SQLite database per
project) in your Cloudflare account; nothing is sent anywhere else.

## Contents

1. [What you need](#1-what-you-need)
2. [Create the resources](#2-create-the-resources)
3. [Configure `wrangler.jsonc`](#3-configure-wranglerjsonc)
4. [Secrets](#4-secrets)
5. [Deploy](#5-deploy)
6. [First run](#6-first-run)
7. [Optional: email capture](#7-optional-email-capture)
8. [Optional: attachments (R2)](#8-optional-attachments-r2)
9. [Semantic search and AI features](#9-semantic-search-and-ai-features)
10. [Deploy to Cloudflare button](#deploy-to-cloudflare-button)
11. [Continuous deployment](#11-continuous-deployment)
12. [Updating](#12-updating)
13. [Backups](#13-backups)
14. [Costs and limits](#14-costs-and-limits)
15. [Troubleshooting](#15-troubleshooting)
16. [Removing an instance](#16-removing-an-instance)

## 1. What you need

- A Cloudflare account. **Workers Paid ($5/month) is recommended**: Free allows 10 ms of CPU per
  Worker request, and Cairn's CPU per request hasn't been measured against that (see §14).
- [mise](https://mise.jdx.dev), which installs the right Node (24), or Node 24 yourself.
- This repository (or your fork): `git clone https://github.com/jclement/cairn && cd cairn && npm ci`.
- Optional: a domain on the same Cloudflare account (for a custom hostname and for email capture).

Authenticate wrangler once: `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` (a token with Workers, D1, KV, R2, Vectorize, Workers AI and, for a custom
domain, Workers Routes / DNS edit permissions).

## 2. Create the resources

```sh
npx wrangler d1 create cairn                                         # the directory database
npx wrangler kv namespace create cairn-oauth                         # OAuth clients and grants
npx wrangler vectorize create cairn-notes --dimensions=1024 --metric=cosine   # semantic search
npx wrangler r2 bucket create cairn-files                           # attachments (optional, §8)
```

Note the D1 `database_id` and the KV `id` that the first two print. The Durable Object class, the
rate-limit bindings, Workers AI and the static assets need no creation step. Recent wrangler
versions can create D1/KV/R2 on first deploy if a binding has no id; Vectorize they can't, so
create it by hand either way.

## 3. Configure `wrangler.jsonc`

**This repository's top-level config is the maintainer's instance.** For your own instance change
at least these (`npm run setup:cloudflare` does it for you):

| Setting | What to set |
|---|---|
| `d1_databases[0].database_id` | your D1 id |
| `kv_namespaces[0].id` | your KV id |
| `routes` | your custom domain (`{ "pattern": "cairn.example.com", "custom_domain": true }`, zone on the same account), or delete it and use `*.workers.dev` (`workers_dev: true` is already set) |
| `vars.PUBLIC_URL` | the exact URL people will use, e.g. `https://cairn.example.com` or `https://cairn.<you>.workers.dev` |
| `vars.INBOUND_EMAIL_ADDRESS` | your capture address (§7), or delete it to turn email capture off |

**`PUBLIC_URL` matters more than anything else.** Passkeys are bound to its hostname and every
POST must come from its origin; OAuth metadata is built from it. Changing it later makes every
existing passkey unusable (users would need recovery codes). Pick it before anyone signs up.

Other settings (top-level `vars`):

| Var | Default | Meaning |
|---|---|---|
| `APP_NAME` | `Cairn` | shown in the app and on the OAuth consent page |
| `OPEN_SIGNUP` | `"true"` here | `"false"` makes sign-up invite-only (anyone with an account can invite; admins always can; the setup token always admits) |
| `INVITES_PER_USER` | `5` | outstanding invite links a non-admin may hold |
| `EMBEDDING_MODEL` | `@cf/qwen/qwen3-embedding-0.6b` | embeddings (1024 dimensions, matching the Vectorize index). Changing it later means re-embedding. |
| `JEV_MODEL` | `typesafe/jev` | the judgement model for write hints and re-ranking; `""` turns them off |
| `DIGEST_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | the Monday digest's summariser |
| `VISION_MODEL` | `@cf/meta/llama-4-scout-17b-16e-instruct` (in code) | image captions; `""` turns them off |
| `BM_COMPAT` | `"false"` | `"true"` also registers Basic Memory's `bm_*` tool names (`bm_search`, `bm_write`, …) as aliases of Cairn's tools, for skills written for Basic Memory |
| `AI_DAILY_TOKENS` | `1000000` | per-user daily AI token budget; when spent, AI extras stop for the day and everything else keeps working |

The `env.local` section is only for `mise run dev` and the tests; leave it alone. (It sets
`routes: []` on purpose: if the local environment inherited your production route, `wrangler dev`
would rewrite Origin to it and every local form POST would fail the CSRF check.)

The cron trigger (`0 3 * * *`) runs nightly maintenance: expiring observations, the gardening note
and the Monday digest, and attachment recovery. Keep it.

## 4. Secrets

```sh
openssl rand -base64 32 | tee /dev/tty | npx wrangler secret put CAIRN_SETUP_TOKEN
```

Whoever presents this token at sign-up, or later in Settings → Admin, becomes an admin. Nobody is
an admin by default. Keep it in your password manager; you can rotate it with the same command.
`.dev.vars.example` lists it for local development (`cp .dev.vars.example .dev.vars`).

## 5. Deploy

```sh
mise run deploy
```

which runs, in order: the browser build (`node scripts/build-client.mjs` into `public/app/dist/`
and the Tailwind CSS into `public/app/ui/app.css`), `wrangler d1 migrations apply DB --remote`,
`wrangler deploy`. `npm run deploy` does the same without mise.

Check it: `curl https://<PUBLIC_URL host>/health` returns `{"ok":true,"version":"0.1.0"}`, and
`curl -X POST https://<host>/mcp` returns 401 with a `WWW-Authenticate` header.

## 6. First run

1. Open `PUBLIC_URL`, choose **Sign up**, pick a username and create a passkey. Save the 10
   recovery codes it shows (each signs you in once, only to add a new passkey).
2. To become an admin, open the *Setup token (admins only)* field at sign-up, or later Settings →
   Admin, and paste `CAIRN_SETUP_TOKEN`.
3. Add a second passkey (Settings → Account) so losing one device isn't a recovery event.
4. Connect an assistant (README → *Connect an assistant*): the MCP URL is `PUBLIC_URL/mcp`.

## 7. Optional: email capture

Users can email notes in. You need Email Routing on a domain in the same account.

1. Set `vars.INBOUND_EMAIL_ADDRESS`, e.g. `cairn@example.com`, and deploy.
2. Cloudflare dashboard → your zone → **Email** → **Email Routing** → enable it if it isn't (it adds
   MX/TXT records), then **Routing rules** → *Create address*: custom address = the local part,
   action **Send to a Worker**, destination = your Cairn Worker.
3. Optional: Email Routing **Settings** → enable **subaddressing**, so `cairn+KEY@example.com`
   reaches the same rule.

Each user creates a private inbox key in **Settings → Capture**. Mail is accepted when:

- it is sent to `cairn+KEY@…` (subaddressing on), or
- its subject starts with `[k:KEY]`, or
- it comes from an address on the user's trusted-sender list **and** Cloudflare's own
  `Authentication-Results` (authserv-id `mx.cloudflare.net`) shows DMARC pass, or DKIM pass for an
  aligned domain. Headers inside the message are never trusted.

Mail becomes a note in the user's default project under `inbox/` (frontmatter `source: email`,
`from`, `date`, `message_id`; a resend of the same Message-ID is ignored), attachments become files
(§8). Anything else is rejected with a generic "Unknown recipient". Messages are capped at 25 MB
and 20 attachments.

To test: send yourself a message with `[k:YOURKEY]` in the subject and look in `inbox/`. To verify
the trusted-sender path, send from an allowlisted address and check the note arrives; if it doesn't
while the key forms work, Cloudflare's result for that sender isn't a pass.

## 8. Optional: attachments (R2)

With the `FILES` binding (the `cairn-files` bucket from §2), users can drop or paste files into the
editor, clip files, receive email attachments, and attach over MCP (`attach_file`). Without it,
those paths refuse politely.

- 10 MB per file; each file is charged its size plus a small fixed overhead against the user's
  50 MB quota; at most 5,000 files per user.
- Only sniffed PNG/JPEG/GIF/WebP/AVIF are shown inline; every other type, SVG included, downloads.
- Images get an AI caption (`VISION_MODEL`) that becomes their alt text, so search finds them.
- Exports include the files under `<project>/attachments/`.

## 9. Semantic search and AI features

Without the `VECTORIZE` and `AI` bindings, Cairn still works: search is keyword-only (FTS5), and
write hints, re-ranking, captions and digests are off. With them, search fuses keyword and meaning,
and the AI extras run within each user's daily budget (`AI_DAILY_TOKENS`). Workers AI usage shows
on `/app/stats` per user and per model.

## Deploy to Cloudflare button

Once the repository is public, a [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
button can clone it into the deployer's account, provision D1, KV, R2, Vectorize, Workers AI and
the Durable Object from `package.json` → `cloudflare.bindings`, prompt for `CAIRN_SETUP_TOKEN`
(listed in `.dev.vars.example`) and run `npm run deploy` (build, migrations, deploy):

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jclement/cairn)
```

It can't know your URL, and the copy it makes still carries the maintainer's route and
`PUBLIC_URL`. Right after it finishes, in your new repository set `routes` to `[]` (or your
domain) and `PUBLIC_URL` to the new `https://cairn.<you>.workers.dev`, and redeploy, **before
anyone signs up**. This path hasn't been tried end to end; the script above is the tested one.

## 11. Continuous deployment

`.github/workflows/deploy.yml` runs `mise run check` on every push to `main`; if green, a job in the
`production` GitHub environment runs `mise run deploy` and smoke-tests `/health`, the OAuth metadata
and `/mcp` at the `PUBLIC_URL` in `wrangler.jsonc`. For your fork: commit your `wrangler.jsonc`,
and add the `CLOUDFLARE_API_TOKEN` secret and the `CLOUDFLARE_ACCOUNT_ID` variable to a
`production` environment. The token's least-privilege permission list is in the README
(*Deploy from GitHub Actions*). `mise run smoke:live` and `mise run oauth:live` (with
`CAIRN_URL=` your instance) are fuller end-to-end checks; see the README's *Development*.

## 12. Updating

```sh
git pull
mise run setup     # if dependencies changed
mise run check     # optional but recommended
mise run deploy    # applies any new D1 migrations, then deploys
```

Migrations are numbered and applied in order; the Durable Objects upgrade their own SQLite schema on
first use. Upgrading a long-lived instance has been exercised only on the live instance itself; read
the commit log before jumping many versions.

## 13. Backups

- **Your notes:** Settings → *Download everything* (a zip of markdown, attachments included, after a
  passkey check). This is the portable backup and the exit door.
- **The directory (D1):** Cloudflare's D1 Time Travel restores the database to any point in the last
  30 days (Paid) or 7 days (Free): `npx wrangler d1 time-travel restore cairn --timestamp=…`.
- **Durable Object storage** has point-in-time recovery for SQLite-backed objects on Cloudflare's
  side; there is no Cairn command for it yet. A nightly R2 snapshot of every project is planned.

## 14. Costs and limits

From [research/cloudflare.md §6](research/cloudflare.md): a heavy personal user fits inside the
$5/month Paid minimum; a 10-person family or team is about $5–15/month, mostly Vectorize queries
and Workers AI. R2 for attachments is pennies until tens of GB. On Free, everything exists but the
10 ms CPU limit per request is the open question; if you see `Exceeded CPU` errors in the logs, move
to Paid.

Per-user limits built into Cairn: 1 MB per note, 50 MB per user (notes, retained history and
attachments), 20 projects, 60 writes and 60 searches a minute, plus the daily AI budget.

## 15. Troubleshooting

Start with a health check. `mise run prod:status` (with the deploy token in `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID`) reports the deployed version, migrations applied vs the repo, AI failure
rates by model and purpose, the last nightly cron run, counts, stuck imports, email ingestion and
the Vectorize index, and exits non-zero on a red flag. Admins see the same at `/app/admin/health`.

| Symptom | Likely cause |
|---|---|
| `{"error":"Cross-origin request refused."}` on every form | `PUBLIC_URL` doesn't match the URL in the browser (scheme, host and port must match). Locally: your `env.local` lost `routes: []` (see §3). |
| Passkey prompt fails / "no passkeys" | The site is served from a different hostname than `PUBLIC_URL` (passkeys are bound to it), or `PUBLIC_URL` changed after sign-up. |
| claude.ai says the connector failed | Check `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` return JSON with your `PUBLIC_URL`; check the user approved write if the assistant tried to write. |
| Search ignores meaning | No `VECTORIZE`/`AI` binding, or the Vectorize index doesn't exist or has the wrong dimensions (must be 1024). |
| "daily AI budget reached" | The user spent `AI_DAILY_TOKENS`; extras resume tomorrow (UTC). Raise the var if needed. |
| Uploads say attachments aren't configured | No `FILES` R2 binding; create the bucket and deploy. |
| Email never arrives as a note | No Email Routing rule to the Worker, the address doesn't match `INBOUND_EMAIL_ADDRESS`, `+KEY` used without subaddressing, or the sender is allowlisted but not DMARC/DKIM-aligned. Worker logs (`observability` is on) show rejections. |
| `wrangler dev` warns about `ai`/`vectorize` not in `env.local` | Expected: they need a Cloudflare login even locally. |

## 16. Removing an instance

Users can delete their own accounts (Settings → Account → Delete), which removes their projects,
vectors, files and directory rows. To remove the whole instance: `npx wrangler delete`, then delete
the D1 database, KV namespace, Vectorize index and R2 bucket, and the Email Routing rule.
