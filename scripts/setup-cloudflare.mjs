#!/usr/bin/env node
// One-command setup of your own Cairn on your Cloudflare account. Safe to run again: it reuses
// resources that already exist (by name) and never replaces an existing setup token unless asked.
//
//   npm run setup:cloudflare -- --url https://cairn.example.com     # a custom domain on your account
//   npm run setup:cloudflare                                         # your *.workers.dev URL
//   npm run setup:cloudflare -- --dry-run                            # show what it would do
//
// Options: --url <https://host>   the URL people will use (a custom domain whose zone is on this
//                                 Cloudflare account); without it, your workers.dev URL is used
//          --email <address>      email capture address (needs an Email Routing rule, see README)
//          --open-signup          anyone may sign up (default: invite-only; you join with the setup token)
//          --rotate-token         generate a new CAIRN_SETUP_TOKEN even if one is set
//          --dry-run              read only: list what exists and what would change
//
// It: checks `wrangler whoami`; creates (or finds) the D1 database `cairn`, the KV namespace
// `cairn-oauth`, the Vectorize index `cairn-notes` (1024 dimensions, cosine) and the R2 bucket
// `cairn-files`; writes their ids, PUBLIC_URL, routes, sign-up policy and email address into
// wrangler.jsonc (your copy; commit it to your fork); builds; applies the D1 migrations; deploys;
// and sets CAIRN_SETUP_TOKEN, printing it once.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicUrlOf, setInstanceValues } from "./lib/wrangler-config.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = flag("dry-run");
const CONFIG = "wrangler.jsonc";
const NAMES = { d1: "cairn", kv: "cairn-oauth", vectorize: "cairn-notes", r2: "cairn-files" };

const step = (msg) => console.log(`\n▸ ${msg}`);
const say = (msg) => console.log(`  ${msg}`);

