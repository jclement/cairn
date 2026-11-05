// Fix round 3: reconcile races (deterministic interleavings), alarm-driven recovery across a
// restart, ledger GC, AI budgets/limits/caps, invite quota and churn, grant revocation + cutoff.
import { createExecutionContext, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createInvite, createPat, listInvites, resolvePat, revokeAllGrants, setUserDisabled, userBytes } from "../src/directory";
import worker from "../src/index";
import { spendAiBudget } from "../src/stats/budget";
import { today } from "../src/stats/record";
import { createApp } from "../src/web/app";
import { BASE, caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { callTool, fetchWorker, getAccessToken, mcp } from "./oauth";

type V = Awaited<ReturnType<typeof defaultVault>>;
const KB = 1024;
const charged = async (vaultId: string) =>
  (await env.DB.prepare("SELECT charged_bytes FROM vaults WHERE id = ?").bind(vaultId).first<{ charged_bytes: number }>())?.charged_bytes ?? -1;
async function expectBalanced(v: V, userId: string) {
  const local = (await v.stub.stats(v.ref)).totalBytes;
  expect(await userBytes(env, userId)).toBe(local);
  expect(await charged(v.vault.id)).toBe(local);
}
const drift = (userId: string, vaultId: string, n: number) =>
  env.DB.batch([
    env.DB.prepare("UPDATE users SET bytes_used = bytes_used + ? WHERE id = ?").bind(n, userId),
    env.DB.prepare("UPDATE vaults SET charged_bytes = charged_bytes + ? WHERE id = ?").bind(n, vaultId),
  ]);
const put = (v: V, user: Parameters<typeof caller>[0], title: string, size = 3 * KB) =>
  v.stub.writeNote(v.ref, caller(user), { title, content: "z".repeat(size), overwrite: true });

describe("finding 1: reconcile cannot cancel concurrent charges", () => {
  it("a write that reserves and commits while reconcile reads D1 makes reconcile stand down", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await put(v, user, "Seed");
    await v.stub.pauseAt("reconcile-read");
    const rec = v.stub.reconcile();
    await v.stub.untilPaused("reconcile-read");
    expect((await put(v, user, "During")).ok).toBe(true);
    await v.stub.resumeAt("reconcile-read");
    expect(await rec).toEqual({ skipped: "changed during reconcile" });
    await expectBalanced(v, user.id);
  });

  it("a delete that settles while reconcile is paused before its CAS check makes it stand down", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await put(v, user, "Doomed");
    await put(v, user, "Doomed"); // history, so the delete frees bytes
    await drift(user.id, v.vault.id, 500); // something to correct, so reconcile reaches the CAS step
    await v.stub.pauseAt("reconcile-cas");
    const rec = v.stub.reconcile();
    await v.stub.untilPaused("reconcile-cas");
    expect((await v.stub.deleteNote(v.ref, caller(user), { identifier: "doomed" })).ok).toBe(true);
    await v.stub.resumeAt("reconcile-cas");
    expect(await rec).toEqual({ skipped: "changed during reconcile" });
    expect(await v.stub.reconcile()).toEqual({ adjusted: -500 });
    await expectBalanced(v, user.id);
  });

  it("a write that lands after the last check but before the CAS makes the CAS fail", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await put(v, user, "Seed");
    await drift(user.id, v.vault.id, 300);
    await v.stub.pauseAt("reconcile-apply");
    const rec = v.stub.reconcile();
    await v.stub.untilPaused("reconcile-apply");
    expect((await put(v, user, "Late")).ok).toBe(true);
    await v.stub.resumeAt("reconcile-apply");
    expect(await rec).toEqual({ skipped: "charge changed concurrently" });
    expect(await v.stub.reconcile()).toEqual({ adjusted: -300 });
    await expectBalanced(v, user.id);
  });
});

describe("finding 3: recovery runs from the alarm, including after a restart", () => {
  it("a lost reservation response is undone by the armed alarm (no manual replay)", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await put(v, user, "Base");
    await v.stub.setFaults(["reserve-lost"]);
    expect(await put(v, user, "Lost")).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    await v.stub.setFaults([]);
    expect(await runDurableObjectAlarm(v.stub)).toBe(true);
    await expectBalanced(v, user.id);
  });

  it("a DO that dies between reservation and commit recovers after eviction via its alarm", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setFaults(["crash-before-commit"]);
    expect(await put(v, user, "Ghost")).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    await evictDurableObject(v.stub); // in-memory state gone; journal and alarm persist
    expect(await runDurableObjectAlarm(v.stub)).toBe(true);
    await expectBalanced(v, user.id);
    expect(await userBytes(env, user.id)).toBe(0);
  });

  it("on construction, a leftover journal arms the alarm even if none was set", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setFaults(["crash-before-commit"]);
    await put(v, user, "Ghost");
    await runInDurableObject(v.stub, async (_i, state) => {
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(v.stub);
    // No alarm existed before eviction; waking the DO runs its constructor, which arms one.
    expect(await runDurableObjectAlarm(v.stub)).toBe(true);
    await expectBalanced(v, user.id);
  });
});

