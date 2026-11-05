// Imported notes keep Basic Memory's permalinks (slug of the file path, or frontmatter permalink);
// the title slug earlier imports used stays an alias; owners can repair notes imported before.
import { runDurableObjectAlarm } from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { bmPermalink } from "../src/markdown/bmslug";
import { caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { fetchWorker } from "./oauth";

describe("Basic Memory's permalink rule", () => {
  it.each([
    ["docs/My Feature.md", "docs/my-feature"],
    ["specs/API (v2).md", "specs/api-v2"],
    ["design/unified_model_refactor.md", "design/unified-model-refactor"],
    ["中文/测试文档.md", "中文/测试文档"],
    ["notes/会议Notes 2026.md", "notes/会议-notes-2026"],
    ["Version 2.0.0", "version-2.0.0"],
    ["decisions/4720 pump-stations walkthrough decisions D1-D8.md", "decisions/4720-pump-stations-walkthrough-decisions-d1-d8"],
    ["people/Ada Lovelace second brain.md", "people/ada-lovelace-second-brain"],
    ["projects/Cairn.md", "projects/cairn"],
    ["learnings/iOS PWA offline cache — the stale-read.md", "learnings/i-os-pwa-offline-cache-the-stale-read"],
    ["notes/🚀 Launch Plan.md", "notes/launch-plan"],
    ["notes/Café déjà vu.md", "notes/cafe-deja-vu"],
    ["quotes/Gupta — A copilot doesn’t fly the plane.md", "quotes/gupta-a-copilot-doesnt-fly-the-plane"],
    ["notes/Claude.md notes.md", "notes/claude.md-notes"],
    ["notes/Привет мир.md", "notes/privet-mir"],
    ["notes/--weird__name--.md", "notes/weird-name"],
  ])("%s → %s", (path, want) => expect(bmPermalink(path)).toBe(want));
});

async function upload(cookie: string, zip: Uint8Array) {
  const fd = new FormData();
  fd.set("file", new Blob([zip], { type: "application/zip" }), "bm.zip");
  const built = new Request("https://x/", { method: "POST", body: fd });
  const body = await built.arrayBuffer();
  return fetchWorker("/app/api/import", {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": built.headers.get("content-type") ?? "", "content-length": String(body.byteLength) },
    body,
  });
}

describe("import keeps Basic Memory's permalinks", () => {
  it("file-path slugs, frontmatter permalinks, the title slug as an alias, and colliding names reported", async () => {
    const { user, cookie } = await makeUser("perm");
    const v = await defaultVault(user.id);
    const zip = zipSync({
      "main/notes/accent-video.md": strToU8("---\ntitle: Hilarious accent video\n---\n- [fact] funny\n"),
      "main/learnings/iOS PWA offline cache — the stale-read.md": strToU8("---\ntitle: iOS PWA offline cache — the stale-read\n---\nbody\n"),
      "main/people/x.md": strToU8("---\ntitle: Explicit\npermalink: main/people/chosen-one\n---\nhi\n"),
      "main/notes/links.md": strToU8("---\ntitle: Links\n---\n- relates_to [[notes/hilarious-accent-video]]\n"),
      "main/dup/My Note.md": strToU8("---\ntitle: First\n---\none\n"),
      "main/dup/my-note.md": strToU8("---\ntitle: Second\n---\ntwo\n"),
    });
    const res = await upload(cookie, zip);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: string };
    for (let i = 0; i < 20 && (await runDurableObjectAlarm(v.stub)); i++);
    const read = async (id: string) => {
      const r = await v.stub.readNote(v.ref, { identifier: id });
      return r.ok ? { permalink: r.value.note.permalink, title: r.value.note.title } : null;
    };
    expect(await read("notes/accent-video")).toEqual({ permalink: "notes/accent-video", title: "Hilarious accent video" });
    expect(await read("learnings/i-os-pwa-offline-cache-the-stale-read")).toMatchObject({ title: "iOS PWA offline cache — the stale-read" });
    expect(await read("people/chosen-one")).toMatchObject({ title: "Explicit" });
    // The title slug (what earlier imports used) still resolves, as an alias.
    expect(await read("memory://notes/hilarious-accent-video")).toMatchObject({ permalink: "notes/accent-video" });
    const view = await v.stub.noteView(v.ref, "notes/accent-video");
    expect(view.ok && view.value.backlinks.map((b) => b.permalink)).toEqual(["notes/links"]);
    const links = await v.stub.noteView(v.ref, "notes/links");
    expect(links.ok && links.value.relations[0].resolved?.permalink).toBe("notes/accent-video");
    // Two files with the same Basic Memory permalink: the second is reported, not merged silently.
    const st = await v.stub.importStatus(v.ref, job);
    expect(st?.skipped.find((s) => s.path.startsWith("dup/"))?.message).toMatch(/already exists at dup\/my-note/);
  });
});

describe("re-derive permalinks (repair for earlier imports)", () => {
  it("previews, renames with revisions, keeps the old permalink as an alias, and is idempotent", async () => {
    const { user, cookie } = await makeUser("repair");
    const v = await defaultVault(user.id);
    // As an earlier import stored it: title slug as permalink, the file's own name kept.
    const imp = caller(user, "web", "import:basic-memory");
    await v.stub.writeNote(v.ref, imp, { identifier: "notes/accent-video.md", content: "---\ntitle: Hilarious accent video\n---\nhi\n" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Hand written", directory: "notes", content: "not imported" });
    await v.stub.writeNote(v.ref, caller(user), { title: "Linker", content: "- relates_to [[notes/hilarious-accent-video]]" });
    const before = await v.stub.readNote(v.ref, { identifier: "notes/accent-video.md" });
    expect(before.ok && before.value.note.permalink).toBe("notes/hilarious-accent-video");

    const preview = await (await fetchWorker("/app/settings/import/permalinks?project=main", { headers: { cookie } })).text();
    expect(preview).toContain("<code>notes/hilarious-accent-video</code>");
    expect(preview).toContain("<code>notes/accent-video</code>");
    expect(preview).not.toContain("hand-written");
    const applied = await fetchWorker("/app/settings/import/permalinks", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ project: "main" }),
    });
    expect(await applied.text()).toContain("1 renamed");
    const after = await v.stub.readNote(v.ref, { identifier: "notes/accent-video" });
    expect(after.ok && after.value.note.permalink).toBe("notes/accent-video");
    const old = await v.stub.readNote(v.ref, { identifier: "memory://notes/hilarious-accent-video" });
    expect(old.ok && old.value.note.permalink).toBe("notes/accent-video");
    const backlinks = await v.stub.noteView(v.ref, "notes/accent-video");
    expect(backlinks.ok && backlinks.value.backlinks.map((b) => b.title)).toEqual(["Linker"]);
    const hist = await v.stub.noteHistory(v.ref, "notes/accent-video");
    const rename = hist?.revisions.find((r) => r.action === "rename");
    expect(rename).toBeDefined();
    expect(await v.stub.revertRevision(v.ref, caller(user), rename!.id, after.ok ? after.value.note.checksum : "")).toMatchObject({
      ok: false,
      code: "INVALID",
    });
    const again = await (await fetchWorker("/app/settings/import/permalinks?project=main", { headers: { cookie } })).text();
    expect(again).toContain("already has Basic Memory's permalink");
  });
});
