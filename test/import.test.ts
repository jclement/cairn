// Round 3b import: Basic Memory and Obsidian zips, idempotent re-upload, quota, limiter, report.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_OVERHEAD } from "../src/capture/files";
import { createVault, userBytes } from "../src/directory";
import { LIMITS } from "../src/env";
import { prepareImport } from "../src/import";
import { createApp } from "../src/web/app";
import { defaultVault, makeUser, ORIGIN } from "./helpers";
import { fetchWorker } from "./oauth";

const bmZip = () =>
  zipSync({
    "main/people/Dana Roe.md": strToU8(
      "---\ntitle: Dana Roe\ntype: person\npermalink: main/people/dana-roe\ntags: [customer]\n---\n# Dana Roe\n\n- [role] CTO at Acme #people\n- works_at [[Acme Corp]]\n",
    ),
    "main/orgs/Acme Corp.md": strToU8(
      "---\ntitle: Acme Corp\ntype: org\npermalink: main/orgs/acme-corp\n---\n# Acme Corp\n\n- [industry] Water\n- employs [[Dana Roe]]\n",
    ),
    "main/assets/logo.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    "main/notes/Huge.md": strToU8("x".repeat(LIMITS.noteBytes + 10)),
    "main/notes/Binary.md": new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x80]),
  });

const obsidianZip = () =>
  zipSync({
    "MyVault/.obsidian/app.json": strToU8("{}"),
    "MyVault/Daily/2026-11-01.md": strToU8("Worked on [[Project X]] today.\n\n![[diagram.png]]\n- [decision] Ship Friday #x\n"),
    "MyVault/Project X.md": strToU8("# Project X\n\nOwner: [[Dana]]\n"),
    "MyVault/attachments/diagram.png": new Uint8Array([1, 2, 3]),
    "MyVault/.DS_Store": new Uint8Array([0]),
  });

async function upload(cookie: string, zip: Uint8Array, fields: Record<string, string> = {}, path = "/app/api/import", e?: typeof env) {
  const fd = new FormData();
  fd.set("file", new Blob([zip], { type: "application/zip" }), "export.zip");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  // Real clients send Content-Length for multipart; build the body so the request has one.
  const built = new Request("https://x/", { method: "POST", body: fd });
  const body = await built.arrayBuffer();
  const init = {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": built.headers.get("content-type") ?? "", "content-length": String(body.byteLength) },
    body,
  };
  return e ? createApp().request(path, init, e) : fetchWorker(path, init);
}

async function drain(stub: ReturnType<typeof env.VAULT.getByName>) {
  for (let i = 0; i < 20 && (await runDurableObjectAlarm(stub)); i++);
}

describe("prepareImport (pure)", () => {
  it("detects the source, strips the wrapper and BM's project prefix, lists attachments", () => {
    const bm = prepareImport(bmZip());
    expect(bm.source).toBe("basic-memory");
    expect(bm.strippedPrefix).toBe("main");
    expect(bm.attachments).toEqual(["assets/logo.png"]);
    expect(bm.items.find((i) => i.path === "people/Dana Roe.md")?.content).toContain("permalink: people/dana-roe");
    expect(bm.items.find((i) => i.path === "notes/Huge.md")).toMatchObject({ status: "skipped", content: null });
    expect(bm.items.find((i) => i.path === "notes/Binary.md")).toMatchObject({ status: "skipped", message: "not valid UTF-8 text" });
    const ob = prepareImport(obsidianZip());
    expect(ob.source).toBe("obsidian");
    expect(ob.strippedPrefix).toBeNull();
    expect(ob.items.map((i) => i.path).sort()).toEqual(["Daily/2026-11-01.md", "Project X.md"]);
    expect(ob.attachments).toEqual(["attachments/diagram.png"]);
    expect(ob.ignored).toBe(2);
  });
});

