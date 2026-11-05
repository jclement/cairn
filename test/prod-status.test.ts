import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { CRON_RUNS_KEPT, recordNightly } from "../src/memory/cron";
import { collectHealth, type Query } from "../src/stats/health";
import { caller, defaultVault, makeUser } from "./helpers";
import { fetchWorker } from "./oauth";

const lastRun = () =>
  env.DB.prepare("SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1").first<{
    id: number;
    started_at: string;
    finished_at: string | null;
    status: string;
    vaults: number;
    errors: number;
    deferred: number;
    error: string | null;
    summary: string | null;
  }>();

const hourNow = () => new Date().toISOString().slice(0, 13);

const d1: Query = async (sql, params = []) =>
  (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>()
  ).results;

describe("cron runs are recorded in D1", () => {
  it("the scheduled() handler records a finished run with vault counts", async () => {
    const { user } = await makeUser("cron");
    const { vault } = await defaultVault(user.id);
    // Due for expiry, so the run does one vault task.
    await env.DB.prepare("UPDATE vaults SET next_expiry = '2000-01-01' WHERE id = ?").bind(vault.id).run();
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: "0 3 * * *", noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    const r = await lastRun();
    expect(r?.status).toBe("ok");
    expect(r?.finished_at).toBeTruthy();
    expect(r?.vaults).toBeGreaterThanOrEqual(1);
    expect(r?.errors).toBe(0);
    const summary = JSON.parse(r?.summary ?? "{}");
    expect(summary.expired.vaults).toBeGreaterThanOrEqual(1);
    expect(summary.expired.results).toBeUndefined(); // counts only
  });

  it("vault task failures make the run 'errors'; a thrown run is 'failed' with its message, and rethrows", async () => {
    const { user } = await makeUser("cron-err");
    const { vault } = await defaultVault(user.id);
    await env.DB.prepare("UPDATE vaults SET next_expiry = '2000-01-01' WHERE id = ?").bind(vault.id).run();
    const brokenVaults = {
      ...env,
      VAULT: {
        getByName: () => {
          throw new Error("DO unavailable");
        },
      },
    } as unknown as typeof env;
    await recordNightly(brokenVaults, new Date());
    const e = await lastRun();
    expect(e?.status).toBe("errors");
    expect(e?.errors).toBeGreaterThanOrEqual(1);

    const brokenDb = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare")
            return (sql: string) => {
              if (sql.includes("v.next_expiry")) throw new Error("D1 exploded");
              return target.prepare(sql);
            };
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }),
    } as typeof env;
    await expect(recordNightly(brokenDb, new Date())).rejects.toThrow("D1 exploded");
    const f = await lastRun();
    expect(f?.status).toBe("failed");
    expect(f?.error).toBe("D1 exploded");
    expect(f?.finished_at).toBeTruthy();
  });

  it(`keeps the newest ${CRON_RUNS_KEPT} runs`, async () => {
    const stmt = env.DB.prepare("INSERT INTO cron_runs (started_at, finished_at, status) VALUES ('2000-01-01', '2000-01-01', 'ok')");
    await env.DB.batch(Array.from({ length: CRON_RUNS_KEPT + 20 }, () => stmt));
    await recordNightly(env, new Date());
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM cron_runs").first<{ n: number }>();
    expect(n?.n).toBe(CRON_RUNS_KEPT);
  });
});

describe("health checks", () => {
  it("flags AI failure rates over 10%, a stale or failed cron, and stuck imports", async () => {
    const now = new Date();
    const { user } = await makeUser("health");
    const { vault } = await defaultVault(user.id);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ai_hourly (hour, model, purpose, calls, failed) VALUES (?, 'typesafe/jev', 'search_rerank', 20, 20)").bind(hourNow()),
      env.DB.prepare("INSERT INTO ai_hourly (hour, model, purpose, calls, failed) VALUES (?, '@cf/x', 'embed', 100, 1)").bind(hourNow()),
      env.DB.prepare("INSERT INTO ai_hourly (hour, model, purpose, calls, failed) VALUES (?, '@cf/y', 'digest', 2, 2)").bind(hourNow()),
      env.DB.prepare("INSERT INTO import_jobs (id, user_id, vault_id, status, created_at) VALUES (?, ?, ?, 'staging', '2000-01-01T00:00:00Z')").bind(
        `stuck-${crypto.randomUUID()}`,
        user.id,
        vault.id,
      ),
      env.DB.prepare(
        "INSERT INTO cron_runs (started_at, finished_at, status, error) VALUES ('2000-01-01T03:00:00Z', '2000-01-01T03:01:00Z', 'failed', 'boom')",
      ),
    ]);
    const h = await collectHealth(d1, now);
    const jev = h.ai.last24h.find((r) => r.model === "typesafe/jev" && r.purpose === "search_rerank");
    expect(jev?.flagged).toBe(true);
    expect(h.ai.last24h.find((r) => r.model === "@cf/x")?.flagged).toBe(false); // 1%
    expect(h.ai.last24h.find((r) => r.model === "@cf/y")?.flagged).toBe(false); // too few calls to judge
    expect(h.flags.some((f) => f.startsWith("AI typesafe/jev / search_rerank"))).toBe(true);
    expect(h.flags.some((f) => f.startsWith("Cron: no run finished"))).toBe(true);
    expect(h.flags).toContain("Cron: the last run failed: boom");
    expect(h.flags.some((f) => f.startsWith("Imports:"))).toBe(true);
    expect(h.migrations.applied).toContain("0013_cron_runs.sql");

    // A fresh successful run clears the cron flags.
    await recordNightly(env, new Date());
    const after = await collectHealth(d1, new Date());
    expect(after.flags.filter((f) => f.startsWith("Cron:"))).toEqual([]);
  });
});

