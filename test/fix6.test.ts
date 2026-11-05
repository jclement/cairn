// Fix round 6 (review of round 3a): cron eligibility, write limiter on new paths, bounded
// gardening/expiry, one temporal validity rule in search.
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/directory";
import worker from "../src/index";
import { runNightly } from "../src/memory/cron";
import { boundedLevenshtein } from "../src/vault/do";
import { createApp } from "../src/web/app";
import { BASE, caller, defaultVault, makeUser, ORIGIN } from "./helpers";

const deny = { limit: async () => ({ success: false }) };
const allowN = (n: number) => {
  let used = 0;
  return { limit: async () => ({ success: used++ < n }) };
};
const form = (cookie: string, data: Record<string, string>) => ({
  method: "POST",
  headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});
const today = () => new Date().toISOString().slice(0, 10);

describe("1: cron eligibility follows user/assistant activity, not maintenance", () => {
  it("a vault with only maintenance writes since its last activity is not gardened again; deleting accounts are skipped", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user, "agent"), { title: "Lonely", content: "no links" });
    // the user's activity was three days ago...
    await runInDurableObject(v.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE revisions SET at = ? WHERE client = 'agent'", new Date(Date.now() - 3 * 86400e3).toISOString());
    });
    // ...and since then only maintenance wrote (this refreshes the usage snapshot)
    const g = await v.stub.garden(v.ref, today());
    expect(g.permalink).toBe(`gardening/gardening-${today()}`);
    const row = await env.DB.prepare("SELECT last_write_at, last_activity_at FROM vaults WHERE id = ?")
      .bind(v.vault.id)
      .first<{ last_write_at: string; last_activity_at: string }>();
    expect(Date.parse(row?.last_activity_at ?? "")).toBeLessThan(Date.now() - 2 * 86400e3);
    expect(Date.parse(row?.last_write_at ?? "")).toBeGreaterThan(Date.now() - 60e3);
    const revs = async () => (await v.stub.noteHistory(v.ref, g.permalink as string))?.revisions.length;
    const before = await revs();
    await runNightly(env, new Date());
    expect(await revs()).toBe(before); // not re-gardened: no activity in the last day

    // a deleting account is never selected even with fresh activity
    const d = await makeUser("deleting");
    const dv = await defaultVault(d.user.id);
    await dv.stub.writeNote(dv.ref, caller(d.user, "agent"), { title: "Lonely too", content: "x" });
    await env.DB.prepare("UPDATE users SET deleting_at = ? WHERE id = ?").bind(new Date().toISOString(), d.user.id).run();
    await runNightly(env, new Date());
    expect((await dv.stub.readNote(dv.ref, { identifier: `gardening/gardening-${today()}` })).ok).toBe(false);
  });
});

