// Import fix 3 (review-import2): a job finished locally whose D1 close failed is closed again by the
// next alarm, not left holding its reservation and outstanding slot until the nightly backstop.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defaultVault, makeUser } from "./helpers";

type Stub = ReturnType<typeof env.VAULT.getByName>;
type Ref = { id: string; name: string; ownerId: string };

const stagedOf = async (userId: string) =>
  (await env.DB.prepare("SELECT import_staged_bytes AS b FROM users WHERE id = ?").bind(userId).first<{ b: number }>())?.b ?? -1;
const d1Job = (id: string) =>
  env.DB.prepare("SELECT status, staged_bytes, finished_at FROM import_jobs WHERE id = ?")
    .bind(id)
    .first<{ status: string; staged_bytes: number; finished_at: string | null }>();
const markers = (stub: Stub) =>
  runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ job: string; status: string }>("SELECT job, status FROM import_close").toArray());
const nextAlarm = (stub: Stub) => runInDurableObject(stub, (_i, state) => state.storage.getAlarm());

async function stageJob(stub: Stub, ref: Ref, user: { id: string; username: string }, id: string, items: { path: string; content: string }[]) {
  await env.DB.prepare("INSERT INTO import_jobs (id, user_id, vault_id, status, staged_bytes, created_at) VALUES (?, ?, ?, 'staging', 0, ?)")
    .bind(id, user.id, ref.id, new Date().toISOString())
    .run();
  const r = await stub.importStage(
    ref,
    { id, source: "basic-memory", userId: user.id, username: user.username, overwrite: false },
    items.map((it) => ({ folder: "", title: it.path.replace(/\.md$/, ""), ...it })),
  );
  expect(r.ok).toBe(true);
}

describe("a finished job's D1 close is retried by the next alarm", () => {
  it("abort: D1 close fails after the local finish, the next alarm releases and closes it", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await stageJob(v.stub, v.ref, user, "fx3-abort", [{ path: "a.md", content: "a".repeat(1000) }]);
    expect(await stagedOf(user.id)).toBeGreaterThan(1000);

    await v.stub.setFaults(["import-close-fail"]);
    // Called inside the object so the injected rejection is caught there, not reported across RPC.
    const err = await runInDurableObject(v.stub, (inst: { importAbort: (r: Ref, j: string) => Promise<void> }) =>
      inst.importAbort(v.ref, "fx3-abort").then(
        () => "",
        (e: Error) => e.message,
      ),
    );
    expect(err).toMatch(/import-close-fail/);
    expect((await v.stub.importStatus(v.ref, "fx3-abort"))?.status).toBe("aborted"); // finished locally
    expect((await d1Job("fx3-abort"))?.status).toBe("staging"); // D1 still open and holding
    expect(await stagedOf(user.id)).toBeGreaterThan(1000);
    expect(await markers(v.stub)).toEqual([{ job: "fx3-abort", status: "aborted" }]);
    const alarm = await nextAlarm(v.stub);
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(30_000); // prompt, not the staging TTL or the nightly cron

    // Still failing: the marker survives the alarm and the alarm stays armed.
    await runDurableObjectAlarm(v.stub);
    expect(await markers(v.stub)).toHaveLength(1);
    expect(await nextAlarm(v.stub)).not.toBeNull();

    await v.stub.setFaults([]);
    await runDurableObjectAlarm(v.stub);
    expect(await markers(v.stub)).toEqual([]);
    const job = await d1Job("fx3-abort");
    expect(job?.status).toBe("aborted");
    expect(job?.staged_bytes).toBe(0);
    expect(job?.finished_at).not.toBeNull();
    expect(await stagedOf(user.id)).toBe(0);
  });

  it("done: a completed import whose D1 close fails is closed by the next alarm", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await stageJob(v.stub, v.ref, user, "fx3-done", [
      { path: "one.md", content: "# One\n\nfirst" },
      { path: "two.md", content: "# Two\n\nsecond" },
    ]);
    await v.stub.importStart(v.ref, "fx3-done");
    await v.stub.setFaults(["import-close-fail"]);
    for (let i = 0; i < 10 && (await v.stub.importStatus(v.ref, "fx3-done"))?.status !== "done"; i++) await runDurableObjectAlarm(v.stub);
    expect((await v.stub.importStatus(v.ref, "fx3-done"))?.status).toBe("done");
    expect((await d1Job("fx3-done"))?.status).toBe("running");
    expect(await markers(v.stub)).toEqual([{ job: "fx3-done", status: "done" }]);

    await v.stub.setFaults([]);
    await runDurableObjectAlarm(v.stub);
    expect(await markers(v.stub)).toEqual([]);
    expect((await d1Job("fx3-done"))?.status).toBe("done");
    expect(await stagedOf(user.id)).toBe(0);
  });
});
