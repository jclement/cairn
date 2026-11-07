// Files: Cairn reads attachments' text (PDF pages, text in images, text files), keeps it with the
// notes that link the file (searchable, labelled with the page), hands the original back through a
// signed link, and takes large files through one-time upload URLs. Fake AI (CAIRN_FAKE_CAPTURE_AI):
// a "PDF" is "%PDF-1.4\n" + pages separated by form feeds; an image's "visible text" is the
// printable runs inside its bytes. Synthetic names only.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { composeText, extractAttachment, pagesOf, runExtractionQueue, splitPages } from "../src/capture/extract";
import { putAttachment } from "../src/capture/files";
import { resolveSignedLink, signedFileUrl } from "../src/capture/links";
import { createPat, createVault } from "../src/directory";
import { caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { callTool, fetchWorker } from "./oauth";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = (...pages: string[]) => enc(`%PDF-1.4\n${pages.join("\f")}`);
const png = (visible: string) => new Uint8Array([...PNG, ...enc(`\n${visible}\n`)]);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const text = (r: { content: { text: string }[] }) => r.content[0].text;
const idOf = (t: string) => /\/app\/files\/[^/\s]+\/([a-z0-9]{12})/.exec(t)?.[1] as string;
const row = (id: string) => env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first<Record<string, unknown>>();
const usedBytes = async (userId: string) =>
  (await env.DB.prepare("SELECT bytes_used FROM users WHERE id = ?").bind(userId).first<{ bytes_used: number }>())?.bytes_used ?? 0;
const fileSources = (stub: ReturnType<typeof env.VAULT.getByName>) =>
  runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec<{ note_id: number; attachment_id: string; label: string; text: string; bytes: number }>(
        "SELECT note_id, attachment_id, label, text, bytes FROM note_sources WHERE attachment_id IS NOT NULL",
      )
      .toArray(),
  );

async function rw(prefix = "files") {
  const u = await makeUser(prefix);
  const pat = await createPat(env, u.user.id, "t", ["memory:read", "memory:write"], null);
  return { ...u, pat, ...(await defaultVault(u.user.id)) };
}

async function addMember(vaultId: string, userId: string, role: "reader" | "editor", by: string) {
  await env.DB.prepare("INSERT INTO vault_members (vault_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)")
    .bind(vaultId, userId, role, by, new Date().toISOString())
    .run();
}

// ---------------------------------------------------------------- pure parts

describe("page parsing", () => {
  it("splits toMarkdown-style output by Page headings and drops the metadata", () => {
    const r = splitPages("# a.pdf\n\n## Metadata\n- Title=x\n\n## Contents\n### Page 1\nalpha\n\n### Page 2\nbeta");
    expect(r.pages).toEqual(["alpha", "beta"]);
  });
  it("splits by form feeds and page comments; no markers = one block", () => {
    expect(splitPages("one\ftwo\fthree").pages).toEqual(["one", "two", "three"]);
    expect(splitPages("<!-- page 1 -->\nx\n<!-- page 2 -->\ny").pages).toEqual(["x", "y"]);
    expect(splitPages("just text\nno pages").pages).toBeNull();
  });
  it("composes markers, labels and cuts at the page cap", () => {
    const pages = Array.from({ length: 205 }, (_, i) => `page text number ${i + 1}`);
    const c = composeText("big.pdf", "pdf", { text: "", pages, totalPages: 205 });
    expect(c.pages).toBe(200);
    expect(c.cut).toBe(true);
    expect(c.label).toBe("from big.pdf, pages 1–200 of 205 (cut)");
    expect(c.text).toContain("<!-- page 200 -->");
    expect(c.text).not.toContain("<!-- page 201 -->");
    expect(pagesOf(c.text, "3")?.text).toBe("<!-- page 3 -->\npage text number 3");
    expect(pagesOf(c.text, "2-3")?.from).toBe(2);
    expect(pagesOf(c.text, "999")).toBeNull();
  });
});

// ---------------------------------------------------------------- reading