describe("finding 2: ledger rows are collected even when nothing drifted", () => {
  it("deletes this vault's rows older than a day on the alarm; keeps recent ones; waits for pending work", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    for (let i = 0; i < 3; i++) await put(v, user, `L${i}`);
    const count = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE vault_id = ?").bind(v.vault.id).first<{ n: number }>())?.n ?? 0;
    const total = await count();
    expect(total).toBeGreaterThanOrEqual(3);
    await env.DB.prepare("UPDATE usage_ledger SET at = ? WHERE vault_id = ?")
      .bind(new Date(Date.now() - 2 * 86400e3).toISOString(), v.vault.id)
      .run();
    await put(v, user, "Fresh");
    const fresh = (await count()) - total;
    await v.stub.setFaults(["reserve-lost"]);
    await put(v, user, "Pending");
    await v.stub.setFaults([]);
    expect(await v.stub.cleanupLedger()).toEqual({ skipped: "settlements pending" });
    expect(await runDurableObjectAlarm(v.stub)).toBe(true); // replay, then cleanup
    const left = await count();
    expect(left).toBeLessThanOrEqual(fresh + 3); // fresh rows + the pending reservation's tombstone/undo
    expect(left).toBeGreaterThanOrEqual(fresh);
    await expectBalanced(v, user.id);
  });
});

describe("finding 4: AI spend is budgeted, limited and capped", () => {
  it("the daily budget is atomic", async () => {
    const { user } = await makeUser();
    const results = await Promise.all(Array.from({ length: 10 }, () => spendAiBudget(env, user.id, 200_000)));
    expect(results.filter(Boolean).length).toBe(5);
  });

  it("an exhausted budget falls back to keyword search and says so", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    for (const t of ["alpha one", "alpha two", "alpha three"]) await put(v, user, t, 100);
    await env.DB.prepare("INSERT OR REPLACE INTO ai_budget (user_id, day, tokens) VALUES (?, ?, 1000000)").bind(user.id, today()).run();
    const r = await v.stub.search(v.ref, { query: "alpha" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.rerank).toMatchObject({ applied: false, error: "daily AI budget reached" });
    expect(r.value.notes).toEqual(["semantic search skipped: daily AI budget reached"]);
    expect(r.value.hits.length).toBe(3);
    const pat = await createPat(env, user.id, "t", ["memory:read"], null);
    const text = (await callTool(pat, "search_notes", { query: "alpha" })).content[0].text;
    expect(text).toContain("(re-ranking unavailable: daily AI budget reached");
    expect(text).toContain("(semantic search skipped: daily AI budget reached; results are keyword-only)");
  });

  it("searches are rate-limited per user, over MCP and in the browser", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setFaults(["search-limited"]);
    const pat = await createPat(env, user.id, "t", ["memory:read"], null);
    const t = await callTool(pat, "search_notes", { query: "x" });
    expect(t.isError).toBe(true);
    expect(t.content[0].text).toMatch(/^RATE_LIMITED/);
    expect(await (await fetchWorker("/app/search?q=x", { headers: { cookie } })).text()).toContain("Too many searches");
    await v.stub.setFaults([]);
  });

  it("caps Jev inputs: a huge query and huge observations still fit the payload cap", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const big = "word ".repeat(20_000);
    await v.stub.writeNote(v.ref, caller(user), { title: "Big A", content: `- [fact] ${big}` });
    await v.stub.writeNote(v.ref, caller(user), { title: "Big B", content: `- [fact] ${big} more` }); // hints: pair of two huge observations
    for (const t of ["word one", "word two"]) await put(v, user, t, 100);
    const r = await v.stub.search(v.ref, { query: `word ${"q".repeat(10_000)}` });
    expect(r.ok && r.value.rerank).toMatchObject({ applied: true });
    const rows = (
      await env.DB.prepare("SELECT purpose, calls, failed, input_tokens FROM ai_daily WHERE user_id = ? AND model != 'fake-hash-embedder'").bind(user.id).all<{
        purpose: string;
        calls: number;
        failed: number;
        input_tokens: number;
      }>()
    ).results;
    for (const row of rows) {
      expect(row.failed, row.purpose).toBe(0);
      expect(row.input_tokens / row.calls).toBeLessThanOrEqual(16_000 / 4 + 1);
    }
    expect(rows.map((r) => r.purpose).sort()).toEqual(["search_rerank", "write_hints"]);
  });

  it("records a timed-out Jev call as unknown usage with the tokens sent", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    for (const t of ["beta one", "beta two", "beta three"]) await put(v, user, t, 100);
    await v.stub.setJevTestMode({ CAIRN_FAKE_JEV: "slow" });
    await v.stub.search(v.ref, { query: "beta" });
    await v.stub.setJevTestMode(null);
    const row = await env.DB.prepare("SELECT failed, unknown_calls, input_tokens FROM ai_daily WHERE user_id = ? AND purpose = 'search_rerank'")
      .bind(user.id)
      .first<{ failed: number; unknown_calls: number; input_tokens: number }>();
    expect(row).toMatchObject({ failed: 1, unknown_calls: 1 });
    expect(row?.input_tokens).toBeGreaterThan(0);
  });
});

