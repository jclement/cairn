#!/usr/bin/env node
// Production health check: `mise run prod:status` (add --json for machine output).
//
// Uses the deploy token from the environment (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID); the
// token is only ever sent to api.cloudflare.com and never printed. Reads the Worker name, D1
// database id and Vectorize index from wrangler.jsonc. Reports the deployed version, migrations
// applied vs the repo, AI failure rates, the nightly cron, counts (no content), stuck imports,
// email ingestion and the Vectorize index. Exits 1 when there is a red flag, 2 when it can't check.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectHealth } from "../src/stats/health.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");
const API = "https://api.cloudflare.com/client/v4";

/** Top-level values from wrangler.jsonc (the production config is everything before "env"). */
export function readConfig(text) {
  const top = text.split(/\n\s*"env"\s*:/)[0];
  const pick = (re, what) => {
    const m = re.exec(top);
    if (!m) throw new Error(`wrangler.jsonc: no ${what}`);
    return m[1];
  };
  return {
    worker: pick(/^\s*"name"\s*:\s*"([^"]+)"/m, "name"),
    database: pick(/"database_id"\s*:\s*"([^"]+)"/, "d1 database_id"),
    vectorIndex: pick(/"index_name"\s*:\s*"([^"]+)"/, "vectorize index_name"),
  };
}

function fail(message) {
  console.error(`prod:status: ${message}`);
  process.exit(2);
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) fail("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the deploy token) in the environment.");
  const cfg = readConfig(readFileSync(join(root, "wrangler.jsonc"), "utf8"));

  const cf = async (path, init = {}) => {
    const res = await fetch(`${API}/accounts/${account}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      const msg = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
      throw new Error(`${path.split("?")[0]}: ${msg}`);
    }
    return body.result;
  };
  const query = async (sql, params = []) => {
    const r = await cf(`/d1/database/${cfg.database}/query`, { method: "POST", body: JSON.stringify({ sql, params }) });
    return r?.[0]?.results ?? [];
  };

  // Every section degrades on its own (a failed check becomes a red flag).
  const health = await collectHealth(query);

  // Deployed version.
  let deployed = null;
  try {
    const d = await cf(`/workers/scripts/${cfg.worker}/deployments`);
    const latest = d?.deployments?.[0];
    if (latest)
      deployed = {
        deployed_at: latest.created_on,
        versions: (latest.versions ?? []).map((v) => `${v.version_id}${v.percentage === 100 ? "" : ` (${v.percentage}%)`}`),
        message: latest.annotations?.["workers/message"] ?? null,
      };
  } catch (e) {
    health.flags.push(`Worker: could not read deployments (${e.message})`);
  }

  // Migrations: repo vs applied.
  let repo = [];
  try {
    repo = readdirSync(join(root, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (e) {
    health.warnings.push(`Could not list migrations/ (${e.message})`);
  }
  const applied = new Set(health.migrations.applied);
  const pending = repo.filter((f) => !applied.has(f));
  const unknown = health.migrations.applied.filter((f) => !repo.includes(f));
  if (applied.size && pending.length) health.flags.push(`D1: ${pending.length} migration(s) in the repo not applied: ${pending.join(", ")}`);
  if (unknown.length) health.warnings.push(`D1: applied migration(s) not in this checkout: ${unknown.join(", ")}`);

  // Vectorize.
  let vectorize = null;
  try {
    const v = await cf(`/vectorize/v2/indexes/${cfg.vectorIndex}/info`);
    vectorize = { vectors: v.vectorCount, dimensions: v.dimensions, processed_up_to: v.processedUpToDatetime ?? null };
  } catch (e) {
    health.flags.push(`Vectorize: could not read ${cfg.vectorIndex} (${e.message})`);
  }

  const report = {
    ...health,
    worker: cfg.worker,
    deployed,
    migrations: { applied: health.migrations.applied, repo, pending, unknown },
    vectorize,
  };
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    try {
      print(report);
    } catch (e) {
      // Never lose the verdict to a formatting bug: fall back to the raw report.
      console.log(JSON.stringify(report, null, 2));
      console.error(`prod:status: could not format the report (${e.message})`);
    }
  }
  process.exit(health.flags.length ? 1 : 0);
}

function print(r) {
  const pct = (x) => `${(x * 100).toFixed(x && x < 0.01 ? 1 : 0)}%`;
  const out = [];
  out.push(`Cairn production status — ${r.generated_at}`);
  out.push(
    r.deployed
      ? `Worker ${r.worker}: deployed ${r.deployed.deployed_at}, version ${r.deployed.versions.join(", ")}${r.deployed.message ? ` ("${r.deployed.message}")` : ""}`
      : `Worker ${r.worker}: deployment unknown`,
  );
  const m = r.migrations ?? {};
  out.push(
    `D1 migrations: ${m.applied?.length ?? "?"} applied, ${m.repo?.length ?? "?"} in repo${m.pending?.length ? `, PENDING: ${m.pending.join(", ")}` : ""}${m.applied?.length ? `; latest ${m.applied.at(-1)}` : ""}`,
  );
  const c = r.counts;
  out.push(
    `Counts: ${c.users} users (${c.active_users} active), ${c.vaults} projects, ${c.notes} notes, ${(c.bytes / 1048576).toFixed(1)} MB, ${c.attachments} attachments`,
  );
  out.push(r.vectorize ? `Vectorize: ${r.vectorize.vectors} vectors, ${r.vectorize.dimensions} dims` : "Vectorize: unknown");
  for (const [label, rows] of [
    ["AI last 24 h", r.ai.last24h],
    ["AI last 7 days (context, not flagged)", r.ai.day7],
  ]) {
    out.push(`${label}:`);
    if (!rows.length) out.push("  (no calls)");
    for (const a of rows)
      out.push(`  ${a.flagged ? "!!" : "  "} ${a.model} / ${a.purpose}: ${a.calls} calls, ${a.failed} failed${a.unknown ? ` (${a.unknown} timed out)` : ""} (${pct(a.failure_rate)})`);
  }
  const run = r.cron.last_finished;
  out.push(
    run
      ? `Cron: last finished ${run.finished_at} (${run.status}; ${run.vaults} done, ${run.errors} failed, ${run.deferred} deferred)${run.error ? ` error: ${run.error}` : ""}; ${r.cron.runs_7d} run(s) in 7 days, ${r.cron.failed_7d} with failures`
      : "Cron: no finished run recorded",
  );
  out.push(`Imports stuck: ${r.imports.staging_stuck} staging, ${r.imports.running_stuck} running`);
  out.push(
    `Email in: ${r.email.day1.messages} since yesterday (${r.email.day1.attachments} attachments), ${r.email.day7.messages} in 7 days (${r.email.day7.attachments} attachments)`,
  );
  for (const w of r.warnings) out.push(`note: ${w}`);
  out.push(r.flags.length ? `\nRED FLAGS (${r.flags.length}):\n${r.flags.map((f) => `  - ${f}`).join("\n")}` : "\nOK: no red flags.");
  console.log(out.join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((e) => fail(e?.message ?? String(e)));