function wrangler(argv, { input, quiet } = {}) {
  return execFileSync("npx", ["wrangler", ...argv], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", quiet ? "pipe" : "inherit"],
  });
}
function wranglerJson(argv) {
  const out = wrangler(argv, { quiet: true });
  const start = out.search(/[[{]/);
  return JSON.parse(out.slice(start));
}
function run(cmd, argv, env) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} failed`);
}

let url = opt("url");
if (url && !/^https:\/\/[a-z0-9.-]+$/i.test(url)) {
  console.error("--url must look like https://cairn.example.com (https, a host, no path)");
  process.exit(2);
}
url = url?.toLowerCase();
const email = opt("email") ?? "";

step("Checking the Cloudflare login");
try {
  wrangler(["whoami"], { quiet: true });
  say("logged in");
} catch {
  console.error("  Not logged in. Run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID) and try again.");
  process.exit(1);
}

step("Resources (created only if missing)");
// A distinctive title: another OAuth Worker on the account may own a namespace called OAUTH_KV,
// and sharing it would mix their clients and grants. (The binding is still OAUTH_KV.)
const isKv = (k) => k.title === NAMES.kv;
const d1 = wranglerJson(["d1", "list", "--json"]).find((d) => d.name === NAMES.d1);
const kv = wranglerJson(["kv", "namespace", "list"]).find(isKv);
let vec = null;
try {
  vec = wranglerJson(["vectorize", "list", "--json"]).find((v) => v.name === NAMES.vectorize);
} catch {
  vec = null;
}
const r2 = new RegExp(`^name:\\s+${NAMES.r2}\\s*$`, "m").test(wrangler(["r2", "bucket", "list"], { quiet: true }));
say(`D1 ${NAMES.d1}: ${d1 ? `exists (${d1.uuid})` : "to create"}`);
say(`KV ${NAMES.kv}: ${kv ? `exists (${kv.id})` : "to create"}`);
say(`Vectorize ${NAMES.vectorize}: ${vec ? `exists (${vec.config?.dimensions ?? "?"} dims)` : "to create (1024 dims, cosine)"}`);
say(`R2 ${NAMES.r2}: ${r2 ? "exists" : "to create"}`);
if (vec && vec.config?.dimensions && vec.config.dimensions !== 1024) {
  console.error(`  The existing Vectorize index ${NAMES.vectorize} has ${vec.config.dimensions} dimensions; Cairn needs 1024. Delete it or rename it first.`);
  process.exit(1);
}

const before = readFileSync(CONFIG, "utf8");
if (DRY) {
  step("Dry run: nothing was created or changed");
  say(`wrangler.jsonc would get: PUBLIC_URL=${url ?? "<your workers.dev URL, found by the first deploy>"}, routes=${url ? `custom domain ${new URL(url).host}` : "none (workers.dev)"}, OPEN_SIGNUP=${flag("open-signup")}, INBOUND_EMAIL_ADDRESS=${email || "(off)"}`);
  say(`currently: PUBLIC_URL=${publicUrlOf(before)}`);
  process.exit(0);
}

if (!d1) wrangler(["d1", "create", NAMES.d1]);
if (!kv) wrangler(["kv", "namespace", "create", NAMES.kv]);
if (!vec) wrangler(["vectorize", "create", NAMES.vectorize, "--dimensions=1024", "--metric=cosine"]);
if (!r2) wrangler(["r2", "bucket", "create", NAMES.r2]);
const d1Id = d1?.uuid ?? wranglerJson(["d1", "list", "--json"]).find((d) => d.name === NAMES.d1)?.uuid;
const kvId = kv?.id ?? wranglerJson(["kv", "namespace", "list"]).find(isKv)?.id;
if (!d1Id || !kvId) throw new Error("couldn't read back the D1 or KV id");

step("Writing your instance into wrangler.jsonc");
// Without --url the workers.dev URL isn't known until the first deploy; start with a placeholder.
let config = setInstanceValues(before, {
  d1Id,
  kvId,
  publicUrl: url ?? "https://cairn.invalid",
  customDomain: url ? new URL(url).host : null,
  email,
  openSignup: flag("open-signup"),
});
writeFileSync(CONFIG, config);
say("done (commit wrangler.jsonc to your fork so CI deploys the same instance)");

step("Building and applying the D1 migrations");
run("npm", ["run", "build"]);
run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]);

step("Deploying");
// wrangler writes structured results (including the deployed URLs) to this file; the console
// stays interactive, so its own prompts (e.g. registering a workers.dev subdomain) still work.
const outFile = join(mkdtempSync(join(tmpdir(), "cairn-setup-")), "wrangler-output.ndjson");
run("npx", ["wrangler", "deploy"], { WRANGLER_OUTPUT_FILE_PATH: outFile });
if (!url) {
  const targets = readFileSync(outFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "deploy")
    .flatMap((e) => e.targets ?? []);
  const found = targets.find((t) => /^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(t));
  if (!found) throw new Error("couldn't find the workers.dev URL in wrangler's output; rerun with --url https://<your URL>");
  url = found.toLowerCase();
  say(`your URL: ${url}; setting PUBLIC_URL and deploying again`);
  config = setInstanceValues(config, { publicUrl: url });
  writeFileSync(CONFIG, config);
  run("npx", ["wrangler", "deploy"]);
}

step("Setup token");
let haveToken = false;
try {
  haveToken = wranglerJson(["secret", "list", "--format", "json"]).some((s) => s.name === "CAIRN_SETUP_TOKEN");
} catch {}
if (haveToken && !flag("rotate-token")) {
  say("CAIRN_SETUP_TOKEN is already set (kept; --rotate-token makes a new one)");
} else {
  const token = randomBytes(32).toString("base64url");
  wrangler(["secret", "put", "CAIRN_SETUP_TOKEN"], { input: token, quiet: true });
  console.log(`\n  CAIRN_SETUP_TOKEN = ${token}\n  Save it in your password manager now; it is not shown again. Whoever enters it at sign-up becomes an admin.`);
}

step("Done");
say(`Open ${url}/signup, open "Setup token (admins only)", paste the token, and create your passkey.`);
say(`Then connect Claude: the MCP URL is ${url}/mcp (README → Connect Claude).`);
say(`Check: curl ${url}/health`);
