// Import fix (review of round 3b): bounded decompression, staging admission and cleanup, bulk
// budget, cron deadline, expiry cursor, unsafe paths.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createVault, userBytes } from "../src/directory";
import { LIMITS } from "../src/env";
import { IMPORT_LIMITS, planImport, prepareImport, startImport } from "../src/import";
import { fanOut } from "../src/memory/cron";
import { createApp } from "../src/web/app";
import { caller, defaultVault, makeUser, ORIGIN } from "./helpers";

async function multipart(zip: Uint8Array, fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("file", new Blob([zip], { type: "application/zip" }), "x.zip");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const built = new Request("https://x/", { method: "POST", body: fd });
  return { body: await built.arrayBuffer(), type: built.headers.get("content-type") ?? "" };
}
async function upload(cookie: string, zip: Uint8Array, fields: Record<string, string> = {}) {
  const { body, type } = await multipart(zip, fields);
  return createApp().request(
    "/app/api/import",
    { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": type, "content-length": String(body.byteLength) }, body },
    env,
  );
}
const notesZip = (n: number, prefix = "n", extra = "") => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < n; i++) files[`${prefix}${i}.md`] = strToU8(`---\ntitle: ${prefix} ${i}\n---\nbody ${i}${extra}`);
  return zipSync(files);
};
const stagedOf = async (userId: string) =>
  (await env.DB.prepare("SELECT import_staged_bytes AS b FROM users WHERE id = ?").bind(userId).first<{ b: number }>())?.b ?? -1;
async function drain(stub: DurableObjectStub, max = 30) {
  for (let i = 0; i < max && (await runDurableObjectAlarm(stub)); i++);
}
/** Run the vault's alarm until this import finishes, stops, or pauses for the day. */
async function drainJob(stub: ReturnType<typeof env.VAULT.getByName>, ref: { id: string; name: string; ownerId: string }, job: string, max = 40) {
  for (let i = 0; i < max; i++) {
    const st = await stub.importStatus(ref, job);
    if (!st || st.status === "done" || st.status === "aborted" || (st.deferred_until && Date.parse(st.deferred_until) > Date.now() + 60_000)) return;
    await runDurableObjectAlarm(stub);
  }
}
/** Patch an entry's declared uncompressed size in both headers (simulating a lying archive). */
function lieAboutSize(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = dv.getUint32(i, true);
    if (sig === 0x04034b50) dv.setUint32(i + 22, size, true);
    if (sig === 0x02014b50) dv.setUint32(i + 24, size, true);
  }
  return out;
}

describe("1: bounded decompression", () => {
  it("rejects a compressed bomb by declared size, before inflating anything", () => {
    const files: Record<string, Uint8Array> = {};
    const mb = new Uint8Array(1024 * 1024).fill(97);
    for (let i = 0; i < 52; i++) files[`b${i}.md`] = mb;
    const zip = zipSync(files, { level: 9 });
    expect(zip.length).toBeLessThan(200_000);
    expect(() => planImport(zip)).toThrow(/add up to more than/);
  });

  it("refuses the whole archive when an entry expands beyond its claimed size", () => {
    const zip = lieAboutSize(zipSync({ "liar.md": new Uint8Array(LIMITS.noteBytes + 4096).fill(98) }, { level: 9 }), 100);
    expect(planImport(zip).notes.length).toBe(1);
    expect(() => prepareImport(zip)).toThrow(/larger than it claims/);
  });

  it("refuses too many entries from the directory alone", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= IMPORT_LIMITS.entries; i++) files[`e${i}.txt`] = new Uint8Array(0);
    expect(() => planImport(zipSync(files, { level: 0 }))).toThrow(/more than 5000 files/);
  });

  it("caps the request body before parsing it", async () => {
    const { cookie } = await makeUser();
    const { body, type } = await multipart(notesZip(1));
    const app = createApp();
    const big = await app.request(
      "/app/api/import",
      { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": type, "content-length": String(IMPORT_LIMITS.requestBytes + 1) }, body },
      env,
    );
    expect(big.status).toBe(413);
    const none = await app.request(
      "/app/api/import",
      {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": type },
        body: new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(body)), c.close()) }),
      },
      env,
    );
    expect(none.status).toBe(411);
  });
});

