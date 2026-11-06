// Recall: a note keeps the original words it was written from (note_sources), and every question
// the notes didn't answer is logged as a miss (D1 misses). Synthetic names only.
import { env, runInDurableObject } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { deleteAccount } from "../src/account";
import { createPat, createVault, listOwnedVaults } from "../src/directory";
import { clearMisses, listMisses, MISS_ROWS_PER_HOUR, pruneMisses, recordMiss } from "../src/misses";
import { REDACTED, redactSecrets } from "../src/secrets";
import { prepareSource, SOURCE_MAX_BYTES } from "../src/vault/do";
import { buildExportZip } from "../src/web/export";
import { caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { callTool, fetchWorker } from "./oauth";

/** Make `userId` a member of a project (what redeeming a share link does). */
async function addMember(e: typeof env, vaultId: string, userId: string, role: "reader" | "editor", by: string) {
  await e.DB.prepare("INSERT INTO vault_members (vault_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)")
    .bind(vaultId, userId, role, by, new Date().toISOString())
    .run();
  return { ok: true as const, message: "" };
}

const text = (r: { content: { text: string }[] }) => r.content[0].text;
const sourceRows = (stub: ReturnType<typeof env.VAULT.getByName>) =>
  runInDurableObject(stub, (_i, state) => state.storage.sql.exec("SELECT note_id, label, text, bytes FROM note_sources ORDER BY id").toArray());
const sourceChunks = (stub: ReturnType<typeof env.VAULT.getByName>) =>
  runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'source'").one().n);
const missRows = async (userId: string) =>
  (await env.DB.prepare("SELECT * FROM misses WHERE user_id = ? ORDER BY id").bind(userId).all<Record<string, unknown>>()).results;

// ---------------------------------------------------------------- secrets

describe("redactSecrets", () => {
  const cases: [string, string][] = [
    ["api key", "my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx and more"],
    ["openai key", "sk-proj-ABCDEFGHIJKLMNOPqrstuv1234"],
    ["stripe", "use sk_live_51HabcdefGHIJKLmnop to charge"],
    ["github classic", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github fine-grained", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
    ["aws", "AKIAIOSFODNN7EXAMPLE is the access key id"],
    ["slack", "xoxb-1234567890-abcdefghijkl"],
    ["google", "AIzaSyA1234567890abcdefghijklmnopqrstu"],
    ["jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U here"],
    ["pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----"],
    ["password assignment", "the wifi password: hunter2-correct"],
    ["token assignment", "curl ...?token=abc123def456"],
    ["api_key assignment", 'API_KEY = "s3cr3t-value"'],
    ["bearer", "Authorization: Bearer abcdefghijklmnop.qrstuvwx"],
    ["high entropy", "the value is Zx8Qp2Lm9Vt4Rw7Ky1Hn6Bc3Fd5Gs0Jq9Wt2Xe for that"],
  ];
  for (const [name, input] of cases) {
    it(`redacts ${name}`, () => {
      const r = redactSecrets(input);
      expect(r.count, `${name}: ${r.text}`).toBeGreaterThan(0);
      expect(r.text).toContain(REDACTED);
      expect(r.kinds.length).toBeGreaterThan(0);
    });
  }
  it("keeps the name of an assigned secret, and the words around it", () => {
    expect(redactSecrets("the wifi password: hunter2 for the office").text).toBe("the wifi password: [redacted] for the office");
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE").text).toBe(REDACTED);
  });
  it("leaves ordinary text alone (same string back)", () => {
    const ordinary = [
      "Dana Whitlow said Northwind's renewal is due 2026-12-01; budget $40k, call her at 555-0100.",
      "checksum 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 and uuid 3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "https://example.com/docs/getting-started/installation-guide-for-new-users",
      "We need a password manager; the token budget is 4000 per call.",
      "password: required",
      "Internationalization and localization are long words",
    ];
    for (const s of ordinary) {
      const r = redactSecrets(s);
      expect(r.count, `${s} -> ${r.text}`).toBe(0);
      expect(r.text).toBe(s);
    }
  });
});

describe("prepareSource", () => {
  it("cuts a long original at the cap and says so", () => {
    const long = "Dana Whitlow said the plan is fine.\n".repeat(2000);
    const p = prepareSource(long, "Dana in chat");
    expect(p.cut).toBe(true);
    expect(new TextEncoder().encode(p.text).length).toBeLessThanOrEqual(SOURCE_MAX_BYTES);
    expect(p.text).toMatch(/\[… cut: the original was \d+ KB; Cairn keeps 20 KB\]$/);
    expect(p.label).toBe("Dana in chat");
    expect(prepareSource("short").cut).toBe(false);
  });
});

// ---------------------------------------------------------------- original text

describe("note sources", () => {
  it("keeps the original words beside the note, not in it; edits, moves keep them; delete removes them", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const w = await v.stub.writeNote(v.ref, caller(user), {
      title: "Northwind renewal",
      content: "Renewal is due in December.",
      source_text: "Dana Whitlow: the Northwind renewal is due Dec 1, and they want the teal invoices.",
      source_label: "Dana in chat",
    });
    if (!w.ok) throw new Error(w.message);
    expect(w.value.source).toMatchObject({ kept: true, redactions: 0, cut: false });
    // The body is the summary only.
    const read = await v.stub.readNote(v.ref, { identifier: "northwind-renewal" });
    if (!read.ok) throw new Error(read.message);
    expect(read.value.content).not.toContain("teal");
    expect(read.value.source_count).toBe(1);
    expect(read.value.sources).toBeUndefined();
    const full = await v.stub.readNote(v.ref, { identifier: "northwind-renewal", sources: true });
    if (!full.ok) throw new Error(full.message);
    expect(full.value.sources?.[0]).toMatchObject({ label: "Dana in chat", text: expect.stringContaining("teal invoices"), client: "test-client" });

    // A second source via edit_note append: newest first.
    const e = await v.stub.editNote(v.ref, caller(user), {
      identifier: "northwind-renewal",
      command: "append",
      content: "- [decision] Invoice colour agreed",
      source_text: "Dana again: teal it is, and cc the finance alias.",
    });
    if (!e.ok) throw new Error(e.message);
    const two = await v.stub.readNote(v.ref, { identifier: "northwind-renewal", sources: true });
    if (!two.ok) throw new Error(two.message);
    expect(two.value.sources?.map((s) => s.text.slice(0, 10))).toEqual(["Dana again", "Dana Whitl"]);

    // Rewriting the body (no source) keeps the sources and their search chunks.
    const chunksBefore = await sourceChunks(v.stub);
    expect(chunksBefore).toBeGreaterThan(0);
    const ow = await v.stub.writeNote(v.ref, caller(user), { identifier: "northwind-renewal", content: "Rewritten summary.", overwrite: true });
    if (!ow.ok) throw new Error(ow.message);
    expect((await sourceRows(v.stub)).length).toBe(2);
    expect(await sourceChunks(v.stub)).toBe(chunksBefore);

    // Move keeps them (same note).
    const mv = await v.stub.moveNote(v.ref, caller(user), { identifier: "northwind-renewal", destination: "customers/" });
    if (!mv.ok) throw new Error(mv.message);
    const moved = await v.stub.readNote(v.ref, { identifier: "northwind-renewal" });
    expect(moved.ok && moved.value.source_count).toBe(2);

    // Delete takes them, their search rows and chunks with it.
    const d = await v.stub.deleteNote(v.ref, caller(user), { identifier: "northwind-renewal" });
    if (!d.ok) throw new Error(d.message);
    expect(await sourceRows(v.stub)).toEqual([]);
    expect(await sourceChunks(v.stub)).toBe(0);
    const fts = await runInDurableObject(v.stub, (_i, s) => s.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sources_fts").one().n);
    expect(fts).toBe(0);
  });

  it("charges the original text to the storage quota, and releases it on delete", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const plain = await v.stub.writeNote(v.ref, caller(user), { title: "A", content: "same body" });
    const withSrc = await v.stub.writeNote(v.ref, caller(user), { title: "B", content: "same body", source_text: "x".repeat(5000) });
    if (!plain.ok || !withSrc.ok) throw new Error("write failed");
    const rows = (await sourceRows(v.stub)) as { bytes: number }[];
    expect(rows[0].bytes).toBeGreaterThan(5000);
    const charged = async () =>
      (await env.DB.prepare("SELECT bytes_used FROM users WHERE id = ?").bind(user.id).first<{ bytes_used: number }>())?.bytes_used ?? 0;
    const before = await charged();
    expect(withSrc.value.totalBytes - plain.value.totalBytes).toBeGreaterThan(5000);
    await v.stub.deleteNote(v.ref, caller(user), { identifier: "b" });
    expect(before - (await charged())).toBeGreaterThan(5000);
  });

  it("finds a note by words only its original text holds, below body matches, and labels it", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Teal decision", content: "We picked teal for the invoices." });
    await v.stub.writeNote(v.ref, caller(user), {
      title: "Call with Dana",
      content: "Discussed the renewal.",
      source_text: "Dana Whitlow: oh and the invoices should be teal, not orange.",
      source_label: "call notes",
    });
    const r = await v.stub.search(v.ref, { query: "teal invoices", mode: "text" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.hits.map((h) => h.permalink)).toEqual(["teal-decision", "call-with-dana"]);
    expect(r.value.hits[0].source_match).toBeUndefined();
    expect(r.value.hits[1].source_match).toMatchObject({ only: true, label: "call notes", line: expect.stringContaining("teal") });

    // Through MCP: the excerpt says where it matched.
    const pat = await createPat(env, user.id, "t", ["memory:read"], null);
    const out = text(await callTool(pat, "search_notes", { query: "orange", mode: "text" }));
    expect(out).toMatch(/matched in the original text, \d{4}-\d\d-\d\d \(call notes\): Dana Whitlow: oh and the invoices should be teal, not orange\./);
    const js = JSON.parse(text(await callTool(pat, "search_notes", { query: "orange", mode: "text", output_format: "json" })));
    expect(js.results[0].source_match.only).toBe(true);
  });

  it("finds it by meaning too (semantic chunks of the original text)", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), {
      title: "Weekly sync",
      content: "Status update.",
      source_text: "The warehouse in Calgary floods every spring, so stock moves upstairs in March.",
    });
    await v.stub.embedPending();
    const r = await v.stub.search(v.ref, { query: "warehouse flooding spring", mode: "semantic" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.hits[0]?.permalink).toBe("weekly-sync");
    expect(r.value.hits[0].source_match?.only).toBe(true);
  });

  it("redacts secrets from the original text and says so in the receipt", async () => {
    const { user } = await makeUser();
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    const out = text(
      await callTool(pat, "write_note", {
        title: "Server setup",
        content: "Set up the staging server.",
        source_text: "ssh in with password: Tr0ub4dor and the deploy key ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        source_label: "Dana in chat",
      }),
    );
    expect(out).toMatch(/original text kept \(\d+ KB; redacted 2 secrets \(github token, password or token\)\)/);
    const v = await defaultVault(user.id);
    const rows = (await sourceRows(v.stub)) as { text: string }[];
    expect(rows[0].text).not.toContain("Tr0ub4dor");
    expect(rows[0].text).not.toContain("ghp_");
    expect(rows[0].text).toContain("password: [redacted]");
    const read = text(await callTool(pat, "read_note", { identifier: "server-setup" }));
    expect(read).toMatch(/\n\nOriginal text: 1 kept \(read_note sources=true\)$/);
    const withSources = text(await callTool(pat, "read_note", { identifier: "server-setup", sources: true }));
    expect(withSources).toContain("## Original text (1 kept, newest first)");
    expect(withSources).toContain("— Dana in chat");
    expect(withSources).toContain("[2 secret(s) redacted]");
  });

  it("leaves default read_note and search_notes output unchanged for notes without sources", async () => {
    const { user } = await makeUser();
    const pat = await createPat(env, user.id, "t", ["memory:read", "memory:write"], null);
    await callTool(pat, "write_note", { title: "Plain note", content: "Northwind ships on Fridays.\n\n- [fact] ships Fridays" });
    const v = await defaultVault(user.id);
    const r = await v.stub.readNote(v.ref, { identifier: "plain-note" });
    if (!r.ok) throw new Error(r.message);
    const n = r.value.note;
    const read = text(await callTool(pat, "read_note", { identifier: "plain-note" }));
    expect(read).toBe(
      `# Plain note\nproject: main | permalink: plain-note | file_path: Plain note.md | type: note | checksum: ${n.checksum}\nupdated ${n.updated_at} by ${n.updated_by_client} | lines 1-${r.value.total_lines} of ${r.value.total_lines}\n\n${r.value.content}`,
    );
    const rj = JSON.parse(text(await callTool(pat, "read_note", { identifier: "plain-note", output_format: "json" })));
    expect("source_count" in rj).toBe(false);
    expect("sources" in rj).toBe(false);
    const s = text(await callTool(pat, "search_notes", { query: "northwind fridays" }));
    expect(s).not.toMatch(/original text/i);
    const sj = JSON.parse(text(await callTool(pat, "search_notes", { query: "northwind fridays", output_format: "json" })));
    expect(sj.results.every((h: Record<string, unknown>) => !("source_match" in h))).toBe(true);
  });

  it("exports the original text beside its note, and an import of that export skips it", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), {
      directory: "people",
      title: "Dana Whitlow",
      content: "Runs finance at Northwind.",
      source_text: "Dana: I run finance at Northwind, ```not``` ops.",
      source_label: "intro email",
    });
    await v.stub.writeNote(v.ref, caller(user), { title: "No source", content: "plain" });
    const zip = unzipSync(await buildExportZip(env, user.id));
    const names = Object.keys(zip);
    expect(names).toContain("main/people/Dana Whitlow.md");
    expect(names).toContain("main/people/Dana Whitlow.sources.md");
    expect(names.some((n) => n.startsWith("main/No source.sources"))).toBe(false);
    const md = strFromU8(zip["main/people/Dana Whitlow.sources.md"]);
    expect(md).toContain("type: cairn-sources");
    expect(md).toContain("— intro email");
    expect(md).toContain("````text\nDana: I run finance at Northwind, ```not``` ops.\n````");

    const { planImport, readNotes } = await import("../src/import");
    const exported = await buildExportZip(env, user.id);
    const items = [...readNotes(exported, planImport(exported), null)];
    const src = items.find((i) => i.path.endsWith("Dana Whitlow.sources.md"));
    expect(src).toMatchObject({ status: "skipped", content: null });
    expect(items.find((i) => i.path.endsWith("Dana Whitlow.md"))?.content).toContain("Runs finance");
  });

  it("shows a collapsed Original text section on the note page", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), {
      title: "Kickoff",
      content: "Summary.",
      source_text: "Dana <b>said</b> kickoff is Monday.",
      source_label: "chat",
    });
    const page = await (await fetchWorker("/app/v/main/n/kickoff", { headers: { cookie } })).text();
    expect(page).toContain('<details class="note-sources');
    expect(page).toContain("Dana &lt;b&gt;said&lt;/b&gt; kickoff is Monday.");
    const plain = await v.stub.writeNote(v.ref, caller(user), { title: "Plain", content: "Summary." });
    expect(plain.ok).toBe(true);
    expect(await (await fetchWorker("/app/v/main/n/plain", { headers: { cookie } })).text()).not.toContain("note-sources");
  });

  it("follows shared-project roles: a reader reads sources, an editor adds them, an outsider sees nothing", async () => {
    const owner = await makeUser("owner");
    const reader = await makeUser("reader");
    const editor = await makeUser("editor");
    const outsider = await makeUser("outsider");
    const pv = await createVault(env, owner.user.id, "team");
    if (!pv.ok) throw new Error(pv.message);
    for (const [u, role] of [
      [reader, "reader"],
      [editor, "editor"],
    ] as const) {
      const r = await addMember(env, pv.vault.id, u.user.id, role, owner.user.id);
      if (!r.ok) throw new Error(r.message);
    }
    const stub = env.VAULT.getByName(pv.vault.id);
    const ref = { id: pv.vault.id, name: pv.vault.name, ownerId: owner.user.id };
    await stub.writeNote(ref, caller(owner.user), { title: "Plan", content: "The plan.", source_text: "Owner's own words: tangerine." });
    const project = `${owner.user.username}/team`;
    const rd = await createPat(env, reader.user.id, "r", ["memory:read", "memory:write"], null);
    const ed = await createPat(env, editor.user.id, "e", ["memory:read", "memory:write"], null);
    const out = await createPat(env, outsider.user.id, "o", ["memory:read", "memory:write"], null);
    expect(text(await callTool(rd, "read_note", { project, identifier: "plan", sources: true }))).toContain("tangerine");
    const refused = await callTool(rd, "edit_note", { project, identifier: "plan", command: "append", content: "x", source_text: "reader words" });
    expect(text(refused)).toMatch(/^FORBIDDEN/);
    expect(text(await callTool(ed, "edit_note", { project, identifier: "plan", command: "append", content: "- more", source_text: "editor words" }))).toContain(
      "original text kept",
    );
    const o = text(await callTool(out, "read_note", { project, identifier: "plan", sources: true }));
    expect(o).toMatch(/^NOT_FOUND/);
    expect(o).not.toContain("tangerine");
    const os = text(await callTool(out, "search_notes", { query: "tangerine", all_projects: true }));
    expect(os).not.toContain("own words");
    expect(os).toMatch(/^No matches/);
  });
});

