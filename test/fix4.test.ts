// Fix round 4 (review findings): replay/commit race, directory bypass, ledger drain, budget errors.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPat, userBytes } from "../src/directory";
import { caller, defaultVault, makeUser } from "./helpers";
import { callTool } from "./oauth";

type V = Awaited<ReturnType<typeof defaultVault>>;
const charged = async (vaultId: string) =>
  (await env.DB.prepare("SELECT charged_bytes FROM vaults WHERE id = ?").bind(vaultId).first<{ charged_bytes: number }>())?.charged_bytes ?? -1;
async function expectBalanced(v: V, userId: string) {
  const local = (await v.stub.stats(v.ref)).totalBytes;
  expect(await userBytes(env, userId)).toBe(local);
  expect(await charged(v.vault.id)).toBe(local);
}
const put = (v: V, user: Parameters<typeof caller>[0], title: string, size = 2048) =>
  v.stub.writeNote(v.ref, caller(user), { title, content: "z".repeat(size), overwrite: true });

describe("A1: replay cannot undo a reservation that commits while replay is busy", () => {
  it("orphan A is undone; B commits during A's undo and keeps its charge", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setFaults(["reserve-lost"]);
    expect(await put(v, user, "Orphan A")).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    await v.stub.setFaults([]);
    // B reserves and pauses before its local commit, so replay's snapshot contains both rows.
    await v.stub.pauseAt("after-reserve");
    const b = put(v, user, "Note B");
    await v.stub.untilPaused("after-reserve");
    await v.stub.pauseAt("undo");
    const replay = v.stub.replaySettlements();
    await v.stub.untilPaused("undo");
    // replay is now paused inside undo(A); let B commit
    await v.stub.resumeAt("after-reserve");
    expect((await b).ok).toBe(true);
    await v.stub.resumeAt("undo");
    expect(await replay).toMatchObject({ undone: 1, remaining: 0 });
    // B's note exists and is charged even though reconciliation never ran
    expect((await v.stub.readNote(v.ref, { identifier: "note-b" })).ok).toBe(true);
    await expectBalanced(v, user.id);
  });

  it("a reservation claimed by replay can no longer commit", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.pauseAt("after-reserve");
    const w = put(v, user, "Late");
    await v.stub.untilPaused("after-reserve");
    // simulate the request having been lost: drop it from the in-flight set via a crash-like path
    await v.stub.forgetInflightForTest();
    expect((await v.stub.replaySettlements()).undone).toBe(1);
    await v.stub.resumeAt("after-reserve");
    expect(await w).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect((await v.stub.readNote(v.ref, { identifier: "late" })).ok).toBe(false);
    await expectBalanced(v, user.id);
  });
});

describe("A2: directory and file path are capped and charged", () => {
  it("refuses an oversized directory even with a short explicit permalink", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const r = await v.stub.writeNote(v.ref, caller(user), { title: "Tiny", content: "", directory: "a".repeat(100_000), metadata: { permalink: "n1" } });
    expect(r).toMatchObject({ ok: false, code: "INVALID" });
    expect(await userBytes(env, user.id)).toBe(0);
  });

  it("charges folder and file path bytes stored on the note row", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const dir = "d".repeat(190);
    const w = await v.stub.writeNote(v.ref, caller(user), { title: "Tiny", content: "", directory: dir, metadata: { permalink: "n2" } });
    if (!w.ok) throw new Error(w.message);
    expect(w.value.note.bytes).toBeGreaterThan(2 * 190);
    await expectBalanced(v, user.id);
  });
});

describe("A3: ledger GC drains a large backlog over repeated alarms", () => {
  it("removes more than 1,500 aged rows without any new writes", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await put(v, user, "Seed");
    const old = new Date(Date.now() - 3 * 86400e3).toISOString();
    const stmts = [];
    for (let i = 0; i < 1600; i++) {
      stmts.push(
        env.DB.prepare("INSERT INTO usage_ledger (id, user_id, vault_id, amount, applied, at) VALUES (?, ?, ?, 0, 1, ?)").bind(
          `old:${i}`,
          user.id,
          v.vault.id,
          old,
        ),
      );
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    const aged = async () =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE vault_id = ? AND at < ?")
          .bind(v.vault.id, new Date(Date.now() - 86400e3).toISOString())
          .first<{ n: number }>()
      )?.n ?? -1;
    let passes = 0;
    while ((await aged()) > 0 && passes < 10) {
      expect(await runDurableObjectAlarm(v.stub)).toBe(true); // each full pass re-arms the alarm
      passes++;
    }
    expect(await aged()).toBe(0);
    expect(passes).toBe(4);
  });
});

describe("A4: AI budget storage errors degrade instead of failing the request", () => {
  it("a write keeps its receipt and a search keeps its results", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    for (const t of ["gamma one", "gamma two", "gamma three"]) await put(v, user, t, 100);
    await v.stub.setJevTestMode({ CAIRN_FAULT_BUDGET: "1" });
    const w = await v.stub.writeNote(v.ref, caller(user), { title: "gamma four", content: "- [fact] gamma" });
    expect(w.ok).toBe(true);
    expect(w.ok && w.value.hints?.skipped).toMatch(/AI budget unavailable/);
    const s = await v.stub.search(v.ref, { query: "gamma" });
    if (!s.ok) throw new Error(s.message);
    expect(s.value.hits.length).toBe(4);
    expect(s.value.rerank).toMatchObject({ applied: false });
    expect(s.value.rerank?.error).toMatch(/AI budget unavailable/);
    expect(s.value.notes).toContain("semantic search skipped: AI budget unavailable");
    await v.stub.setJevTestMode(null);
    void createPat;
    void callTool;
  });
});