describe("reading files", () => {
  it("a PDF with pages becomes the note's original text with page markers; search cites the page", async () => {
    const { pat, stub } = await rw();
    const r = await callTool(pat, "attach_file", {
      data_base64: b64(pdf("Quarterly report for Fernwood Labs", "The total due is 1240 dollars for the zephyrine contract")),
      filename: "report.pdf",
      title: "Fernwood report",
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/saved main\/fernwood-report rev/);
    expect(text(r)).toMatch(/text: read \(2 pages\), \d+ KB, searchable; kept with fernwood-report/);
    const src = await fileSources(stub);
    expect(src).toHaveLength(1);
    expect(src[0].label).toBe("from report.pdf, pages 1–2");
    expect(src[0].text).toContain("<!-- page 2 -->\nThe total due is 1240");
    expect(src[0].bytes).toBe(0); // charged with the file, not twice
    const s = text(await callTool(pat, "search_notes", { query: "zephyrine", mode: "text" }));
    expect(s).toContain("Fernwood report");
    expect(s).toMatch(/matched in the original text, \d{4}-\d\d-\d\d \(from report\.pdf, pages 1–2\): p\. 2: The total due is 1240/);
    const js = JSON.parse(text(await callTool(pat, "search_notes", { query: "zephyrine", mode: "text", output_format: "json" })));
    const hit = js.results?.[0] ?? js.hits?.[0];
    expect(hit.source_match.page).toBe(2);
    expect(hit.source_match.file).toBe(idOf(text(r)));
  });

  it("an image's visible text and description are read; read_note file= quotes it", async () => {
    const { pat } = await rw();
    const r = await callTool(pat, "attach_file", {
      data_base64: b64(png("Whiteboard: launch plan for Bramblecot")),
      filename: "board.png",
      title: "Board photo",
    });
    expect(text(r)).toMatch(/text: read, \d+ KB, searchable/);
    const id = idOf(text(r));
    const f = text(await callTool(pat, "read_note", { file: id }));
    expect(f).toContain("# board.png");
    expect(f).toContain("Whiteboard: launch plan for Bramblecot");
    expect(f).toContain("## Description");
    expect(f).toMatch(/download for the user \(no sign-in; valid until .+\): http:\/\/localhost:8787\/files\/s\//);
    // By name, through the note.
    expect(text(await callTool(pat, "read_note", { identifier: "board-photo", file: "board.png" }))).toContain("launch plan for Bramblecot");
    expect(text(await callTool(pat, "search_notes", { query: "Bramblecot", mode: "text" }))).toContain("Board photo");
  });

  it("a PDF without a text layer is 'none', said in the receipt", async () => {
    const { pat } = await rw();
    const r = await callTool(pat, "attach_file", { data_base64: b64(enc("%PDF-1.4\n")), filename: "scan.pdf", title: "Scan" });
    expect(text(r)).toMatch(/text: none \(no text layer \(a scanned PDF\?\)/);
    expect((await row(idOf(text(r))))?.extract_state).toBe("none");
  });

  it("secrets in a file's text are redacted", async () => {
    const { pat, stub } = await rw();
    await callTool(pat, "attach_file", {
      data_base64: b64(pdf("Router setup notes for the office", "the wifi password: hunter2-correct and more words")),
      filename: "setup.pdf",
      title: "Setup",
    });
    const src = await fileSources(stub);
    expect(src[0].text).toContain("[redacted]");
    expect(src[0].text).not.toContain("hunter2");
  });

  it("a failed read is visible and can be read again", async () => {
    const { pat, vault, user, cookie } = await rw();
    const r = await callTool(pat, "attach_file", { data_base64: b64(pdf("some words that are long enough")), filename: "fail-extract.pdf", title: "Broken" });
    expect(text(r)).toMatch(/text: failed \(injected failure\)/);
    const id = idOf(text(r));
    expect((await row(id))?.extract_error).toBe("injected failure");
    // The note page shows it with a re-read button.
    const page = await (await fetchWorker("/app/v/main/n/broken", { headers: { cookie } })).text();
    expect(page).toContain('data-extract="failed"');
    expect(page).toContain("Read text again");
    const again = await fetchWorker("/app/files/extract", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ project: vault.name, id, back: "/app/v/main/n/broken" }),
    });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/app/v/main/n/broken");
    expect(["pending", "failed"]).toContain((await row(id))?.extract_state); // re-queued (and failed again: same name)
    void user;
  });

  it("budget exhausted: the file is stored, text pending until the next day, then the queue reads it", async () => {
    const { user, vault, stub, ref } = await rw();
    await stub.writeNote(ref, caller(user), { title: "Budget note", content: "Holds a file.\n" });
    const put = await putAttachment(env, vault, { bytes: pdf("Ledger for the Quillmere account with enough words"), name: "ledger.pdf", source: "mcp" });
    if (!put.ok) throw new Error(put.message);
    await stub.editNote(ref, caller(user), { identifier: "budget-note", command: "append", content: `\n${put.markdown}\n` });
    const poor = { ...env, AI_DAILY_TOKENS: "1" };
    const o = await extractAttachment(poor, vault, put.attachment.id);
    expect(o.state).toBe("pending");
    expect(o.error).toMatch(/daily AI budget/);
    const r1 = await row(put.attachment.id);
    expect(r1?.extract_state).toBe("pending");
    expect(String(r1?.extract_after) > new Date().toISOString()).toBe(true);
    expect(r1?.extract_tries).toBe(0);
    // Not due yet: the queue leaves it.
    await runExtractionQueue(env, { vaultId: vault.id });
    expect((await row(put.attachment.id))?.extract_state).toBe("pending");
    // The next day.
    await env.DB.prepare("UPDATE attachments SET extract_after = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), put.attachment.id)
      .run();
    const q = await runExtractionQueue(env, { vaultId: vault.id });
    expect(q.outcomes.done).toBe(1);
    expect((await fileSources(stub))[0].text).toContain("Quillmere");
  });

  it("a note that links a file after its text was read gets the text; deleting the file takes it out and releases its bytes", async () => {
    const { user, vault, stub, ref, cookie } = await rw();
    const before = await usedBytes(user.id);
    const put = await putAttachment(env, vault, { bytes: enc("Plain text notes about the Larkspur migration plan"), name: "plan.txt", source: "upload" });
    if (!put.ok) throw new Error(put.message);
    const o = await extractAttachment(env, vault, put.attachment.id);
    expect(o.state).toBe("done");
    expect(o.notes).toEqual([]);
    const charged = await usedBytes(user.id);
    expect(charged - before).toBe(put.attachment.bytes + 2048 + (o.bytes ?? 0));
    await stub.writeNote(ref, caller(user), { title: "Later", content: `See ${put.markdown}\n` });
    expect((await fileSources(stub)).map((x) => x.attachment_id)).toEqual([put.attachment.id]);
    const pat = await createPat(env, user.id, "t2", ["memory:read"], null);
    expect(text(await callTool(pat, "search_notes", { query: "Larkspur", mode: "text" }))).toContain("Later");
    // Delete the file: its bytes and its text's bytes come back.
    const beforeDelete = await usedBytes(user.id);
    const del = await fetchWorker("/app/api/files/delete", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ project: vault.name, id: put.attachment.id }),
    });
    expect(del.status).toBe(200);
    expect(await fileSources(stub)).toEqual([]);
    expect(beforeDelete - (await usedBytes(user.id))).toBe(put.attachment.bytes + 2048 + (o.bytes ?? 0));
    expect(await env.DB.prepare("SELECT 1 FROM attachment_texts WHERE attachment_id = ?").bind(put.attachment.id).first()).toBeNull();
    expect(text(await callTool(pat, "search_notes", { query: "Larkspur", mode: "text" }))).not.toContain("Later");
  });

  it("a note in another project linking a file id never gets that file's text", async () => {
    const a = await rw();
    const b = await rw();
    const put = await putAttachment(env, a.vault, { bytes: enc("Confidential roadmap for Thistledown"), name: "secret.txt", source: "upload" });
    if (!put.ok) throw new Error(put.message);
    await extractAttachment(env, a.vault, put.attachment.id);
    await b.stub.writeNote(b.ref, caller(b.user), { title: "Sneaky", content: `[x](/app/files/main/${put.attachment.id})\n` });
    expect(await fileSources(b.stub)).toEqual([]);
    const r = await callTool(b.pat, "read_note", { file: put.attachment.id });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^NOT_FOUND/);
  });

  it("notes without files read and search exactly as before (no file keys)", async () => {
    const { pat, user, stub, ref } = await rw();
    await stub.writeNote(ref, caller(user), { title: "Plain", content: "Mentions the word heliotrope.\n", source_text: "said heliotrope" });
    const js = JSON.parse(text(await callTool(pat, "search_notes", { query: "heliotrope", mode: "text", output_format: "json" })));
    const hit = js.results?.[0] ?? js.hits?.[0];
    expect(hit.source_match ? Object.keys(hit.source_match).sort() : []).not.toContain("file");
    const read = text(await callTool(pat, "read_note", { identifier: "plain" }));
    expect(read).not.toContain("attachments");
    expect(read).not.toContain("file=");
  });
});

