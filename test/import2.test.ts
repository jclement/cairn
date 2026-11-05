// Import round 2 (bm-compare §5 items 9 and 11): archive files become attachments with their
// links rewritten (and exported back as relative paths); frontmatter edits splice only changed keys.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/directory";
import { attachmentLinks, rewriteAttachmentLinks } from "../src/import";
import { setFrontmatter, splitFrontmatter } from "../src/markdown/parse";
import { buildExportZip } from "../src/web/export";
import { caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { fetchWorker, mcp } from "./oauth";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = strToU8("%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n");

async function upload(cookie: string, zip: Uint8Array) {
  const fd = new FormData();
  fd.set("file", new Blob([zip], { type: "application/zip" }), "export.zip");
  const built = new Request("https://x/", { method: "POST", body: fd });
  const body = await built.arrayBuffer();
  return fetchWorker("/app/api/import", {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": built.headers.get("content-type") ?? "", "content-length": String(body.byteLength) },
    body,
  });
}

async function importZip(zip: Uint8Array) {
  const { user, cookie } = await makeUser("imp2");
  const v = await defaultVault(user.id);
  const res = await upload(cookie, zip);
  expect(res.status).toBe(202);
  const { job } = (await res.json()) as { job: string };
  for (let i = 0; i < 20 && (await runDurableObjectAlarm(v.stub)); i++);
  return { user, cookie, v, job };
}

const urlRe = /\/app\/files\/main\/[a-z0-9]{12}/;

describe("archive files become attachments", () => {
  it("stores images and documents (odd names too) and rewrites every link form", async () => {
    const note = [
      "---",
      "title: Trip report",
      "---",
      "# Trip report",
      "",
      "Embedded: ![[photo (1).png]] and sized ![[photo (1).png|300]]",
      "A wiki link to a file: [[Plans v2.pdf]] and an aliased one [[Plans v2.pdf|the plan]]",
      "Markdown image: ![the map](<../assets/Ünïcode map.png>) and encoded ![](../assets/%C3%9Cn%C3%AFcode%20map.png)",
      "A document: [budget](<../files/budget #3.pdf>)",
      "Unknown stays: ![[missing.png]] [x](nowhere.pdf) [web](https://example.com/a.pdf)",
      "`![[photo (1).png]]` in code stays",
      "```",
      "![[photo (1).png]]",
      "```",
      "Notes link: [[Other note]]",
    ].join("\n");
    const zip = zipSync({
      "vault/trips/Trip report.md": strToU8(note),
      "vault/trips/photo (1).png": PNG,
      "vault/assets/Ünïcode map.png": PNG.slice().reverse().reverse(), // same bytes: deduplicated
      "vault/docs/Plans v2.pdf": PDF,
      "vault/files/budget #3.pdf": strToU8("%PDF-1.4\nbudget\n%%EOF\n"),
      "vault/empty.bin": new Uint8Array(0),
    });
    const { v, job } = await importZip(zip);
    const st = await v.stub.importStatus(v.ref, job);
    expect(st?.counts).toMatchObject({ imported: 1, attached: 4, skipped: 1 });
    expect(st?.skipped.find((s) => s.path === "empty.bin")?.message).toMatch(/attachment: empty file/);
    const read = await v.stub.readNote(v.ref, { identifier: "trips/trip-report" });
    if (!read.ok) throw new Error(read.message);
    const body = read.value.content ?? "";
    const lines = body.split("\n");
    const line = (start: string) => lines.find((l) => l.startsWith(start)) ?? "";
    expect(line("Embedded:")).toMatch(
      new RegExp(`^Embedded: !\\[photo \\(1\\)\\.png\\]\\(${urlRe.source}\\) and sized !\\[photo \\(1\\)\\.png\\]\\(${urlRe.source}\\)$`),
    );
    expect(line("A wiki link")).toMatch(new RegExp(`\\[Plans v2\\.pdf\\]\\(${urlRe.source}\\) and an aliased one \\[the plan\\]\\(${urlRe.source}\\)$`));
    expect(line("Markdown image")).toMatch(new RegExp(`!\\[the map\\]\\(${urlRe.source}\\) and encoded !\\[Ünïcode map\\.png\\]\\(${urlRe.source}\\)$`));
    expect(line("A document")).toMatch(new RegExp(`\\[budget\\]\\(${urlRe.source}\\)$`));
    expect(line("Unknown stays")).toBe("Unknown stays: ![[missing.png]] [x](nowhere.pdf) [web](https://example.com/a.pdf)");
    expect(line("`![[photo")).toBe("`![[photo (1).png]]` in code stays");
    expect(body).toContain("```\n![[photo (1).png]]\n```");
    expect(line("Notes link")).toBe("Notes link: [[Other note]]");
    // Same bytes stored once: the photo and the map share one attachment.
    const ids = [...body.matchAll(/\/app\/files\/main\/([a-z0-9]{12})/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(3);
    const rows = await env.DB.prepare("SELECT name, mime, source FROM attachments WHERE vault_id = ? ORDER BY name").bind(v.vault.id).all();
    expect(rows.results).toEqual([
      { name: "Plans v2.pdf", mime: "application/pdf", source: "import" },
      { name: "budget _3.pdf", mime: "application/pdf", source: "import" },
      { name: "photo (1).png", mime: "image/png", source: "import" },
    ]);

    // Export writes the files back and points the links at them, relative to each note.
    const out = unzipSync(await buildExportZip(env, v.vault.owner_id, v.vault));
    const exported = strFromU8(out["main/trips/Trip report.md"]);
    expect(exported).toMatch(/!\[photo \(1\)\.png\]\(\.\.\/attachments\/[a-z0-9]{12}-photo%20\(1\)\.png\)/);
    expect(exported).not.toMatch(urlRe);
    expect(Object.keys(out).filter((k) => k.startsWith("main/attachments/")).length).toBe(3);

    // Importing that export again finds the same files (deduplicated) and the same notes (unchanged).
    const again = await upload(
      (await makeUserCookie(v.vault.owner_id)) ?? "",
      zipSync(Object.fromEntries(Object.entries(out).filter(([k]) => k.startsWith("main/")))),
    );
    expect(again.status).toBe(202);
    const j2 = ((await again.json()) as { job: string }).job;
    for (let i = 0; i < 20 && (await runDurableObjectAlarm(v.stub)); i++);
    const st2 = await v.stub.importStatus(v.ref, j2);
    expect(st2?.counts).toMatchObject({ unchanged: 1, attached: 3 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE vault_id = ?").bind(v.vault.id).first<{ n: number }>())?.n).toBe(3);
  });

  it("counts files against the account's storage quota", async () => {
    const { user, cookie } = await makeUser("imp2q");
    await env.DB.prepare("UPDATE users SET bytes_used = ? WHERE id = ?")
      .bind(50 * 1024 * 1024 - 1000, user.id)
      .run();
    const res = await upload(cookie, zipSync({ "n.md": strToU8("hi ![[big.png]]"), "big.png": PNG }));
    expect(res.status).toBe(202);
    const v = await defaultVault(user.id);
    const { job } = (await res.json()) as { job: string };
    for (let i = 0; i < 20 && (await runDurableObjectAlarm(v.stub)); i++);
    const st = await v.stub.importStatus(v.ref, job);
    expect(st?.skipped.find((s) => s.path === "big.png")?.message).toMatch(/attachment: QUOTA/);
  });

  it("rewrites links (pure): relative, root-relative, unique names, aliases", () => {
    const links = attachmentLinks([
      ["a/img.png", { url: "/app/files/p/aaaaaaaaaaaa", name: "img.png", inline: true }],
      ["b/img.png", { url: "/app/files/p/bbbbbbbbbbbb", name: "img.png", inline: true }],
      ["docs/Spec.PDF", { url: "/app/files/p/cccccccccccc", name: "Spec.PDF", inline: false }],
    ]);
    expect(rewriteAttachmentLinks("![[img.png]]", "a", links)).toBe("![img.png](/app/files/p/aaaaaaaaaaaa)"); // relative to the note first
    expect(rewriteAttachmentLinks("![[img.png]]", "c", links)).toBe("![[img.png]]"); // elsewhere the name is ambiguous
    expect(rewriteAttachmentLinks("![](img.png)", "a", links)).toBe("![img.png](/app/files/p/aaaaaaaaaaaa)");
    expect(rewriteAttachmentLinks("![x](b/img.png)", "", links)).toBe("![x](/app/files/p/bbbbbbbbbbbb)");
    expect(rewriteAttachmentLinks("![[spec.pdf]]", "z", links)).toBe("[spec.pdf](/app/files/p/cccccccccccc)");
    expect(rewriteAttachmentLinks("![](a/img%20(1).png) ![](a/img.png)", "", links)).toBe(
      "![img%20(1).png](a/img%20(1).png) ![img.png](/app/files/p/aaaaaaaaaaaa)".replace("![img%20(1).png](a/img%20(1).png)", "![](a/img%20(1).png)"),
    );
    expect(rewriteAttachmentLinks("[[docs/Spec.PDF#page=2|the spec]]", "", links)).toBe("[the spec](/app/files/p/cccccccccccc)");
    expect(rewriteAttachmentLinks("![[img.png]]", "", links)).toBe("![[img.png]]");
  });
});

async function makeUserCookie(_ownerId: string): Promise<string | null> {
  // Re-sign the same user in (a fresh session) for the second upload.
  const { createSession } = await import("../src/directory");
  return `__Host-cairn_session=${await createSession(env, _ownerId)}`;
}

describe("frontmatter edits keep the rest of the block byte for byte", () => {
  const md = `---
# kept: a comment
title: "Quoted Title"   # and a trailing one
type: note
tags: [a, b]
custom: 'single'
nested:
  x: 1
---
# Body
`;
  it("changes only the keys that change", () => {
    const fm = splitFrontmatter(md).data;
    expect(setFrontmatter(md, fm)).toBe(md);
    const out = setFrontmatter(md, { ...fm, status: "active", custom: "changed" });
    expect(out).toBe(`---
# kept: a comment
title: "Quoted Title"   # and a trailing one
type: note
tags: [a, b]
custom: changed
nested:
  x: 1
status: active
---
# Body
`);
    const { custom: _c, ...rest } = fm;
    expect(setFrontmatter(md, rest)).not.toContain("custom");
    expect(setFrontmatter(md, rest)).toContain('title: "Quoted Title"   # and a trailing one');
    const noTitle = "---\nfoo: 1 # x\n---\nbody";
    expect(setFrontmatter(noTitle, { foo: 1, title: "T" })).toBe("---\ntitle: T\nfoo: 1 # x\n---\nbody");
    expect(setFrontmatter("plain body", { title: "T" })).toBe("---\ntitle: T\n---\nplain body");
  });

  it("over MCP: bm_edit set_metadata and bm_write leave untouched frontmatter alone", async () => {
    const { user } = await makeUser("imp2fm");
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { identifier: "notes/kept.md", content: md });
    const before = await v.stub.readNote(v.ref, { identifier: "notes/kept.md" });
    expect(before.ok && before.value.content).toBe(md);
    await mcp(pat, "tools/call", { name: "edit_note", arguments: { identifier: "notes/kept.md", command: "set_metadata", metadata: { status: "done" } } });
    const after = await v.stub.readNote(v.ref, { identifier: "notes/kept.md" });
    expect(after.ok && after.value.content).toBe(md.replace("  x: 1\n---", "  x: 1\nstatus: done\n---"));
    await mcp(pat, "tools/call", { name: "edit_note", arguments: { identifier: "notes/kept.md", command: "append", content: "more" } });
    const appended = await v.stub.readNote(v.ref, { identifier: "notes/kept.md" });
    expect(appended.ok && appended.value.content?.startsWith('---\n# kept: a comment\ntitle: "Quoted Title"   # and a trailing one\n')).toBe(true);
  });
});
