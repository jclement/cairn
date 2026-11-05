// Fix round 2: bounded revision rows (metadata charged and capped) and recoverable accounting.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { userBytes } from "../src/directory";
import { caller, defaultVault, makeUser } from "./helpers";

const charged = async (vaultId: string) =>
  (await env.DB.prepare("SELECT charged_bytes, bytes_used, usage_version FROM vaults WHERE id = ?").bind(vaultId).first<{
    charged_bytes: number;
    bytes_used: number;
    usage_version: number;
  }>()) ?? { charged_bytes: -1, bytes_used: -1, usage_version: -1 };

async function expectBalanced(v: Awaited<ReturnType<typeof defaultVault>>, userId: string) {
  const local = (await v.stub.stats(v.ref)).totalBytes;
  expect(await userBytes(env, userId)).toBe(local);
  expect((await charged(v.vault.id)).charged_bytes).toBe(local);
  return local;
}

describe("finding 1: revision rows of deleted notes are bounded and charged", () => {
  it("60 create/delete cycles with long titles leave at most the trash cap of rows, all charged", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setJevTestMode({ JEV_MODEL: "" }); // hints aren't under test; keep the 120 operations fast
    const long = "T".repeat(290);
    for (let i = 0; i < 60; i++) {
      const w = await v.stub.writeNote(v.ref, caller(user), { title: `${long}${i}`, content: "x", metadata: { permalink: `n${i}` } });
      if (!w.ok) throw new Error(w.message);
      expect((await v.stub.deleteNote(v.ref, caller(user), { identifier: `n${i}` })).ok).toBe(true);
    }
    const rows = await v.stub.revisionFootprint();
    expect(rows.rows).toBeLessThanOrEqual(50);
    expect(rows.metadataBytes).toBeLessThan(50 * 1024);
    const local = await expectBalanced(v, user.id);
    expect(local).toBe(rows.bytes);
  }, 120_000);

  it("charges each revision row's metadata", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const w = await v.stub.writeNote(v.ref, caller(user), { title: "Small", content: "hi" });
    if (!w.ok) throw new Error(w.message);
    const local = await expectBalanced(v, user.id);
    expect(local).toBeGreaterThan(w.value.note.bytes + 256);
  });

  it("caps titles and permalinks", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    expect(await v.stub.writeNote(v.ref, caller(user), { title: "T".repeat(301), content: "x" })).toMatchObject({ ok: false, code: "INVALID" });
    expect(await v.stub.writeNote(v.ref, caller(user), { title: "ok", content: "x", metadata: { permalink: "p".repeat(201) } })).toMatchObject({
      ok: false,
      code: "INVALID",
    });
    expect(await userBytes(env, user.id)).toBe(0);
  });
});

describe("finding 2: D1 and DO accounting recover from partial failure", () => {
  const write = (v: Awaited<ReturnType<typeof defaultVault>>, user: Parameters<typeof caller>[0], title: string) =>
    v.stub.writeNote(v.ref, caller(user), { title, content: "y".repeat(5000), overwrite: true });

  it("reservation applied but response lost: the write fails, replay undoes the charge", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await write(v, user, "Base");
    const before = await expectBalanced(v, user.id);
    await v.stub.setFaults(["reserve-lost"]);
    expect(await write(v, user, "Lost")).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    await v.stub.setFaults([]);
    expect(await userBytes(env, user.id)).toBeGreaterThan(before); // charged, nothing stored
    expect(await v.stub.replaySettlements()).toMatchObject({ undone: 1, remaining: 0 });
    expect(await expectBalanced(v, user.id)).toBe(before);
    expect(await v.stub.replaySettlements()).toMatchObject({ undone: 0, remaining: 0 }); // idempotent
    expect(await expectBalanced(v, user.id)).toBe(before);
  });

  it("DO dies between reservation and local commit: replay releases the reservation", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setFaults(["crash-before-commit"]);
    expect(await write(v, user, "Ghost")).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    await v.stub.setFaults([]);
    expect(await userBytes(env, user.id)).toBeGreaterThan(0);
    await v.stub.replaySettlements();
    expect(await expectBalanced(v, user.id)).toBe(0);
    expect(await v.stub.readNote(v.ref, { identifier: "ghost" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("release after commit fails: the write still succeeds and replay applies it", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    for (let i = 0; i < 22; i++) await write(v, user, "Churn"); // retention starts freeing copies
    await v.stub.setFaults(["release-fail"]);
    const w = await write(v, user, "Churn");
    await v.stub.setFaults([]);
    expect(w.ok).toBe(true);
    const local = (await v.stub.stats(v.ref)).totalBytes;
    expect(await userBytes(env, user.id)).toBeGreaterThan(local); // freed bytes still charged
    expect(await v.stub.replaySettlements()).toMatchObject({ remaining: 0 });
    await expectBalanced(v, user.id);
  });

  it("snapshot write fails: the write succeeds; the next snapshot is newer and wins", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await write(v, user, "A");
    const first = await charged(v.vault.id);
    await v.stub.setFaults(["record-fail"]);
    expect((await write(v, user, "B")).ok).toBe(true);
    await v.stub.setFaults([]);
    expect((await charged(v.vault.id)).bytes_used).toBe(first.bytes_used); // stale display value
    await write(v, user, "C");
    const after = await charged(v.vault.id);
    expect(after.usage_version).toBeGreaterThan(first.usage_version);
    expect(after.bytes_used).toBe((await v.stub.stats(v.ref)).totalBytes);
    // a stale (lower-version) snapshot can't overwrite it
    await env.DB.prepare("UPDATE vaults SET bytes_used = 1 WHERE id = ? AND usage_version < ?").bind(v.vault.id, first.usage_version).run();
    expect((await charged(v.vault.id)).bytes_used).toBe(after.bytes_used);
  });

  it("reconcile corrects drift from local truth, but not while settlements are pending", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await write(v, user, "R");
    await write(v, user, "R");
    const local = await expectBalanced(v, user.id);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET bytes_used = bytes_used + 777 WHERE id = ?").bind(user.id),
      env.DB.prepare("UPDATE vaults SET charged_bytes = charged_bytes + 777 WHERE id = ?").bind(v.vault.id),
    ]);
    await v.stub.setFaults(["release-fail"]);
    await v.stub.deleteNote(v.ref, caller(user), { identifier: "r" }); // leaves a pending adjustment
    await v.stub.setFaults([]);
    expect(await v.stub.reconcile()).toEqual({ skipped: "settlements pending" });
    await v.stub.replaySettlements();
    const r = await v.stub.reconcile();
    expect(r).toEqual({ adjusted: -777 });
    expect(await v.stub.reconcile()).toEqual({ adjusted: 0 });
    await expectBalanced(v, user.id);
    expect(local).toBeGreaterThan(0);
  });
});
