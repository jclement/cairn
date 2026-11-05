import { describe, expect, it } from "vitest";
import { caller, defaultVault, makeUser } from "./helpers";

describe("vault service (Durable Object RPC)", () => {
  it("writes, reads, edits and deletes with revisions", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    const w = await stub.writeNote(ref, caller(user), {
      title: "Acme Corp",
      directory: "orgs",
      content: "# Acme Corp\n\n## Observations\n- [contact] Main contact is Dana Roe #people\n\n## Relations\n- contact [[Dana Roe]]\n",
      tags: ["customer"],
    });
    if (!w.ok) throw new Error(w.message);
    expect(w.value.created).toBe(true);
    expect(w.value.note.permalink).toBe("orgs/acme-corp");
    expect(w.value.note.file_path).toBe("orgs/Acme Corp.md");
    expect(w.value.unresolved).toEqual(["Dana Roe"]);
    expect(w.value.note.created_by_client).toBe("test-client");

    const r = await stub.readNote(ref, { identifier: "memory://orgs/acme-corp" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.content).toContain("title: Acme Corp");
    expect(r.value.content).not.toContain("permalink:");
    expect(r.value.content).toContain("- customer");

    // by title and by project-prefixed URL
    expect((await stub.readNote(ref, { identifier: "Acme Corp" })).ok).toBe(true);
    expect((await stub.readNote(ref, { identifier: "main/orgs/acme-corp" })).ok).toBe(true);

    // write without overwrite refuses
    const dup = await stub.writeNote(ref, caller(user), { title: "Acme Corp", directory: "orgs", content: "x" });
    expect(dup).toMatchObject({ ok: false, code: "ALREADY_EXISTS" });

    // checksum conflict
    const stale = await stub.editNote(ref, caller(user), {
      identifier: "orgs/acme-corp",
      command: "append",
      content: "- [x] y",
      expected_checksum: "deadbeef",
    });
    expect(stale).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });

    const e1 = await stub.editNote(ref, caller(user, "other-client"), {
      identifier: "orgs/acme-corp",
      command: "append",
      content: "- [status] Pilot ends 2026-12-15",
      expected_checksum: w.value.note.checksum,
    });
    if (!e1.ok) throw new Error(e1.message);
    expect(e1.value.note.checksum).not.toBe(w.value.note.checksum);
    expect(e1.value.note.updated_by_client).toBe("other-client");

    const e2 = await stub.editNote(ref, caller(user), {
      identifier: "orgs/acme-corp",
      command: "replace_section",
      section: "Relations",
      content: "- uses [[Cairn]]",
    });
    if (!e2.ok) throw new Error(e2.message);
    const e3 = await stub.editNote(ref, caller(user), { identifier: "orgs/acme-corp", command: "find_replace", find_text: "Dana Roe", content: "Sam Lee" });
    expect(e3).toMatchObject({ ok: true });
    const e4 = await stub.editNote(ref, caller(user), { identifier: "orgs/acme-corp", command: "prepend", content: "Summary first." });
    expect(e4).toMatchObject({ ok: true });
    const e5 = await stub.editNote(ref, caller(user), { identifier: "orgs/acme-corp", command: "find_replace", find_text: "nope", content: "x" });
    expect(e5).toMatchObject({ ok: false, code: "INVALID" });

    const view = await stub.noteView(ref, "orgs/acme-corp");
    if (!view.ok) throw new Error(view.message);
    const body = view.value.content;
    expect(body.indexOf("Summary first.")).toBeLessThan(body.indexOf("# Acme Corp"));
    expect(body).toContain("- uses [[Cairn]]");
    expect(body).not.toContain("contact [[Dana Roe]]");
    expect(body).toContain("Sam Lee");
    // the appended status line sat inside "Relations", so replace_section replaced it too
    expect(view.value.observations.map((o) => o.category)).toEqual(["contact"]);
    expect(body).not.toContain("Pilot ends");
    expect(view.value.relations).toEqual([{ type: "uses", target: "Cairn", context: null, resolved: null }]);

    const revs = await stub.revisions(ref, "orgs/acme-corp");
    expect(revs.map((r) => r.action)).toEqual(["update", "update", "update", "update", "create"]);
    expect(revs[3].client).toBe("other-client");

    const d = await stub.deleteNote(ref, caller(user), { identifier: "orgs/acme-corp" });
    expect(d.ok).toBe(true);
    expect(await stub.readNote(ref, { identifier: "orgs/acme-corp" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const recent = await stub.recent(ref, {});
    expect(recent.writes[0]).toMatchObject({ action: "delete", permalink: "orgs/acme-corp" });
  });

  it("resolves forward references once the target exists, and backlinks", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    await stub.writeNote(ref, caller(user), { title: "Dana Roe", directory: "people", content: "- works_at [[Acme Corp]]\nSee also [[Nowhere]]." });
    let v = await stub.noteView(ref, "people/dana-roe");
    if (!v.ok) throw new Error();
    expect(v.value.links).toEqual({ "Acme Corp": null, Nowhere: null });
    await stub.writeNote(ref, caller(user), { title: "Acme Corp", content: "An org." });
    v = await stub.noteView(ref, "people/dana-roe");
    if (!v.ok) throw new Error();
    expect(v.value.links["Acme Corp"]).toBe("acme-corp");
    const acme = await stub.noteView(ref, "acme-corp");
    if (!acme.ok) throw new Error();
    expect(acme.value.backlinks.map((b) => b.permalink)).toEqual(["people/dana-roe"]);
    const ctx = await stub.buildContext(ref, { identifier: "acme-corp", depth: 2 });
    if (!ctx.ok) throw new Error();
    expect(ctx.value.related).toMatchObject([{ permalink: "people/dana-roe", direction: "incoming", via: "works_at" }]);
    // deleting the target leaves the link unresolved, not gone
    await stub.deleteNote(ref, caller(user), { identifier: "acme-corp" });
    v = await stub.noteView(ref, "people/dana-roe");
    if (!v.ok) throw new Error();
    expect(v.value.relations.map((r) => [r.target, r.resolved])).toEqual([
      ["Acme Corp", null],
      ["Nowhere", null],
    ]);
  });

  it("enforces the 1 MB note limit", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    const r = await stub.writeNote(ref, caller(user), { title: "Big", content: "x".repeat(1024 * 1024 + 1) });
    expect(r).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("lists folders one level at a time", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    for (const [dir, title] of [
      ["", "Root"],
      ["a", "A1"],
      ["a/b", "B1"],
      ["c", "C1"],
    ]) {
      await stub.writeNote(ref, caller(user), { title, directory: dir, content: "x" });
    }
    const root = await stub.listDirectory(ref, {});
    expect(root.folders).toEqual([
      { name: "a", path: "a", notes: 2 },
      { name: "c", path: "c", notes: 1 },
    ]);
    expect(root.notes.map((n) => n.title)).toEqual(["Root"]);
    const a = await stub.listDirectory(ref, { path: "a" });
    expect(a.folders).toEqual([{ name: "b", path: "a/b", notes: 1 }]);
  });
});