describe("finding 5: invites", () => {
  it("the outstanding quota holds under concurrency", async () => {
    const { user } = await makeUser();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => createInvite(env, user, { note: `p${i}` })));
    expect(results.filter((r) => r.ok).length).toBe(5);
  });

  it("create/revoke churn keeps at most 20 inactive invites per user", async () => {
    const { user } = await makeUser();
    for (let i = 0; i < 30; i++) {
      const r = await createInvite(env, user);
      if (!r.ok) throw new Error(r.message);
      const { revokeInvite } = await import("../src/directory");
      await revokeInvite(env, user.id, r.id);
    }
    expect((await listInvites(env, user.id)).length).toBeLessThanOrEqual(20);
  });

  it("create and revoke are rate-limited per user", async () => {
    const { cookie } = await makeUser();
    const app = createApp();
    const deny = { limit: async () => ({ success: false }) };
    const res = await app.request(
      "/app/settings/invites",
      { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "note=x" },
      { ...env, RL_INVITE: deny },
    );
    expect(res.status).toBe(429);
  });
});

describe("finding 6: revocation covers every grant page, and re-enable can't revive old tokens", () => {
  it("revokeAllGrants walks every page; a failure is reported, not swallowed", async () => {
    const revoked: string[] = [];
    const pages: Record<string, { items: { id: string }[]; cursor?: string }> = {
      "": { items: [{ id: "g1" }, { id: "g2" }], cursor: "c1" },
      c1: { items: [{ id: "g3" }], cursor: "c2" },
      c2: { items: [{ id: "g4" }] },
    };
    const fake = {
      listUserGrants: async (_u: string, o?: { cursor?: string }) => pages[o?.cursor ?? ""],
      revokeGrant: async (id: string) => {
        revoked.push(id);
      },
    };
    expect(await revokeAllGrants(fake as never, "u")).toBe(4);
    expect(revoked).toEqual(["g1", "g2", "g3", "g4"]);
    const broken = {
      ...fake,
      listUserGrants: async (_u: string, o?: { cursor?: string }) => (o?.cursor === "c1" ? Promise.reject(new Error("KV down")) : pages[o?.cursor ?? ""]),
    };
    await expect(revokeAllGrants(broken as never, "u")).rejects.toThrow(/KV down/);
  });

  it("an OAuth token and a PAT issued before a disable stay dead after re-enable", async () => {
    const { user, cookie } = await makeUser();
    const { accessToken } = await getAccessToken(cookie);
    expect((await mcp(accessToken, "tools/list")).result.tools.length).toBeGreaterThan(0);
    const pat = await createPat(env, user.id, "old", ["memory:read"], null);
    await setUserDisabled(env, user.id, true);
    await setUserDisabled(env, user.id, false);
    const res = await fetchWorker("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        host: "localhost:8787",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(await resolvePat(env, pat)).toBeNull();
    // new credentials after re-enable work
    const fresh = await createPat(env, user.id, "new", ["memory:read"], null);
    expect(await resolvePat(env, fresh)).not.toBeNull();
    void worker;
    void createExecutionContext;
    void BASE;
  });
});
