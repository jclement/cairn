// Review-roundup findings 1 and 2: an import's files are its own until it commits; rollback and
// the sweep remove only files still owned by it, never ones another operation has reused.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { putAttachment, releaseImportFiles, sweepAttachments } from "../src/capture/files";
import { defaultVault, makeUser, ORIGIN } from "./helpers";
import { fetchWorker } from "./oauth";

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]);
const row = (id: string) =>
  env.DB.prepare("SELECT state, import_job FROM attachments WHERE id = ?").bind(id).first<{ state: string; import_job: string | null }>();

async function upload(cookie: string, zip: Uint8Array) {
  const fd = new FormData();
  fd.set("file", new Blob([zip], { type: "application/zip" }), "x.zip");
  const built = new Request("https://x/", { method: "POST", body: fd });
  const body = await built.arrayBuffer();
  return fetchWorker("/app/api/import", {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": built.headers.get("content-type") ?? "", "content-length": String(body.byteLength) },
    body,
  });
}

describe("1. rollback never deletes a file another operation reused", () => {
  it("a reused import file is adopted and survives the import's rollback; an unreused one goes", async () => {
    const { user } = await makeUser("rnd1");
    const v = await defaultVault(user.id);
    const a = await putAttachment(env, v.vault, { bytes: png(1), name: "shared.png", source: "import", caption: false, importJob: "jobA" });
    const lone = await putAttachment(env, v.vault, { bytes: png(2), name: "lone.png", source: "import", caption: false, importJob: "jobA" });
    if (!a.ok || !lone.ok) throw new Error("put failed");
    expect((await row(a.attachment.id))?.import_job).toBe("jobA");
    // Another upload (attach_file, another import…) reuses the same bytes while A is in flight.
    const b = await putAttachment(env, v.vault, { bytes: png(1), name: "mine.png", source: "upload" });
    expect(b).toMatchObject({ ok: true, created: false });
    expect((await row(a.attachment.id))?.import_job).toBeNull(); // adopted
    // A fails: only its unreused file goes.
    expect(await releaseImportFiles(env, v.vault.id, "jobA")).toBe(1);
    expect(await row(a.attachment.id)).toMatchObject({ state: "ready" });
    expect(await row(lone.attachment.id)).toBeNull();
  });

  it("if the rollback lands first, the other upload stores its own copy instead of reusing a dying one", async () => {
    const { user } = await makeUser("rnd1b");
    const v = await defaultVault(user.id);
    const a = await putAttachment(env, v.vault, { bytes: png(3), name: "a.png", source: "import", caption: false, importJob: "jobB" });
    if (!a.ok) throw new Error("put failed");
    expect(await releaseImportFiles(env, v.vault.id, "jobB")).toBe(1);
    const b = await putAttachment(env, v.vault, { bytes: png(3), name: "b.png", source: "upload" });
    expect(b).toMatchObject({ ok: true, created: true });
    expect(b.ok && b.attachment.id).not.toBe(a.attachment.id);
  });

  it("an import that fails at staging rolls back its files; a successful one commits them", async () => {
    const { user, cookie } = await makeUser("rnd1c");
    const v = await defaultVault(user.id);
    await v.stub.setLimitsForTest({ importStagingBytes: 10 });
    const refused = await upload(cookie, zipSync({ "n.md": strToU8("![[p.png]]"), "p.png": png(4) }));
    expect(refused.status).toBe(413);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE vault_id = ? AND state != 'deleting'")
      .bind(v.vault.id)
      .first<{ n: number }>();
    expect(after?.n).toBe(0);
    await v.stub.setLimitsForTest({ importStagingBytes: 25 * 1024 * 1024 });
    const okRes = await upload(cookie, zipSync({ "n.md": strToU8("![[p.png]]"), "p.png": png(5) }));
    expect(okRes.status).toBe(202);
    for (let i = 0; i < 10 && (await runDurableObjectAlarm(v.stub)); i++);
    const owned = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE vault_id = ? AND import_job IS NOT NULL")
      .bind(v.vault.id)
      .first<{ n: number }>();
    expect(owned?.n).toBe(0);
  });
});

describe("2. files of an import whose uploader died are settled by the sweep", () => {
  it("by the job's state: never started → deleted, started → committed, unknown → deleted", async () => {
    const { user } = await makeUser("rnd2");
    const v = await defaultVault(user.id);
    const old = new Date(Date.now() - 60 * 60e3).toISOString();
    const mk = async (job: string, n: number) => {
      const r = await putAttachment(env, v.vault, { bytes: png(n), name: `${job}.png`, source: "import", caption: false, importJob: job });
      if (!r.ok) throw new Error("put failed");
      await env.DB.prepare("UPDATE attachments SET created_at = ? WHERE id = ?").bind(old, r.attachment.id).run();
      return r.attachment.id;
    };
    const job = (id: string, status: string) =>
      env.DB.prepare("INSERT INTO import_jobs (id, user_id, vault_id, status, staged_bytes, created_at) VALUES (?, ?, ?, ?, 0, ?)")
        .bind(id, user.id, v.vault.id, status, old)
        .run();
    await job("died", "staging");
    await job("started", "running");
    await job("aborted", "aborted");
    const died = await mk("died", 6);
    const started = await mk("started", 7);
    const aborted = await mk("aborted", 8);
    const gone = await mk("no-such-job", 9);
    const fresh = await putAttachment(env, v.vault, { bytes: png(10), name: "fresh.png", source: "import", caption: false, importJob: "in-flight" });
    const r = await sweepAttachments(env);
    expect(r.importFiles).toBe(3);
    expect(await row(died)).toBeNull();
    expect(await row(aborted)).toBeNull();
    expect(await row(gone)).toBeNull();
    expect(await row(started)).toMatchObject({ state: "ready", import_job: null });
    // A file from the last half hour is left alone (its upload may still be running).
    expect(fresh.ok && (await row(fresh.attachment.id))?.state).toBe("ready");
  });
});
