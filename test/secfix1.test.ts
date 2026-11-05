// Security fix round 1 (sec-audit-codex): embedding budget (MEDIUM 1), atomic project cap
// (MEDIUM 3), post-login redirect guard (LOW 4).
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { safeNext as browserSafeNext } from "../public/app/cairn/safe-next.js";
import { createVault, setUserDisabled } from "../src/directory";
import { LIMITS } from "../src/env";
import { today } from "../src/stats/record";
import { safeNext } from "../src/web/next";
import { caller, defaultVault, makeUser } from "./helpers";
import { fetchWorker } from "./oauth";

type V = Awaited<ReturnType<typeof defaultVault>>;
const pending = async (v: V) => (await v.stub.stats(v.ref)).pendingEmbeddings;
const embedCalls = async (userId: string) =>
  (await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM ai_daily WHERE user_id = ? AND purpose = 'embed'").bind(userId).first<{ n: number }>())?.n ??
  0;
const spent = async (userId: string) =>
  (await env.DB.prepare("SELECT tokens FROM ai_budget WHERE user_id = ? AND day = ?").bind(userId, today()).first<{ tokens: number }>())?.tokens ?? 0;
const deferredUntil = (v: V) =>
  runInDurableObject(
    v.stub,
    (_i, state) => state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'embed_deferred_until'").toArray()[0]?.value,
  );

describe("MEDIUM 1: document embeddings are charged to the daily AI budget", () => {
  it("charges each batch before embedding it", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Budgeted", content: "some text to embed ".repeat(50) });
    const before = await spent(user.id);
    const r = await v.stub.embedPending();
    expect(r.embedded).toBeGreaterThan(0);
    expect(await spent(user.id)).toBeGreaterThan(before);
    expect(await pending(v)).toBe(0);
  });

  it("an exhausted budget embeds nothing, leaves chunks pending, defers to tomorrow; keyword search still works", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await env.DB.prepare("INSERT OR REPLACE INTO ai_budget (user_id, day, tokens) VALUES (?, ?, 1000000)").bind(user.id, today()).run();
    await v.stub.writeNote(v.ref, caller(user), { title: "Over budget", content: "zebra crossing notes ".repeat(20) });
    const r = await v.stub.embedPending();
    expect(r.embedded).toBe(0);
    expect(await pending(v)).toBeGreaterThan(0);
    expect(await embedCalls(user.id)).toBe(0); // the embedding model was never called
    const until = await deferredUntil(v);
    expect(Date.parse(until ?? "")).toBeGreaterThan(Date.now());
    expect(new Date(until ?? "").toISOString().slice(0, 10)).not.toBe(today());
    // Deferred: even with budget freed today, no charge is attempted until tomorrow (no alarm loop).
    await env.DB.prepare("DELETE FROM ai_budget WHERE user_id = ?").bind(user.id).run();
    expect((await v.stub.embedPending()).embedded).toBe(0);
    expect(await spent(user.id)).toBe(0);
    const alarm = await runInDurableObject(v.stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    const s = await v.stub.search(v.ref, { query: "zebra", mode: "text" });
    if (!s.ok) throw new Error(s.message);
    expect(s.value.hits.map((h) => h.title)).toEqual(["Over budget"]);
  });

  it("AI_DAILY_TOKENS=0 stops document embeddings", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setJevTestMode({ AI_DAILY_TOKENS: "0" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Zero", content: "nothing should be embedded" });
    expect((await v.stub.embedPending()).embedded).toBe(0);
    expect(await pending(v)).toBeGreaterThan(0);
    expect(await embedCalls(user.id)).toBe(0);
  });

  it("a budget-store failure fails closed (nothing embedded, chunks pending)", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setJevTestMode({ CAIRN_FAULT_BUDGET: "1" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Fault", content: "budget store down" });
    expect((await v.stub.embedPending()).embedded).toBe(0);
    expect(await pending(v)).toBeGreaterThan(0);
    expect(await embedCalls(user.id)).toBe(0);
    expect(await deferredUntil(v)).toBeUndefined(); // retried in an hour, not deferred a day
  });
});

describe("MEDIUM 3: the project cap holds under concurrent creation", () => {
  const count = async (userId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults WHERE owner_id = ?").bind(userId).first<{ n: number }>())?.n ?? -1;

  it("concurrent creations with distinct names never exceed the cap", async () => {
    const { user } = await makeUser();
    const start = await count(user.id); // the default project
    for (let i = start; i < LIMITS.vaultsPerUser - 1; i++) expect((await createVault(env, user.id, `p${i}`)).ok).toBe(true);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => createVault(env, user.id, `race-${i}`)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await count(user.id)).toBe(LIMITS.vaultsPerUser);
    const refused = results.find((r) => !r.ok);
    expect(refused && !refused.ok && refused.message).toMatch(/limit/);
  });

  it("keeps names unique and refuses disabled accounts", async () => {
    const { user } = await makeUser();
    const both = await Promise.all([createVault(env, user.id, "Same"), createVault(env, user.id, "same")]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, message: "Project same already exists." });
    await setUserDisabled(env, user.id, true);
    expect(await createVault(env, user.id, "after-disable")).toMatchObject({ ok: false });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults WHERE owner_id = ? AND name = 'after-disable'").bind(user.id).first<{ n: number }>())?.n,
    ).toBe(0);
  });
});