describe("2: the new mutation paths take the shared write limiter", () => {
  it("pin, revert, memory settings and bulk revert are refused when the limiter says no", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    const w1 = await v.stub.writeNote(v.ref, caller(user), { title: "Doc", content: "one" });
    const w2 = await v.stub.writeNote(v.ref, caller(user, "rogue"), { title: "Doc", content: "two", overwrite: true });
    if (!w1.ok || !w2.ok) throw new Error();
    const app = createApp();
    const denied = { ...env, RL_WRITE: deny } as typeof env;
    expect((await app.request("/app/v/main/pin", form(cookie, { permalink: "doc", pin: "1" }), denied)).status).toBe(429);
    const h = await v.stub.noteHistory(v.ref, "doc");
    const rev = await app.request(
      "/app/v/main/revert",
      form(cookie, { rev: String(h?.revisions[0].id), permalink: "doc", checksum: w2.value.note.checksum }),
      denied,
    );
    expect(decodeURIComponent(rev.headers.get("location") ?? "")).toContain("too many writes");
    expect((await app.request("/app/settings/memory", form(cookie, { budget_kb: "4" }), denied)).status).toBe(429);
    const r = await v.stub.readNote(v.ref, { identifier: "doc" });
    expect(r.ok && r.value.content).toContain("two");
    expect(r.ok && r.value.note.pinned).toBe(false);
  });

  it("bulk revert charges one write per note and resumes on a repeat", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "A", content: "a0" });
    await v.stub.writeNote(v.ref, caller(user), { title: "B", content: "b0" });
    const since = new Date(Date.now() - 1000).toISOString();
    await v.stub.writeNote(v.ref, caller(user, "rogue"), { title: "A", content: "a1", overwrite: true });
    await v.stub.writeNote(v.ref, caller(user, "rogue"), { title: "B", content: "b1", overwrite: true });
    const app = createApp();
    const confirm = await (await app.request(`/app/activity/revert?client=rogue&since=${encodeURIComponent(since)}`, { headers: { cookie } }, env)).text();
    const fields: Record<string, string> = { client: "rogue", since };
    for (const m of confirm.matchAll(/name="(e:[^"]+)" value="([^"]*)"/g)) fields[m[1]] = m[2];
    const first = await (await app.request("/app/activity/revert", form(cookie, fields), { ...env, RL_WRITE: allowN(1) } as typeof env)).text();
    expect(first).toContain("not done yet: write limit");
    const contents = async () =>
      Promise.all(["a", "b"].map(async (p) => ((r) => (r.ok ? r.value.content : ""))(await v.stub.readNote(v.ref, { identifier: p }))));
    expect((await contents()).filter((c) => c?.includes("0")).length).toBe(1);
    // repeat with fresh checksums from a new confirmation: the remaining note is undone
    const confirm2 = await (await app.request(`/app/activity/revert?client=rogue&since=${encodeURIComponent(since)}`, { headers: { cookie } }, env)).text();
    const f2: Record<string, string> = { client: "rogue", since };
    for (const m of confirm2.matchAll(/name="(e:[^"]+)" value="([^"]*)"/g)) f2[m[1]] = m[2];
    await app.request("/app/activity/revert", form(cookie, f2), env);
    expect((await contents()).every((c) => c?.includes("0"))).toBe(true);
  });

  it("core_memory doesn't create the index when the limiter says no, but still returns core memory", async () => {
    const { user } = await makeUser();
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const res = await worker.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${pat}`,
          host: "localhost:8787",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "core_memory", arguments: {} } }),
      }),
      { ...env, RL_WRITE: deny } as typeof env,
      createExecutionContext(),
    );
    expect(await res.text()).toContain("memory/index not created this time");
    const v = await defaultVault(user.id);
    expect((await v.stub.readNote(v.ref, { identifier: "memory/index" })).ok).toBe(false);
  });
});

describe("3: nightly work per vault is bounded", () => {
  it("boundedLevenshtein agrees with the full distance up to the cap", () => {
    const full = (a: string, b: string) => {
      const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
      for (let i = 1; i <= a.length; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= b.length; j++) {
          const t = dp[j];
          dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
          prev = t;
        }
      }
      return dp[b.length];
    };
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const word = () => Array.from({ length: 4 + Math.floor(rnd() * 8) }, () => "abc"[Math.floor(rnd() * 3)]).join("");
    for (let k = 0; k < 400; k++) {
      const a = word();
      const b = word();
      expect(boundedLevenshtein(a, b, 2), `${a} ${b}`).toBe(Math.min(full(a, b), 3));
    }
  });

  it("expires due notes in capped passes, continued by the alarm", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setJevTestMode({ JEV_MODEL: "" });
    expect(await v.stub.setLimitsForTest({ expirePerPass: 3 })).toBe(true);
    for (let i = 0; i < 8; i++) await v.stub.writeNote(v.ref, caller(user), { title: `Promo ${i}`, content: `- [promo] code ${i} (expires 2020-01-01)` });
    const due = () =>
      runInDurableObject(
        v.stub,
        (_i, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM observations WHERE superseded = 0 AND expires <= ?", today()).one().n,
      );
    expect(await v.stub.expireDue(v.ref, today())).toMatchObject({ notes: 3, more: true });
    expect(await due()).toBe(5);
    let passes = 0;
    while ((await due()) > 0 && passes < 5) {
      expect(await runDurableObjectAlarm(v.stub)).toBe(true); // the continuation runs from the alarm
      passes++;
    }
    expect(await due()).toBe(0);
    expect(passes).toBe(2); // 3 + 2 remaining
  });

  it("caps near-duplicate title comparisons per night", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Seed", content: "x" }); // binds the vault
    expect(await v.stub.setLimitsForTest({ dupComparisons: 50 })).toBe(true);
    // 20 distinct, same-length, mutually distant titles (190 pairs) seeded directly: garden only reads these rows.
    await runInDurableObject(v.stub, (_i, state) => {
      const ts = new Date().toISOString();
      for (let i = 0; i < 20; i++) {
        const title = `${String.fromCharCode(97 + i).repeat(3)}${String(i).padStart(2, "0")}${"zyxwvutsrq".slice(i % 10)}${"0123456789".slice(0, i % 10)}`;
        state.storage.sql.exec(
          "INSERT INTO notes (uid, permalink, title, title_lc, folder, file_path, content, checksum, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, '', 'x', 0, ?, ?)",
          `u${i}`,
          `t${i}`,
          title,
          title.toLowerCase(),
          `t${i}.md`,
          ts,
          ts,
        );
      }
    });
    const g = await v.stub.garden(v.ref, today());
    expect(g.scanned.titleComparisons).toBe(50);
    expect(g.counts.duplicates).toBe(0);
  });
});

describe("4: one temporal validity rule across search output", () => {
  it("future, elapsed, expired and superseded facts are hidden everywhere unless as_of makes them valid", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), {
      title: "Plans",
      content: [
        "- [plan] Launch in Berlin (since 2099-01-01)",
        "- [office] Office in Paris (until 2020-01-01)",
        "- [promo] Promo code SUMMERX (expires 2020-01-01)",
        "- [city] Current city Lisbon",
        "",
        "## Superseded",
        "- [ceo] CEO was Zed Quill (until 2021-01-01)",
      ].join("\n"),
    });
    const s = async (query: string, extra: Record<string, unknown> = {}) => {
      const r = await v.stub.search(v.ref, { query, mode: "text", detail: "observations", ...extra });
      if (!r.ok) throw new Error(r.message);
      return r.value.hits[0];
    };
    const now = await s("Berlin Paris SUMMERX Zed Lisbon");
    expect(now.observations.map((o) => o.category)).toEqual(["city"]);
    expect(now.matches.map((m) => m.text)).toEqual(["- [city] Current city Lisbon"]);
    const future = await s("Berlin", { as_of: "2099-06-01" });
    expect(future.observations.map((o) => o.category)).toEqual(["plan", "city"]);
    expect(future.matches.map((m) => m.text)).toEqual(["- [plan] Launch in Berlin (since 2099-01-01)"]);
    const past = await s("Paris Zed", { as_of: "2019-06-01" });
    expect(past.observations.map((o) => o.category).sort()).toEqual(["ceo", "city", "office", "promo"]);
    expect(past.matches.map((m) => m.text).join("\n")).toContain("Office in Paris");
  });
});
