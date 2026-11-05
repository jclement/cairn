// Import fix 2 (review-import): inflation bounded per push and per archive, D1 retention, idempotent
// settlement, shared admission with staged reservations, and runnable-first scheduling.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { deleteAccount } from "../src/account";
import { putAttachment } from "../src/capture/files";
import { createVault } from "../src/directory";
import { LIMITS } from "../src/env";
import { detectPrefix, IMPORT_LIMITS, planImport, readNotes, startImport } from "../src/import";
import { MAX_PUSH_OUTPUT, ZipError } from "../src/zip";
import { caller, defaultVault, makeUser } from "./helpers";

type Stub = ReturnType<typeof env.VAULT.getByName>;
type Ref = { id: string; name: string; ownerId: string };

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Rewrite every entry's declared uncompressed size (both headers). */
function forgeSize(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = dv.getUint32(i, true);
    if (sig === 0x04034b50) dv.setUint32(i + 22, size, true);
    if (sig === 0x02014b50) dv.setUint32(i + 24, size, true);
  }
  return out;
}
/** Repeat the (single) central-directory record `n` times: n entries aliasing one payload. */
function alias(zip: Uint8Array, n: number): Uint8Array {
  const eocd = zip.length - 22;
  const cdSize = u32(zip, eocd + 12);
  const cdOff = u32(zip, eocd + 16);
  const rec = zip.subarray(cdOff, cdOff + cdSize);
  const recs: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const r = rec.slice();
    const nameLen = u16(r, 28);
    r[46 + nameLen - 4] = 97 + (i % 26); // vary the name: "x.md" -> "a.md", "b.md"...
    recs.push(r);
  }
  const out = new Uint8Array(cdOff + cdSize * n + 22);
  out.set(zip.subarray(0, cdOff));
  for (const [i, r] of recs.entries()) out.set(r, cdOff + i * cdSize);
  const e = zip.slice(eocd);
  const dv = new DataView(e.buffer);
  dv.setUint16(8, n, true);
  dv.setUint16(10, n, true);
  dv.setUint32(12, cdSize * n, true);
  out.set(e, cdOff + cdSize * n);
  return out;
}
const stagedOf = async (userId: string) =>
  (await env.DB.prepare("SELECT import_staged_bytes AS b FROM users WHERE id = ?").bind(userId).first<{ b: number }>())?.b ?? -1;