describe("LOW 4: next= only allows same-origin paths", () => {
  const bypasses = [
    "/\\attacker.example/after-login",
    "\\\\attacker.example",
    "/%5Cattacker.example",
    "/%5cattacker.example",
    "/%2F/attacker.example",
    "/%2fattacker.example",
    "//attacker.example",
    "///attacker.example",
    "https://attacker.example/",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,hi",
    "attacker.example",
    "/\tattacker",
    "/\n/attacker.example",
    "\t//attacker.example",
    " //attacker.example",
    "/%09/attacker.example",
    "",
  ];
  const allowed: [string, string][] = [
    ["/app", "/app"],
    ["/app/v/main/n/notes/a%20b?x=1#h", "/app/v/main/n/notes/a%20b?x=1#h"],
    ["/app/settings/account", "/app/settings/account"],
    ["/app/../app/settings", "/app/settings"],
  ];
  const clientSafeNext = (r: string, f: string) => browserSafeNext(r, f, "https://cairn.example");

  it("refuses every bypass, on the server and in passkey.js", () => {
    for (const b of bypasses) {
      expect([b, safeNext(b, "/fallback")]).toEqual([b, "/fallback"]);
      expect([b, clientSafeNext(b, "/fallback")]).toEqual([b, "/fallback"]);
    }
  });

  it("keeps ordinary same-origin destinations", () => {
    for (const [inp, out] of allowed) {
      expect(safeNext(inp, "/fallback")).toBe(out);
      expect(clientSafeNext(inp, "/fallback")).toBe(out);
    }
  });

  it("login, signup and reauth pages only ever render a safe data-next", async () => {
    const evil = encodeURIComponent("/\\attacker.example/after-login");
    for (const path of [`/login?next=${evil}`, `/signup?next=${evil}`]) {
      const html = await (await fetchWorker(path)).text();
      expect(html).toContain('data-next="/app"');
      expect(html).not.toContain("attacker.example");
    }
    const { cookie } = await makeUser();
    const html = await (await fetchWorker(`/app/reauth?next=${evil}`, { headers: { cookie } })).text();
    expect(html).toContain('data-next="/app/settings/account"');
    expect(html).not.toContain("attacker.example");
    const ok = await (await fetchWorker(`/login?next=${encodeURIComponent("/app/search?q=x")}`)).text();
    expect(ok).toContain('data-next="/app/search?q=x"');
  });
});