describe("/app/admin/health access", () => {
  it("anonymous -> sign in; a non-admin -> 403; an admin sees counts, never note content", async () => {
    const anon = await fetchWorker("/app/admin/health");
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toMatch(/^\/login/);

    const plain = await makeUser("not-admin");
    const denied = await fetchWorker("/app/admin/health", { headers: { cookie: plain.cookie } });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("Production health");

    const admin = await makeUser("admin");
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(admin.user.id).run();
    const { stub, ref } = await defaultVault(plain.user.id);
    const secret = `health-canary-${crypto.randomUUID()}`;
    const w = await stub.writeNote(ref, caller(plain.user), { title: `Secret ${secret}`, directory: "private", content: `body ${secret}` });
    expect(w.ok).toBe(true);
    const ok = await fetchWorker("/app/admin/health", { headers: { cookie: admin.cookie } });
    expect(ok.status).toBe(200);
    const page = await ok.text();
    expect(page).toContain("Production health");
    expect(page).toContain("Nightly cron");
    expect(page).not.toContain(secret);
    expect(page).not.toContain(plain.user.username); // not even who has notes
  });
});

describe("health checks degrade instead of throwing", () => {
  it("a query that fails flags that section and the rest still report", async () => {
    const flaky: Query = async (sql, params) => {
      if (/FROM ai_daily|FROM ai_hourly|FROM cron_runs/.test(sql)) throw new Error("D1 timeout");
      return d1(sql, params);
    };
    const h = await collectHealth(flaky, new Date());
    expect(h.flags).toContain("AI: check failed (D1 timeout)");
    expect(h.flags).toContain("Cron: check failed (D1 timeout)");
    expect(h.ai).toEqual({ last24h: [], day7: [] });
    expect(h.counts.users).toBeGreaterThan(0);
    expect(h.migrations.applied.length).toBeGreaterThan(0);
    // Nothing answers at all: still a report, every section flagged.
    const dead = await collectHealth(async () => {
      throw new Error("no D1");
    });
    expect(dead.flags.filter((f) => f.endsWith("check failed (no D1)"))).toHaveLength(6);
  });

  it("timed-out calls are part of failed, so the rate never exceeds 100%", async () => {
    await env.DB.prepare("INSERT INTO ai_hourly (hour, model, purpose, calls, failed, unknown_calls) VALUES (?, 'rate/model', 'write_hints', 10, 10, 3)")
      .bind(hourNow())
      .run();
    const r = (await collectHealth(d1)).ai.last24h.find((x) => x.model === "rate/model");
    expect(r?.failure_rate).toBe(1);
  });
});

describe("AI flags come from the last 24 hours only", () => {
  it("a fixed outage older than 24 h is a note, not a red flag; recordAi writes the hourly row", async () => {
    const { user } = await makeUser("health-old");
    const now = new Date();
    const day2 = new Date(now.getTime() - 2 * 86400e3).toISOString().slice(0, 10);
    const hour30 = new Date(now.getTime() - 30 * 3600e3).toISOString().slice(0, 13);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ai_daily (user_id, day, model, purpose, calls, failed) VALUES (?, ?, 'old/outage', 'write_hints', 50, 50)").bind(
        user.id,
        day2,
      ),
      env.DB.prepare("INSERT INTO ai_hourly (hour, model, purpose, calls, failed) VALUES (?, 'old/outage', 'write_hints', 50, 50)").bind(hour30),
    ]);
    const { recordAi } = await import("../src/stats/record");
    for (let i = 0; i < 6; i++)
      await recordAi(env.DB, {
        userId: user.id,
        model: "old/outage",
        purpose: "write_hints",
        ok: true,
        latencyMs: 5,
        inputTokens: 1,
        outputTokens: 1,
        estimated: false,
      });
    const h = await collectHealth(d1, now);
    const recent = h.ai.last24h.find((r) => r.model === "old/outage");
    expect(recent).toMatchObject({ calls: 6, failed: 0, flagged: false });
    expect(h.flags.some((f) => f.includes("old/outage"))).toBe(false);
    expect(h.warnings.some((w) => w.includes("old/outage") && w.includes("earlier in the week"))).toBe(true);
    expect(h.ai.day7.find((r) => r.model === "old/outage")?.calls).toBe(56);
  });
});