const d1Jobs = async (userId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM import_jobs WHERE user_id = ?").bind(userId).first<{ n: number }>())?.n ?? -1;
async function drainJob(stub: Stub, ref: Ref, job: string, max = 40) {
  for (let i = 0; i < max; i++) {
    const st = await stub.importStatus(ref, job);
    if (!st || st.status === "done" || st.status === "aborted" || (st.deferred_until && Date.parse(st.deferred_until) > Date.now() + 60_000)) return;
    await runDurableObjectAlarm(stub);
  }
}
/** Register a D1 job and stage items directly (an upload paused between staging and start). */
async function stageJob(
  stub: Stub,
  ref: Ref,
  user: { id: string; username: string },
  id: string,
  items: { path: string; content: string | null; status?: string; message?: string }[],
) {
  await env.DB.prepare("INSERT INTO import_jobs (id, user_id, vault_id, status, staged_bytes, created_at) VALUES (?, ?, ?, 'staging', 0, ?)")
    .bind(id, user.id, ref.id, new Date().toISOString())
    .run();
  return stub.importStage(
    ref,
    { id, source: "basic-memory", userId: user.id, username: user.username, overwrite: false },
    items.map((it) => ({ folder: "", title: it.path.replace(/\.md$/, ""), ...it })),
  );
}
const bomb = (mib: number) => zipSync({ "x.md": new Uint8Array(mib * 1024 * 1024).fill(97) }, { level: 9 });

describe("1: inflation is bounded per push and per archive", () => {
  it("a 16 MiB bomb claiming 100 bytes is refused after at most one push of output", () => {
    const zip = forgeSize(bomb(16), 100);
    expect(zip.length).toBeLessThan(40_000);
    const plan = planImport(zip);
    expect(() => [...readNotes(zip, plan, null)]).toThrow(ZipError);
    expect(plan.meter.maxChunk).toBeLessThanOrEqual(MAX_PUSH_OUTPUT);
    expect(plan.meter.used).toBeLessThanOrEqual(100 + MAX_PUSH_OUTPUT);
  });

  it("the frontmatter peek is bounded the same way", () => {
    const zip = forgeSize(bomb(16), 1_000_000);
    const plan = planImport(zip);
    detectPrefix(zip, plan);
    expect(plan.meter.maxChunk).toBeLessThanOrEqual(MAX_PUSH_OUTPUT);
    expect(plan.meter.used).toBeLessThanOrEqual(IMPORT_LIMITS.peekBytes + MAX_PUSH_OUTPUT);
  });

  it("an honest oversized entry is skipped without inflating anything", () => {
    const zip = bomb(2);
    const plan = planImport(zip);
    expect(plan.notes.length).toBe(0);
    expect(plan.reported[0].message).toMatch(/larger than the/);
    expect(plan.meter.used).toBe(0);
  });

  it("refuses entries that alias one payload (repeated local offsets)", () => {
    const zip = alias(forgeSize(bomb(1), 10), 3000);
    expect(() => planImport(zip)).toThrow(/overlap/);
  });

  it("peeks only the first peekNotes notes", () => {
    const files: Record<string, Uint8Array> = {};
    const note = (i: number) => strToU8(`---\npermalink: proj/n${i}\n---\n${"word ".repeat(2000)}${i}`);
    for (let i = 0; i < 300; i++) files[`n${i}.md`] = note(i);
    const zip = zipSync(files);
    const plan = planImport(zip);
    expect(detectPrefix(zip, plan)).toBe("proj");
    expect(plan.meter.used).toBeLessThanOrEqual(IMPORT_LIMITS.peekNotes * (IMPORT_LIMITS.peekBytes + MAX_PUSH_OUTPUT));
    // Highly compressible notes come out whole in one push; still, only 200 of the 300 were touched.
    expect(plan.meter.used).toBeLessThanOrEqual(IMPORT_LIMITS.peekNotes * note(299).length);
  });
});

describe("2: import records are bounded in D1 and in vaults, and deleted with the account", () => {
  it("repeated report-only imports across projects keep at most 5 finished jobs per account", async () => {
    const { user } = await makeUser();
    const a = await defaultVault(user.id);
    const b = await createVault(env, user.id, "second");
    if (!b.ok) throw new Error(b.message);
    const bStub = env.VAULT.getByName(b.vault.id);
    const bRef = { id: b.vault.id, name: "second", ownerId: user.id };
    const zip = zipSync({ "pic.png": new Uint8Array([1, 2, 3]) });
    const jobs: { job: string; stub: Stub; ref: Ref }[] = [];
    for (let i = 0; i < 8; i++) {
      const [vault, stub, ref] = i < 4 ? [a.vault, a.stub, a.ref] : [b.vault, bStub, bRef];
      const r = await startImport(env, vault, user, zip, false);
      if (!r.ok) throw new Error(r.error);
      jobs.push({ job: r.job, stub, ref });
      await drainJob(stub, ref, r.job);
    }
    expect(await d1Jobs(user.id)).toBe(5);
    for (const j of jobs.slice(0, 3)) expect(await j.stub.importStatus(j.ref, j.job)).toBeNull(); // forgotten in vault A
    for (const j of jobs.slice(3)) expect((await j.stub.importStatus(j.ref, j.job))?.status).toBe("done");
    expect(await stagedOf(user.id)).toBe(0);
  });

  it("caps import jobs per day", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await env.DB.prepare("INSERT INTO import_daily (user_id, day, notes, jobs) VALUES (?, ?, 0, ?)")
      .bind(user.id, new Date().toISOString().slice(0, 10), IMPORT_LIMITS.jobsPerDay)
      .run();
    const r = await startImport(env, v.vault, user, zipSync({ "a.md": strToU8("# a") }), false);
    expect(r).toMatchObject({ ok: false, status: 429 });
  });

  it("account deletion removes import records", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const r = await startImport(env, v.vault, user, zipSync({ "a.md": strToU8("# a") }), false);
    if (!r.ok) throw new Error(r.error);
    await drainJob(v.stub, v.ref, r.job);
    const noGrants = { listUserGrants: async () => ({ items: [], cursor: undefined }), revokeGrant: async () => {} };
    await deleteAccount(env, noGrants as unknown as Parameters<typeof deleteAccount>[1], user.id);
    expect(await d1Jobs(user.id)).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM import_daily WHERE user_id = ?").bind(user.id).first<{ n: number }>())?.n).toBe(0);
  });
});