// ---------------------------------------------------------------- misses

describe("misses", () => {
  it("logs a search with no results, collapses repeats, and lists them over MCP", async () => {
    const { user } = await makeUser();
    const pat = await createPat(env, user.id, "claude-test", ["memory:read"], null);
    const q = "what is Dana Whitlow's favourite colour";
    expect(text(await callTool(pat, "search_notes", { query: q, tags: ["people"] }))).toMatch(/^No matches/);
    await callTool(pat, "search_notes", { query: `  ${q.toUpperCase()}? ` });
    const rows = await missRows(user.id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ tool: "search_notes", kind: "empty", count: 2, vault_name: "main", query: q });
    expect(String(rows[0].filters)).toContain('"tags":["people"]');
    // No note text, ever: only the query and the filters.
    await callTool(pat, "search_notes", { query: "Northwind invoice colour" });
    const listed = text(await callTool(pat, "recent_activity", { items: ["miss"] }));
    expect(listed.split("\n")[0]).toContain('"Northwind invoice colour" — search_notes, no results');
    expect(listed).toContain(`"${q}" — search_notes, no results ×2`);
    expect(listed).toContain("/app/misses");
    const viaProjects = text(await callTool(pat, "projects", { command: "recent", items: ["miss"], project: "main" }));
    expect(viaProjects).toContain("Northwind invoice colour");
    const js = JSON.parse(text(await callTool(pat, "recent_activity", { items: ["miss"], output_format: "json" })));
    expect(js.misses).toHaveLength(2);
    expect(text(await callTool(pat, "recent_activity", { items: ["miss", "note"] }))).toMatch(/^INVALID/);
  });

  it("logs the 'No note answers this directly' case, find_notes with nothing, and build_context on a missing note", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    for (const t of ["zqa", "zqb", "zqc"]) await v.stub.writeNote(v.ref, caller(user), { title: t, content: `${t} filler` });
    const pat = await createPat(env, user.id, "t", ["memory:read"], null);
    expect(text(await callTool(pat, "search_notes", { query: "zq" }))).toMatch(/^No note answers this directly\./);
    expect(text(await callTool(pat, "find_notes", { name: "*budget*" }))).toMatch(/^No notes match/);
    expect(text(await callTool(pat, "build_context", { identifier: "people/nobody-here" }))).toMatch(/^NOT_FOUND/);
    // A search that answers is not a miss; nor is page 2.
    await v.stub.writeNote(v.ref, caller(user), { title: "Roof work", content: "roof work quote from the roofer" });
    for (const t of ["roof a", "roof b"]) await v.stub.writeNote(v.ref, caller(user), { title: t, content: "roof work notes" });
    await callTool(pat, "search_notes", { query: "roof work" });
    await callTool(pat, "search_notes", { query: "roof work", page: 9 });
    const rows = await missRows(user.id);
    expect(rows.map((r) => [r.tool, r.kind, r.query])).toEqual([
      ["search_notes", "no_answer", "zq"],
      ["find_notes", "empty", "*budget*"],
      ["build_context", "not_found", "people/nobody-here"],
    ]);
  });

  it("log_miss records an explicit miss, upgrades an automatic one, and refuses projects the caller can't see", async () => {
    const { user } = await makeUser();
    const other = await makeUser();
    await createVault(env, other.user.id, "hidden");
    const pat = await createPat(env, user.id, "t", ["memory:read"], null);
    expect(text(await callTool(pat, "log_miss", { question: "When is the Northwind renewal?", expected: "a customers/northwind note" }))).toBe(
      "logged as a miss in main",
    );
    await callTool(pat, "search_notes", { query: "dana whitlow phone number" });
    expect(text(await callTool(pat, "log_miss", { question: "Dana Whitlow phone number" }))).toBe("logged again as a miss in main");
    const rows = await missRows(user.id);
    expect(rows.map((r) => [r.kind, r.tool, r.count, r.expected])).toEqual([
      ["explicit", "log_miss", 1, "a customers/northwind note"],
      ["explicit", "log_miss", 2, null],
    ]);
    expect(text(await callTool(pat, "log_miss", { question: "x", project: `${other.user.username}/hidden` }))).toMatch(/^NOT_FOUND/);
    expect(text(await callTool(pat, "log_miss", { question: "x", project: "hidden" }))).toMatch(/^NOT_FOUND/);
  });

  it("redacts secrets in the query, filters and expectation", async () => {
    const { user } = await makeUser();
    const pat = await createPat(env, user.id, "t", ["memory:read"], null);
    await callTool(pat, "search_notes", { query: "where did I use ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(text(await callTool(pat, "log_miss", { question: "my api_key=abc123secret", expected: "password: hunter2" }))).toContain("2 secret(s) redacted");
    const rows = await missRows(user.id);
    const all = JSON.stringify(rows);
    expect(all).not.toContain("ghp_");
    expect(all).not.toContain("abc123secret");
    expect(all).not.toContain("hunter2");
    expect(rows[0].query).toBe("where did I use [redacted]");
  });

  it("de-duplicates within 10 minutes only, caps new rows per hour, and keeps 90 days", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    const base = { userId: user.id, vaultId: v.vault.id, vaultName: "main", tool: "search_notes", kind: "empty" as const };
    const t0 = Date.parse("2026-11-06T10:00:00Z");
    expect(await recordMiss(env, { ...base, query: "renewal date" }, t0)).toMatchObject({ repeat: false });
    expect(await recordMiss(env, { ...base, query: "Renewal  date?" }, t0 + 5 * 60e3)).toMatchObject({ repeat: true });
    expect(await recordMiss(env, { ...base, query: "renewal date" }, t0 + 16 * 60e3)).toMatchObject({ repeat: false });
    expect(await recordMiss(env, { ...base, query: "   " }, t0)).toBeNull();
    // Another project is another miss.
    expect(await recordMiss(env, { ...base, vaultId: null, vaultName: "main, work", query: "renewal date" }, t0 + 17 * 60e3)).toMatchObject({
      repeat: false,
    });
    const hourStart = Date.parse("2026-11-06T12:00:00Z");
    for (let i = 0; i < MISS_ROWS_PER_HOUR; i++) await recordMiss(env, { ...base, query: `question ${i}` }, hourStart + i);
    expect(await recordMiss(env, { ...base, query: "one too many" }, hourStart + 1000)).toBeNull();
    // A repeat still counts while capped.
    expect(await recordMiss(env, { ...base, query: "question 3" }, hourStart + 2000)).toMatchObject({ repeat: true });
    expect(await recordMiss(env, { ...base, query: "next hour" }, hourStart + 3600e3 + 1)).toMatchObject({ repeat: false });
    // Retention: rows last seen more than 90 days ago go.
    const before = (await missRows(user.id)).length;
    await pruneMisses(env, hourStart + 90 * 86400e3 + 30 * 60e3);
    const after = await missRows(user.id);
    expect(after.length).toBeLessThan(before);
    expect(after.map((r) => r.query)).toEqual(["next hour"]);
    await pruneMisses(env, hourStart + 92 * 86400e3);
    expect(await missRows(user.id)).toEqual([]);
  });

  it("shows misses at /app/misses, filters by project, dismisses and clears; nobody else's", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const av = await defaultVault(a.user.id);
    const work = await createVault(env, a.user.id, "work");
    if (!work.ok) throw new Error(work.message);
    await recordMiss(env, { userId: a.user.id, vaultId: av.vault.id, vaultName: "main", query: "dana whitlow birthday", tool: "search_notes", kind: "empty" });
    await recordMiss(env, { userId: a.user.id, vaultId: work.vault.id, vaultName: "work", query: "northwind sla", tool: "log_miss", kind: "explicit" });
    const bMiss = await recordMiss(env, {
      userId: b.user.id,
      vaultId: null,
      vaultName: "main",
      query: "bob private question",
      tool: "search_notes",
      kind: "empty",
    });
    const page = await (await fetchWorker("/app/misses", { headers: { cookie: a.cookie } })).text();
    expect(page).toContain("dana whitlow birthday");
    expect(page).toContain("northwind sla");
    expect(page).toContain("agent said the notes don&#39;t say");
    expect(page).not.toContain("bob private question");
    expect(page).toContain('href="/app/misses"');
    const filtered = await (await fetchWorker("/app/misses?project=work", { headers: { cookie: a.cookie } })).text();
    expect(filtered).toContain("northwind sla");
    expect(filtered).not.toContain("dana whitlow birthday");
    // Anonymous: to the login page.
    expect((await fetchWorker("/app/misses")).status).toBe(302);

    const post = (cookie: string, path: string, fields: Record<string, string>) =>
      fetchWorker(path, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
    // A can't dismiss B's miss (404, untouched); A's own dismiss works.
    expect((await post(a.cookie, "/app/misses/dismiss", { id: String(bMiss?.id) })).status).toBe(404);
    expect((await missRows(b.user.id))[0].dismissed_at).toBeNull();
    const own = (await missRows(a.user.id)).find((r) => r.query === "northwind sla");
    expect((await post(a.cookie, "/app/misses/dismiss", { id: String(own?.id) })).status).toBe(303);
    expect(await (await fetchWorker("/app/misses", { headers: { cookie: a.cookie } })).text()).not.toContain("northwind sla");
    // Clearing one project leaves the rest; clearing all leaves B's.
    expect((await post(a.cookie, "/app/misses/clear", { project: "work" })).status).toBe(303);
    expect((await missRows(a.user.id)).map((r) => r.query)).toEqual(["dana whitlow birthday"]);
    expect((await post(a.cookie, "/app/misses/clear", { project: "nope" })).status).toBe(404);
    expect((await post(a.cookie, "/app/misses/clear", {})).status).toBe(303);
    expect(await missRows(a.user.id)).toEqual([]);
    expect((await missRows(b.user.id)).length).toBe(1);
    expect(await clearMisses(env, b.user.id)).toBe(1);
  });

  it("a member's misses in a shared project are theirs alone; the owner never sees them", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    const pv = await createVault(env, owner.user.id, "team");
    if (!pv.ok) throw new Error(pv.message);
    await addMember(env, pv.vault.id, member.user.id, "reader", owner.user.id);
    const mp = await createPat(env, member.user.id, "m", ["memory:read"], null);
    const op = await createPat(env, owner.user.id, "o", ["memory:read"], null);
    await callTool(mp, "search_notes", { project: `${owner.user.username}/team`, query: "member's private question about salaries" });
    const mine = await listMisses(env, member.user.id);
    expect(mine.map((m) => [m.vault_name, m.query])).toEqual([[`${owner.user.username}/team`, "member's private question about salaries"]]);
    expect(await listMisses(env, owner.user.id)).toEqual([]);
    expect(text(await callTool(op, "recent_activity", { items: ["miss"], project: "team" }))).not.toContain("salaries");
    const ownerPage = await (await fetchWorker("/app/misses", { headers: { cookie: owner.cookie } })).text();
    expect(ownerPage).not.toContain("salaries");
  });

  it("goes into download-my-data and away with the account", async () => {
    const { user, cookie } = await makeUser();
    await recordMiss(env, { userId: user.id, vaultId: null, vaultName: "main", query: "dana whitlow address", tool: "search_notes", kind: "empty" });
    const { accountJson } = await import("../src/web/export");
    const acct = await accountJson(env, user);
    expect(acct.misses).toEqual([expect.objectContaining({ query: "dana whitlow address", vault_name: "main" })]);
    expect(cookie).toBeTruthy();
    expect(await listOwnedVaults(env, user.id)).not.toEqual([]);
    await deleteAccount(env, { listUserGrants: async () => ({ items: [], cursor: undefined }), revokeGrant: async () => {} } as never, user.id);
    expect(await missRows(user.id)).toEqual([]);
  });
});