describe("search", () => {
  it("finds notes and observations, with matching lines, scoped to the vault", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    await stub.writeNote(ref, caller(user), {
      title: "Cache design",
      directory: "specs",
      content: "We considered memcached.\n\n- [decision] Use Redis for the session cache #infra\n",
    });
    await stub.writeNote(ref, caller(user), { title: "Lunch", content: "Tacos on Tuesday." });
    await stub.writeNote(ref, caller(user), { title: "Meeting", note_type: "meeting", content: "Discussed redis upgrades." });

    const r = await stub.search(ref, { query: "redis" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.hits.map((h) => h.permalink).sort()).toEqual(["meeting", "specs/cache-design"]);
    const cache = r.value.hits.find((h) => h.permalink === "specs/cache-design");
    expect(cache?.observations).toEqual([{ category: "decision", content: "Use Redis for the session cache #infra", context: null }]);
    expect(cache?.matches[0].text).toContain("Redis");

    const typed = await stub.search(ref, { query: "redis", note_types: ["meeting"] });
    expect(typed.ok && typed.value.hits.map((h) => h.permalink)).toEqual(["meeting"]);
    const tagged = await stub.search(ref, { query: "tag:infra" });
    expect(tagged.ok && tagged.value.hits.map((h) => h.permalink)).toEqual(["specs/cache-design"]);
    const folder = await stub.search(ref, { query: "redis", path: "specs" });
    expect(folder.ok && folder.value.hits.map((h) => h.permalink)).toEqual(["specs/cache-design"]);
    // stemming + OR fallback
    const stem = await stub.search(ref, { query: "upgrade tacos" });
    expect(stem.ok && stem.value.hits.map((h) => h.permalink).sort()).toEqual(["lunch", "meeting"]);
    // hostile FTS syntax doesn't throw
    const weird = await stub.search(ref, { query: '"unbalanced AND ( NOT * NEAR' });
    expect(weird.ok).toBe(true);
    const title = await stub.search(ref, { query: "lun", mode: "title" });
    expect(title.ok && title.value.hits.map((h) => h.permalink)).toEqual(["lunch"]);
  });

  it("fuses semantic results (fake embedder) and survives without them", async () => {
    const { user } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    await stub.writeNote(ref, caller(user), { title: "Garden", content: "Tomatoes need full sun and regular watering." });
    await stub.writeNote(ref, caller(user), { title: "Car", content: "Oil change every ten thousand kilometres." });
    await stub.embedPending();
    const stats = await stub.stats(ref);
    expect(stats.semantic).toBe(true);
    expect(stats.pendingEmbeddings).toBe(0);
    const r = await stub.search(ref, { query: "watering tomatoes sun", mode: "semantic" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.modes_used).toEqual(["semantic"]);
    expect(r.value.hits[0].permalink).toBe("garden");
    const h = await stub.search(ref, { query: "oil change" });
    if (!h.ok) throw new Error(h.message);
    expect(h.value.modes_used).toEqual(["text", "semantic"]);
    expect(h.value.hits[0].permalink).toBe("car");
  });
});