describe("3: releasing a reservation is idempotent", () => {
  it("overlapping and repeated aborts leave the other job's reservation intact", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    expect((await stageJob(v.stub, v.ref, user, "job-a", [{ path: "a.md", content: "a".repeat(1000) }])).ok).toBe(true);
    expect((await stageJob(v.stub, v.ref, user, "job-b", [{ path: "b.md", content: "b".repeat(2000) }])).ok).toBe(true);
    const heldB = (await env.DB.prepare("SELECT staged_bytes AS b FROM import_jobs WHERE id = 'job-b'").first<{ b: number }>())?.b ?? 0;
    expect(heldB).toBeGreaterThan(2000);
    await Promise.all([v.stub.importAbort(v.ref, "job-a"), v.stub.importAbort(v.ref, "job-a")]);
    await v.stub.importAbort(v.ref, "job-a"); // a retry after a "lost" response
    expect(await stagedOf(user.id)).toBe(heldB);
    await v.stub.importAbort(v.ref, "job-b");
    expect(await stagedOf(user.id)).toBe(0);
  });
});

describe("4: ordinary writes count staged reservations; imports transfer theirs", () => {
  it("notes and attachments can't use space reserved by a paused import", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    expect((await stageJob(v.stub, v.ref, user, "paused", [{ path: "big.md", content: "x".repeat(20_000) }])).ok).toBe(true);
    const staged = await stagedOf(user.id);
    // Room for the note on its own, but not on top of the staged import.
    await env.DB.prepare("UPDATE users SET bytes_used = ? WHERE id = ?")
      .bind(LIMITS.userBytes - staged - 5_000, user.id)
      .run();
    const w = await v.stub.writeNote(v.ref, caller(user), { title: "Ordinary", content: "y".repeat(8_000) });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.code).toBe("QUOTA");
    const att = await putAttachment(env, v.vault, { bytes: new Uint8Array(8_000).fill(1), name: "f.bin", source: "upload" });
    expect(att).toMatchObject({ ok: false, code: "QUOTA" });
    await v.stub.importAbort(v.ref, "paused");
    expect((await v.stub.writeNote(v.ref, caller(user), { title: "Ordinary", content: "y".repeat(8_000) })).ok).toBe(true);
  });

  it("an import near the limit uses its own reservation instead of being counted twice", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await env.DB.prepare("UPDATE users SET bytes_used = ? WHERE id = ?")
      .bind(LIMITS.userBytes - 20_000, user.id)
      .run();
    const r = await startImport(env, v.vault, user, zipSync({ "near.md": strToU8(`# near\n${"z".repeat(12_000)}`) }), false);
    if (!r.ok) throw new Error(r.error);
    await drainJob(v.stub, v.ref, r.job);
    expect((await v.stub.importStatus(v.ref, r.job))?.counts.imported).toBe(1);
    expect(await stagedOf(user.id)).toBe(0);
  });
});

describe("5: a deferred job doesn't block runnable ones or spin the alarm", () => {
  it("runs the report-only job, then sleeps until the deferred job's resume time", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setLimitsForTest({ importNotesPerDay: 1 });
    await env.DB.prepare("INSERT INTO import_daily (user_id, day, notes, jobs) VALUES (?, ?, 1, 0)").bind(user.id, new Date().toISOString().slice(0, 10)).run();
    const a = await startImport(env, v.vault, user, zipSync({ "a.md": strToU8("# a"), "b.md": strToU8("# b") }), false);
    const b = await startImport(env, v.vault, user, zipSync({ "pic.png": new Uint8Array([1]) }), false);
    if (!a.ok || !b.ok) throw new Error("start failed");
    for (let i = 0; i < 4; i++) await runDurableObjectAlarm(v.stub);
    const sa = await v.stub.importStatus(v.ref, a.job);
    expect(sa?.status).toBe("running");
    expect(Date.parse(sa?.deferred_until ?? "")).toBeGreaterThan(Date.now());
    expect((await v.stub.importStatus(v.ref, b.job))?.status).toBe("done");
    const alarm = await runInDurableObject(v.stub, (_o, state) => state.storage.getAlarm());
    // Nothing runnable: the next wake-up is the resume time (other maintenance may be sooner, never a 2 s spin).
    expect(alarm === null || alarm > Date.now() + 10_000).toBe(true);
  });
});