describe("import end to end", () => {
  it("imports a Basic Memory project with observations, relations and permalinks; reports skips; is idempotent", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    const res = await upload(cookie, bmZip());
    expect(res.status).toBe(202);
    const { job, status_url } = (await res.json()) as { job: string; status_url: string };
    await drain(v.stub); // processed by the DO's alarm, in batches
    const st = (await (await fetchWorker(status_url, { headers: { cookie } })).json()) as {
      status: string;
      counts: Record<string, number>;
      skipped: { path: string; message: string }[];
    };
    expect(st.status).toBe("done");
    expect(st.counts).toMatchObject({ imported: 2, skipped: 2, attached: 1 });
    expect(st.skipped.map((s) => s.path).sort()).toEqual(["notes/Binary.md", "notes/Huge.md"]);
    const dana = await v.stub.noteView(v.ref, "people/dana-roe");
    if (!dana.ok) throw new Error(dana.message);
    expect(dana.value.observations.map((o) => o.category)).toEqual(["role"]);
    expect(dana.value.relations[0]).toMatchObject({ type: "works_at", target: "Acme Corp", resolved: { permalink: "orgs/acme-corp" } });
    expect(dana.value.note.file_path).toBe("people/Dana Roe.md");
    expect((await v.stub.noteHistory(v.ref, "people/dana-roe"))?.revisions[0].tool).toBe("import:basic-memory");
    // Notes are charged through the vault; the attached logo (7 bytes + per-file overhead) on top.
    expect(await userBytes(env, user.id)).toBe((await v.stub.stats(v.ref)).totalBytes + 7 + ATTACHMENT_OVERHEAD);

    // same zip again: nothing changes
    const again = (await (await upload(cookie, bmZip())).json()) as { job: string };
    await drain(v.stub);
    const st2 = await v.stub.importStatus(v.ref, again.job);
    expect(st2?.counts).toMatchObject({ skipped: 2, unchanged: 2, attached: 1 });
    expect((await v.stub.noteHistory(v.ref, "people/dana-roe"))?.revisions.length).toBe(1);
    void job;
  });

  it("imports an Obsidian vault into another project with wiki links resolved", async () => {
    const { user, cookie } = await makeUser();
    const r = await createVault(env, user.id, "obs");
    if (!r.ok) throw new Error(r.message);
    const stub = env.VAULT.getByName(r.vault.id);
    const ref = { id: r.vault.id, name: "obs", ownerId: user.id };
    const res = (await (await upload(cookie, obsidianZip(), { project: "obs" })).json()) as { job: string; project: string };
    expect(res.project).toBe("obs");
    await drain(stub);
    const st = await stub.importStatus(ref, res.job);
    expect(st?.source).toBe("obsidian");
    expect(st?.counts).toMatchObject({ imported: 2, attached: 1 });
    const day = await stub.noteView(ref, "daily/2026-11-01");
    if (!day.ok) throw new Error(day.message);
    // ![[diagram.png]] now points at the stored file.
    expect(day.value.content).toMatch(/\[diagram\.png\]\(\/app\/files\/[^/]+\/[a-z0-9]{12}\)/);
    expect(day.value.links["Project X"]).toBe("project-x");
    expect(day.value.links.Dana).toBeUndefined();
    expect(day.value.content).not.toContain("![[diagram.png]]"); // not an image by its bytes, so a plain link
    expect(day.value.observations.map((o) => o.content)).toEqual(["Ship Friday #x"]);
  });

  it("respects the storage quota per note and doesn't spend the interactive write limiter per note", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    await env.DB.prepare("UPDATE users SET bytes_used = ? WHERE id = ?")
      .bind(LIMITS.userBytes - 10_000, user.id)
      .run();
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 30; i++) files[`n${i}.md`] = strToU8(`---\ntitle: Note ${i}\n---\nbody ${i}`);
    let calls = 0;
    const oneWrite = { limit: async () => ({ success: calls++ === 0 }) };
    const res = await upload(cookie, zipSync(files), {}, "/app/api/import", { ...env, RL_WRITE: oneWrite } as typeof env);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: string };
    await drain(v.stub);
    const st = await v.stub.importStatus(v.ref, job);
    expect((st?.counts.imported ?? 0) + (st?.counts.skipped ?? 0)).toBe(30);
    expect(st?.counts.skipped ?? 0).toBeGreaterThan(0);
    expect(st?.skipped[0].message).toMatch(/^QUOTA/);
    expect(await userBytes(env, user.id)).toBeLessThanOrEqual(LIMITS.userBytes);
    // a second upload in the same minute is limited (one upload = one write)
    expect((await upload(cookie, zipSync(files), {}, "/app/api/import", { ...env, RL_WRITE: oneWrite } as typeof env)).status).toBe(429);
  });

  it("the settings page uploads without JavaScript and shows progress and the report", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    expect(await (await fetchWorker("/app/settings/import", { headers: { cookie } })).text()).toContain('enctype="multipart/form-data"');
    const res = await upload(cookie, bmZip(), { project: "main" }, "/app/settings/import");
    expect(res.status).toBe(303);
    const loc = res.headers.get("location") ?? "";
    const running = await fetchWorker(loc, { headers: { cookie } });
    expect(running.headers.get("refresh")).toBe("2");
    await drain(v.stub);
    const done = await fetchWorker(loc, { headers: { cookie } });
    expect(done.headers.get("refresh")).toBeNull();
    const html = await done.text();
    expect(html).toContain("2 imported");
    expect(html).toContain("1 files attached");
    expect(html).toContain("<code>notes/Huge.md</code>");
    // another user can't read this job
    const other = await makeUser();
    expect((await fetchWorker(loc, { headers: { cookie: other.cookie } })).status).toBe(404);
  });

  it("is off unless IMPORT_ENABLED is true: routes 404 and Settings hides it", async () => {
    const { cookie } = await makeUser();
    const off = { ...env, IMPORT_ENABLED: "false" } as typeof env;
    const app = createApp();
    expect((await app.request("/app/settings/import", { headers: { cookie } }, off)).status).toBe(404);
    expect((await upload(cookie, bmZip(), {}, "/app/api/import", off)).status).toBe(404);
    expect((await upload(cookie, bmZip(), {}, "/app/settings/import", off)).status).toBe(404);
    expect((await app.request("/app/api/import/x", { headers: { cookie } }, off)).status).toBe(404);
    expect(await (await app.request("/app/settings", { headers: { cookie } }, off)).text()).not.toContain("/app/settings/import");
    expect(await (await app.request("/app/settings", { headers: { cookie } }, env)).text()).toContain("/app/settings/import");
  });
});
