#!/usr/bin/env node
// Deploy: apply the remote D1 migrations, then `wrangler deploy`. Extra arguments go to both
// wrangler commands (e.g. `--env owg`). Used by `npm run deploy` (the Deploy to Cloudflare button's
// Workers Builds runs it), `mise run deploy` and CI.
//
// The build's commit is passed to the Worker as CAIRN_COMMIT / CAIRN_COMMIT_TIME, so Settings →
// Admin can say when a newer Cairn is out. On a first CLI deploy of the template (no database yet)
// the migrations can't run until `wrangler deploy` has provisioned the database: then it deploys,
// migrates and deploys again.
import { execFileSync, spawnSync } from "node:child_process";

const extra = process.argv.slice(2);

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const sha = (process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || git(["rev-parse", "HEAD"])).trim();
const time = git(["log", "-1", "--format=%ct"]);
const vars = [];
if (/^[0-9a-f]{7,40}$/i.test(sha)) vars.push("--var", `CAIRN_COMMIT:${sha}`);
if (/^\d+$/.test(time)) vars.push("--var", `CAIRN_COMMIT_TIME:${time}`);

function wrangler(args, { capture = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], { stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit", encoding: "utf8", env: { ...process.env, CI: "true" } });
  if (capture) {
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
  }
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const migrate = () => wrangler(["d1", "migrations", "apply", "DB", "--remote", ...extra], { capture: true });
const deploy = () => wrangler(["deploy", ...vars, ...extra]);

let m = migrate();
if (!m.ok && /Couldn't find (an auto-provisioned )?(a )?D1 DB/i.test(m.out)) {
  console.log("\nThe D1 database doesn't exist yet: deploying once to provision it, then migrating.\n");
  if (!deploy().ok) process.exit(1);
  m = migrate();
}
if (!m.ok) process.exit(1);
if (!deploy().ok) process.exit(1);