describe("2: staging is reserved against the account, bounded, and cleaned up", () => {
  it("a full account can't stage, and nothing is left behind", async () => {
    const { user, cookie } = await makeUser();
    await env.DB.prepare("UPDATE users SET bytes_used = ? WHERE id = ?")
      .bind(LIMITS.userBytes - 100, user.id)
      .run();
    const r = await upload(cookie, notesZip(5));
    expect(r.status).toBe(413);
    expect(await stagedOf(user.id)).toBe(0);
    expect((await env.DB.prepare("SELECT status FROM import_jobs WHERE user_id = ?").bind(user.id).first<{ status: string }>())?.status).toBe("aborted");
  });

  it("caps outstanding jobs per account; staged bytes are released as the import completes", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    const a = (await (await upload(cookie, notesZip(3, "a"))).json()) as { job: string };
    const b = (await (await upload(cookie, notesZip(3, "b"))).json()) as { job: string };
    expect(a.job && b.job).toBeTruthy();
    expect(await stagedOf(user.id)).toBeGreaterThan(0);
    expect((await upload(cookie, notesZip(3, "c"))).status).toBe(429);
    await drainJob(v.stub, v.ref, a.job);
    await drainJob(v.stub, v.ref, b.job);
    expect(await stagedOf(user.id)).toBe(0);
    expect((await upload(cookie, notesZip(3, "c"))).status).toBe(202);
  });

  it("interrupted staging is aborted after its TTL and releases its reservation", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setLimitsForTest({ importStagingTtlMs: 1 });
    const id = "stuck-job";
    await env.DB.prepare("INSERT INTO import_jobs (id, user_id, vault_id, status, staged_bytes, created_at) VALUES (?, ?, ?, 'staging', 0, ?)")
      .bind(id, user.id, v.vault.id, new Date().toISOString())
      .run();
    const s = await v.stub.importStage(v.ref, { id, source: "basic-memory", userId: user.id, username: user.username, overwrite: false }, [
      { path: "x.md", folder: "", title: "x", content: "hello" },
    ]);
    expect(s.ok).toBe(true);
    expect(await stagedOf(user.id)).toBeGreaterThan(0);
    // the uploader never calls importStart
    await new Promise((r) => setTimeout(r, 5));
    await drain(v.stub);
    expect(await stagedOf(user.id)).toBe(0);
    expect((await env.DB.prepare("SELECT status FROM import_jobs WHERE id = ?").bind(id).first<{ status: string }>())?.status).toBe("aborted");
    expect((await v.stub.importStatus(v.ref, id))?.status).toBe("aborted");
  });

  it("repeated identical uploads keep a bounded history", async () => {
    const { user } = await makeUser();
    const r = await createVault(env, user.id, "rep");
    if (!r.ok) throw new Error(r.message);
    const stub = env.VAULT.getByName(r.vault.id);
    const jobs: string[] = [];
    for (let i = 0; i < 7; i++) {
      const s = await startImport(env, r.vault, user, notesZip(4), false);
      if (!s.ok) throw new Error(s.error);
      jobs.push(s.job);
      await drainJob(stub, { id: r.vault.id, name: "rep", ownerId: user.id }, s.job);
    }
    const ref = { id: r.vault.id, name: "rep", ownerId: user.id };
    expect(await stub.importStatus(ref, jobs[0])).toBeNull(); // pruned
    expect((await stub.importStatus(ref, jobs[6]))?.counts).toMatchObject({ unchanged: 4 });
    expect(await stagedOf(user.id)).toBe(0);
  });
});