// ---------------------------------------------------------------- attach_file

describe("attach_file", () => {
  it("inline base64 is capped at 2 MB (pointing at upload=true)", async () => {
    const { pat } = await rw();
    const r = await callTool(pat, "attach_file", { data_base64: "A".repeat(3 * 1024 * 1024), filename: "big.bin" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/TOO_LARGE: Inline files are at most 2 MB: call attach_file upload=true/);
  });

  it("upload URL: PUT once, finish with ref once; links into the note and reads the text", async () => {
    const { pat, user } = await rw();
    await callTool(pat, "write_note", { title: "Uploads", content: "Files:\n" });
    const t = text(await callTool(pat, "attach_file", { upload: true, filename: "deck.pdf", note: "uploads" }));
    const url = /upload_url: (\S+)/.exec(t)?.[1] as string;
    const ref = /ref: (\S+)/.exec(t)?.[1] as string;
    expect(url).toMatch(/^http:\/\/localhost:8787\/files\/upload\/[A-Za-z0-9_-]{43}$/);
    // Not uploaded yet.
    expect(text(await callTool(pat, "attach_file", { ref }))).toMatch(/hasn't arrived yet/);
    const path = new URL(url).pathname;
    const put = await fetchWorker(path, { method: "PUT", body: pdf("Pitch deck for the Moonwort fund raise round") });
    expect(put.status).toBe(201);
    expect((await put.json()) as Record<string, unknown>).toMatchObject({ ok: true, ref, name: "deck.pdf" });
    // Single use.
    expect((await fetchWorker(path, { method: "PUT", body: enc("again") })).status).toBe(404);
    const fin = await callTool(pat, "attach_file", { ref });
    expect(fin.isError).toBeFalsy();
    expect(text(fin)).toMatch(/attached deck\.pdf \(application\/pdf/);
    expect(text(fin)).toMatch(/updated main\/uploads rev|saved main\/uploads rev/);
    expect(text(fin)).toMatch(/text: read \(1 page\)/);
    expect(text(await callTool(pat, "attach_file", { ref }))).toMatch(/already finished/);
    expect(text(await callTool(pat, "search_notes", { query: "Moonwort", mode: "text" }))).toContain("Uploads");
    void user;
  });

  it("upload URL: expired and oversize uploads are refused; another project's ref is not found", async () => {
    const { pat, user } = await rw();
    const t1 = text(await callTool(pat, "attach_file", { upload: true, filename: "a.txt" }));
    const p1 = new URL(/upload_url: (\S+)/.exec(t1)?.[1] as string).pathname;
    const ref1 = /ref: (\S+)/.exec(t1)?.[1] as string;
    await env.DB.prepare("UPDATE upload_tickets SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), ref1)
      .run();
    expect((await fetchWorker(p1, { method: "PUT", body: enc("late") })).status).toBe(404);
    expect(text(await callTool(pat, "attach_file", { ref: ref1 }))).toMatch(/expired/);

    const t2 = text(await callTool(pat, "attach_file", { upload: true, filename: "b.txt" }));
    const p2 = new URL(/upload_url: (\S+)/.exec(t2)?.[1] as string).pathname;
    const ref2 = /ref: (\S+)/.exec(t2)?.[1] as string;
    await env.DB.prepare("UPDATE upload_tickets SET max_bytes = 10 WHERE id = ?").bind(ref2).run();
    expect((await fetchWorker(p2, { method: "PUT", body: enc("this body is more than ten bytes") })).status).toBe(413);
    expect(text(await callTool(pat, "attach_file", { ref: ref2 }))).toMatch(/failed/);

    const other = await createVault(env, user.id, "other");
    if (!other.ok) throw new Error(other.message);
    const t3 = text(await callTool(pat, "attach_file", { upload: true, filename: "c.txt" }));
    const p3 = new URL(/upload_url: (\S+)/.exec(t3)?.[1] as string).pathname;
    const ref3 = /ref: (\S+)/.exec(t3)?.[1] as string;
    expect((await fetchWorker(p3, { method: "PUT", body: enc("plain text file body") })).status).toBe(201);
    const wrong = await callTool(pat, "attach_file", { ref: ref3, project: "other" });
    expect(text(wrong)).toMatch(/^NOT_FOUND/);
    // Another user's token can't finish it either.
    const b = await rw();
    expect(text(await callTool(b.pat, "attach_file", { ref: ref3 }))).toMatch(/^NOT_FOUND/);
    expect((await callTool(pat, "attach_file", { ref: ref3 })).isError).toBeFalsy();
  });

  it("a reader of a shared project can't attach or get an upload URL; an editor can", async () => {
    const owner = await rw("owner");
    const reader = await rw("reader");
    const editor = await rw("editor");
    const team = await createVault(env, owner.user.id, "team");
    if (!team.ok) throw new Error(team.message);
    await addMember(team.vault.id, reader.user.id, "reader", owner.user.id);
    await addMember(team.vault.id, editor.user.id, "editor", owner.user.id);
    const project = `${owner.user.username}/team`;
    const r1 = await callTool(reader.pat, "attach_file", { upload: true, filename: "x.txt", project });
    expect(r1.isError).toBe(true);
    expect(text(r1)).toMatch(/^FORBIDDEN/);
    const r2 = await callTool(reader.pat, "attach_file", { data_base64: b64(enc("hello there reader")), filename: "x.txt", project });
    expect(r2.isError).toBe(true);
    const r3 = await callTool(editor.pat, "attach_file", {
      data_base64: b64(enc("Notes from the Wrenfield offsite meeting")),
      filename: "e.txt",
      title: "Offsite",
      project,
    });
    expect(r3.isError).toBeFalsy();
    expect(text(r3)).toMatch(/text: read/);
    // The reader may read it, and get a link.
    const id = idOf(text(r3));
    expect(text(await callTool(reader.pat, "read_note", { file: id, project }))).toContain("Wrenfield");
  });
});

// ---------------------------------------------------------------- signed links

describe("signed download links", () => {
  it("work without sign-in, expire, can't be bent to another file or project, and die with the file", async () => {
    const a = await rw();
    const b = await rw();
    const r = text(
      await callTool(a.pat, "attach_file", { data_base64: b64(pdf("Contract terms for the Gorsebrook lease")), filename: "lease.pdf", title: "Lease" }),
    );
    const id = idOf(r);
    const f = text(await callTool(a.pat, "read_note", { file: id }));
    const link = /(http:\/\/localhost:8787\/files\/s\/\S+)/.exec(f)?.[1] as string;
    const path = new URL(link).pathname;
    const got = await fetchWorker(path);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("private, no-store");
    expect(got.headers.get("content-disposition")).toContain("lease.pdf");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(pdf("Contract terms for the Gorsebrook lease"));
    // Tampered signature.
    expect((await fetchWorker(`${path.slice(0, -2)}xx`)).status).toBe(404);
    // Expired.
    const old = await signedFileUrl(env, a.vault.id, id, 60, Date.now() - 3600e3);
    expect((await fetchWorker(new URL(old.url).pathname)).status).toBe(404);
    // A valid signature naming A's file in B's project, or B's id in A's project: nothing.
    const cross = await signedFileUrl(env, b.vault.id, id);
    expect(await resolveSignedLink(env, new URL(cross.url).pathname.split("/").pop() as string)).toBeNull();
    expect((await fetchWorker(new URL(cross.url).pathname)).status).toBe(404);
    // Deleted file: dead link.
    await fetchWorker("/app/api/files/delete", {
      method: "POST",
      headers: { cookie: a.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ project: a.vault.name, id }),
    });
    expect((await fetchWorker(path)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- backfill and viewer

describe("backfill and the Files page", () => {
  it("the owner queues old files; the queue reads them; a member can't backfill", async () => {
    const { user, vault, cookie, stub, ref } = await rw();
    const put = await putAttachment(env, vault, { bytes: pdf("Archived minutes of the Pennyroyal committee"), name: "minutes.pdf", source: "upload" });
    const put2 = await putAttachment(env, vault, { bytes: enc("PK\u0003\u0004zipdata"), name: "x.zip", source: "upload" });
    if (!put.ok || !put2.ok) throw new Error("put");
    await stub.writeNote(ref, caller(user), { title: "Minutes", content: `${put.markdown}\n` });
    // As if stored before this feature.
    await env.DB.prepare("UPDATE attachments SET extract_state = NULL, extract_error = NULL WHERE vault_id = ?").bind(vault.id).run();
    const files = await (await fetchWorker(`/app/files?project=${vault.name}`, { headers: { cookie } })).text();
    expect(files).toContain("Read their text");

    const member = await makeUser("member");
    await addMember(vault.id, member.user.id, "editor", user.id);
    const denied = await fetchWorker("/app/files/backfill", {
      method: "POST",
      headers: { cookie: member.cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ project: `${user.username}/${vault.name}` }),
    });
    expect(denied.status).toBe(303);
    expect((await row(put.attachment.id))?.extract_state).toBeNull();

    const ok = await fetchWorker("/app/files/backfill", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ project: vault.name }),
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toContain("queued=1");
    expect((await row(put2.attachment.id))?.extract_state).toBe("none");
    // The backfill's first batch runs after the response (it may hold the file's lease): wait for it.
    for (let i = 0; i < 50 && (await row(put.attachment.id))?.extract_state !== "done"; i++) {
      await runExtractionQueue(env, { vaultId: vault.id });
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await row(put.attachment.id))?.extract_state).toBe("done");
    expect((await fileSources(stub))[0].text).toContain("Pennyroyal");
    const after = await (await fetchWorker(`/app/files?project=${vault.name}`, { headers: { cookie } })).text();
    expect(after).not.toContain("Read their text");
    expect(after).toContain('data-extract="done"');
    // The note page: status, and the text behind a toggle.
    const note = await (await fetchWorker("/app/v/main/n/minutes", { headers: { cookie } })).text();
    expect(note).toContain("View extracted text");
    expect(note).toContain("Pennyroyal");
    expect(note).not.toContain(">Original text <");
  });

  it("an export carries the file, not its text as a .sources.md", async () => {
    const { pat, user } = await rw();
    await callTool(pat, "attach_file", { data_base64: b64(enc("Inventory list for the Hollowmere depot")), filename: "inv.txt", title: "Inventory" });
    const { buildExportZip } = await import("../src/web/export");
    const { unzipSync } = await import("fflate");
    const zip = unzipSync(await buildExportZip(env, user.id));
    expect(Object.keys(zip).some((k) => k.endsWith(".sources.md"))).toBe(false);
    expect(Object.keys(zip).some((k) => k.includes("attachments/") && k.endsWith("inv.txt"))).toBe(true);
  });
});
