#!/usr/bin/env node
// One-command setup of your own Cairn on your Cloudflare account. Safe to run again: it reuses
// resources that already exist (by name) and never replaces an existing setup token unless asked.
//
//   npm run setup:cloudflare -- --url https://cairn.example.com     # a custom domain on your account
//   npm run setup:cloudflare                                         # your *.workers.dev URL
//   npm run setup:cloudflare -- --dry-run                            # show what it would do
//
// (The no-terminal alternative is the Deploy to Cloudflare button in the README.)
//
// Options: --url <https://host>   pin the URL (a custom domain whose zone is on this Cloudflare
//                                 account): sets PUBLIC_URL and the route. Without it, PUBLIC_URL
//                                 stays empty and the address you claim the site at is recorded
//          --email <address>      email capture address (needs an Email Routing rule, see README)
//          --open-signup          anyone may sign up (default: invite-only)
//          --setup-token          also set a CAIRN_SETUP_TOKEN secret, printed once (instead of the
//                                 claim code; --rotate-token replaces an existing one)
//          --dry-run              read only: list what exists and what would change
//
// It: checks `wrangler whoami`; creates (or finds) the D1 database `cairn`, the KV namespace
// `cairn-oauth`, the Vectorize index `cairn-notes` (1024 dimensions, cosine) and the R2 bucket
// `cairn-files`; writes their ids, routes, sign-up policy, email address (and PUBLIC_URL with --url)
// into the top level of wrangler.jsonc (your copy; commit it); builds; applies the D1 migrations;
// deploys. Then you open the site and claim it with the one-time code from `npx wrangler tail`.
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
  say(`wrangler.jsonc would get: PUBLIC_URL=${url ?? "(empty: recorded when you claim the site)"}, routes=${url ? `custom domain ${new URL(url).host}` : "none (workers.dev)"}, OPEN_SIGNUP=${flag("open-signup")}, INBOUND_EMAIL_ADDRESS=${email || "(off)"}`);
  say(`currently: PUBLIC_URL=${publicUrlOf(before) || "(empty)"}`);
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
// Without --url, PUBLIC_URL is left as it is (empty in the template): the claim records the URL.
const config = setInstanceValues(before, {
  d1Id,
  kvId,
  ...(url ? { publicUrl: url } : {}),
  customDomain: url ? new URL(url).host : null,
  email,
  openSignup: flag("open-signup"),
});
writeFileSync(CONFIG, config);
say("done (commit wrangler.jsonc so later deploys reach the same instance)");

step("Building");
run("npm", ["run", "build"]);

step("Applying the D1 migrations and deploying");
// wrangler writes structured results (including the deployed URLs) to this file; the console
// stays interactive, so its own prompts (e.g. registering a workers.dev subdomain) still work.
const outFile = join(mkdtempSync(join(tmpdir(), "cairn-setup-")), "wrangler-output.ndjson");
run("node", ["scripts/deploy.mjs"], { WRANGLER_OUTPUT_FILE_PATH: outFile });
if (!url) {
  const targets = readFileSync(outFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "deploy")
    .flatMap((e) => e.targets ?? []);
  const found = targets.find((t) => /^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(t));
  url = found ? found.toLowerCase() : "https://<your worker>.workers.dev";
}

let haveToken = false;
if (flag("setup-token") || flag("rotate-token")) {
  step("Setup token");
  try {
    haveToken = wranglerJson(["secret", "list", "--format", "json"]).some((s) => s.name === "CAIRN_SETUP_TOKEN");
  } catch {}
  if (haveToken && !flag("rotate-token")) {
    say("CAIRN_SETUP_TOKEN is already set (kept; --rotate-token makes a new one)");
  } else {
    const token = randomBytes(32).toString("base64url");
    wrangler(["secret", "put", "CAIRN_SETUP_TOKEN"], { input: token, quiet: true });
    haveToken = true;
    console.log(`\n  CAIRN_SETUP_TOKEN = ${token}\n  Save it in your password manager now; it is not shown again. Whoever enters it at sign-up becomes an admin.`);
  }
}

step("Done");
if (haveToken) say(`Open ${url}/signup, open "Setup token (admins only)", paste the token, and create your passkey.`);
else {
  say(`Claim your Cairn: run \`npx wrangler tail\` in another terminal, open ${url}, and enter the one-time`);
  say("claim code it prints (also under Worker → Logs in the Cloudflare dashboard). You become the admin.");
}
say(`Then connect Claude: the MCP URL is ${url}/mcp (README → Connect Claude).`);
say(`Check: curl ${url}/health`);