describe("3: bulk import has a daily per-account budget and defers instead of dropping", () => {
  it("imports up to the budget, then pauses until tomorrow", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setLimitsForTest({ importNotesPerDay: 10 });
    const res = (await (await upload(cookie, notesZip(30))).json()) as { job: string };
    await drainJob(v.stub, v.ref, res.job);
    const st = await v.stub.importStatus(v.ref, res.job);
    expect(st?.counts.imported).toBe(10);
    expect(st?.counts.pending).toBe(20);
    expect(st?.status).toBe("running");
    expect(Date.parse(st?.deferred_until ?? "")).toBeGreaterThan(Date.now());
    const page = await (await createApp().request(`/app/settings/import?job=${res.job}&project=main`, { headers: { cookie } }, env)).text();
    expect(page).toContain("paused: daily import limit reached");
  });
});

describe("4: the cron deadline bounds running work", () => {
  it("a call that never settles is counted unknown and fanOut returns at the deadline", async () => {
    const rows = [1, 2, 3].map((i) => ({ id: `v${i}`, name: "main", owner_id: "u" }));
    const t0 = Date.now();
    const r = await fanOut(rows, () => new Promise(() => {}), Date.now() + 50);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ ok: 0, failed: 0, unknown: 3, deferred: 0 });
  });
});

describe("5: failing expiries can't starve later notes", () => {
  it("the cursor moves past notes that fail and reaches the ones behind them", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.setJevTestMode({ JEV_MODEL: "" });
    for (let i = 0; i < 3; i++)
      await v.stub.writeNote(v.ref, caller(user), { title: `Big ${i}`, content: `${"x".repeat(8000)}\n- [promo] big ${i} (expires 2020-01-01)` });
    for (let i = 0; i < 2; i++) await v.stub.writeNote(v.ref, caller(user), { title: `Small ${i}`, content: `- [promo] small ${i} (expires 2020-01-01)` });
    await env.DB.prepare("UPDATE users SET bytes_used = ? WHERE id = ?")
      .bind(LIMITS.userBytes - 8000, user.id)
      .run();
    await v.stub.setLimitsForTest({ expirePerPass: 3 });
    const today = new Date().toISOString().slice(0, 10);
    expect(await v.stub.expireDue(v.ref, today)).toMatchObject({ notes: 0, more: true }); // the 3 big ones fail on quota
    await drain(v.stub, 5); // the continuation picks up after them
    for (const p of ["small-0", "small-1"]) {
      const r = await v.stub.readNote(v.ref, { identifier: p });
      expect(r.ok && r.value.content).toContain("## Superseded");
    }
    const big = await v.stub.readNote(v.ref, { identifier: "big-0" });
    expect(big.ok && big.value.content).not.toContain("## Superseded");
  });
});

describe("6: unsafe archive paths are rejected at the boundary", () => {
  it("rejects absolute, drive, backslash, dot-segment and empty-segment paths and reports each", () => {
    const zip = zipSync({
      "../evil.md": strToU8("x"),
      "/abs.md": strToU8("x"),
      "a\\..\\b.md": strToU8("x"),
      "C:/x.md": strToU8("x"),
      "a/./b.md": strToU8("x"),
      "a//c.md": strToU8("x"),
      "ok/fine.md": strToU8("# fine"),
    });
    const plan = planImport(zip);
    expect(plan.notes.map((n) => n.path)).toEqual(["fine.md"]); // "ok/" wraps every safe entry, so it is stripped
    const reasons = Object.fromEntries(plan.reported.map((r) => [r.path, r.message]));
    expect(reasons["../evil.md"]).toMatch(/'\.\.' segment/);
    expect(reasons["/abs.md"]).toMatch(/absolute path/);
    expect(reasons["a\\..\\b.md"]).toMatch(/backslash/);
    expect(reasons["C:/x.md"]).toMatch(/drive letter/);
    expect(reasons["a/./b.md"]).toMatch(/'\.' or/);
    expect(reasons["a//c.md"]).toMatch(/empty/);
  });
});

void userBytes;
