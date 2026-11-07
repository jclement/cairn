// Reading a file's text, so search finds what's inside an attachment and an agent can quote a page.
//
// - PDF: Workers AI toMarkdown. Page boundaries become "<!-- page N -->" lines when the converter
//   marks pages ("## Page N" / "### Page N" headings, form feeds, or such comments); otherwise the
//   text is one block with no page numbers. At most EXTRACT.maxPages pages and EXTRACT.maxBytes of
//   text; the label says when it was cut. A PDF with no text layer (a scan) is "none", said plainly:
//   rendering pages to images for OCR isn't possible in a Worker.
// - Image: the vision model transcribes every visible text and describes the image (tables and
//   whiteboards transcribed). The short caption stays the image's alt text.
// - Text files (txt, md, csv, json): their contents.
// Secrets are redacted (src/secrets.ts). The text is kept in D1 (attachment_texts) and charged to
// the owner's quota with the file; each note linking the file gets a searchable copy in its vault.
//
// State lives on the attachment (migrations/0020): pending -> done | failed | none. AI calls are
// charged to the owner's daily AI budget first; when it is spent the file stays pending until the
// next UTC day and the queue (cron) retries it. A claim (extract_after as a lease) keeps the queue
// and an inline run from reading the same file twice.

import { type Vault, vaultRef } from "../directory";
import { type Env, LIMITS } from "../env";
import { redactSecrets } from "../secrets";
import { spendAiBudget } from "../stats/budget";
import { recordAi } from "../stats/record";
import { type AttachmentRow, DEFAULT_VISION_MODEL, extractKind } from "./files";

export const EXTRACT = {
  /** Pages of a PDF kept. */
  maxPages: 200,
  /** Bytes of text kept per file (after redaction). */
  maxBytes: 500 * 1024,
  /** Images larger than this aren't sent to the vision model. */
  maxImageBytes: 8 * 1024 * 1024,
  /** Files the queue reads per run. */
  batch: 8,
  /** How long a claim holds a file before another run may take it. */
  leaseMs: 10 * 60e3,
  timeoutMs: 60_000,
  visionMaxTokens: 2048,
};

export const BUDGET_WAIT = "waiting for the daily AI budget; retried tomorrow";

export type ExtractOutcome = {
  state: "done" | "pending" | "failed" | "none" | "skipped";
  error?: string;
  pages?: number | null;
  bytes?: number;
  /** Notes that now hold the text. */
  notes?: string[];
};

const nowIso = () => new Date().toISOString();
const nextUtcDay = (now = Date.now()) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5)).toISOString();
};

type Fail = { ok: false; budget?: boolean; error: string };
type Got = { ok: true; text: string; pages: string[] | null; totalPages?: number } | Fail;

// ---------------------------------------------------------------- page markers

const PAGE_HEADING = /^(?:#{1,6}\s*)?page\s+(\d+)\s*$/i;
const PAGE_COMMENT = /^<!--\s*page\s+(\d+)\s*-->$/i;

/**
 * Split converter output into pages: by "Page N" headings, page comments or form feeds. Drops a
 * leading metadata section. Null pages when it marks none (one block of text).
 */
export function splitPages(markdown: string): { pages: string[] | null; text: string } {
  let md = markdown.replace(/\r\n/g, "\n");
  // toMarkdown may lead with the file name and a "## Metadata" list; the text is under "## Contents".
  const contents = /^#{1,3}\s*Contents\s*$/im.exec(md);
  if (/^#{1,3}\s*Metadata\s*$/im.test(md) && contents) md = md.slice(contents.index + contents[0].length);
  if (md.includes("\f")) {
    const pages = md.split("\f").map((p) => p.trim());
    while (pages.length > 1 && !pages[pages.length - 1]) pages.pop();
    return { pages, text: md };
  }
  const lines = md.split("\n");
  const pages: string[] = [];
  let cur: string[] | null = null;
  const pre: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (PAGE_HEADING.test(t) || PAGE_COMMENT.test(t)) {
      if (cur) pages.push(cur.join("\n").trim());
      cur = [];
      continue;
    }
    (cur ?? pre).push(l);
  }
  if (!cur) return { pages: null, text: md.trim() };
  pages.push(cur.join("\n").trim());
  // Text before the first marker (a title) belongs to page 1.
  const head = pre.join("\n").trim();
  if (head && !/^#\s+\S+\.pdf$/i.test(head)) pages[0] = `${head}\n\n${pages[0]}`.trim();
  return { pages, text: md };
}

/** Whether extracted text says anything (beyond markers, headings and punctuation). */
export function hasText(s: string): boolean {
  const words = s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^#{1,6}\s.*$/gm, " ")
    .match(/[\p{L}\p{N}]{2,}/gu);
  return (words?.join("").length ?? 0) >= 12;
}

/** The kept text: pages joined with markers, redacted, capped. */
export function composeText(
  name: string,
  kind: "pdf" | "image" | "text",
  got: { text: string; pages: string[] | null; totalPages?: number },
): { text: string; label: string; pages: number | null; cut: boolean; redactions: number; kinds: string[] } {
  let cut = false;
  let pages: number | null = null;
  let body: string;
  if (got.pages) {
    const total = got.totalPages ?? got.pages.length;
    const kept = got.pages.slice(0, EXTRACT.maxPages);
    if (total > kept.length) cut = true;
    body = kept.map((p, i) => `<!-- page ${i + 1} -->\n${p}`).join("\n\n");
    pages = kept.length;
  } else body = got.text.trim();
  const r = redactSecrets(body);
  let text = r.text;
  const enc = new TextEncoder();
  const all = enc.encode(text);
  if (all.length > EXTRACT.maxBytes) {
    cut = true;
    text = new TextDecoder().decode(all.slice(0, EXTRACT.maxBytes - 200)).replace(/�+$/, "");
    const nl = text.lastIndexOf("\n");
    if (nl > text.length - 4096) text = text.slice(0, nl);
    if (pages) {
      // Pages actually kept: the last marker left in the text.
      const marks = [...text.matchAll(/^<!-- page (\d+) -->$/gm)];
      pages = marks.length ? Number(marks[marks.length - 1][1]) : pages;
    }
  }
  const total = got.pages ? (got.totalPages ?? got.pages.length) : null;
  let label: string;
  if (kind === "pdf")
    label = pages
      ? `from ${name}, page${pages === 1 ? "" : "s"} 1${pages > 1 ? `–${pages}` : ""}${cut && total ? ` of ${total} (cut)` : cut ? " (cut)" : ""}`
      : `from ${name}${cut ? " (cut)" : ""}`;
  else if (kind === "image") label = `from ${name} (its text and a description)`;
  else label = `from ${name}${cut ? " (cut)" : ""}`;
  if (cut) text += `\n[… cut: Cairn keeps ${EXTRACT.maxPages} pages / ${EXTRACT.maxBytes / 1024} KB of a file's text]`;
  return { text, label, pages, cut, redactions: r.count, kinds: r.kinds };
}

// ---------------------------------------------------------------- readers

type ToMarkdown = { toMarkdown(files: { name: string; blob: Blob }[]): Promise<{ data?: string; format?: string; tokens?: number }[]> };
type AiRunner = { run(model: string, input: unknown): Promise<unknown> };

const race = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), EXTRACT.timeoutMs))]);

/** Test fake: the printable text after the header; form feeds are page breaks. */
function fakePdf(bytes: Uint8Array): string {
  const body = new TextDecoder().decode(bytes).replace(/^%PDF-[^\n]*\n?/, "");
  const pages = body.split("\f").map((p) => p.replace(/[^\x20-\x7e\n]/g, "").trim());
  if (!pages.some((p) => p)) return "# file.pdf\n\n## Metadata\n- PDFFormatVersion=1.4\n\n## Contents\n";
  return `# file.pdf\n\n## Metadata\n- PDFFormatVersion=1.4\n\n## Contents\n${pages.map((p, i) => `### Page ${i + 1}\n${p}`).join("\n\n")}`;
}

async function readPdf(env: Env, userId: string, name: string, bytes: Uint8Array): Promise<Got> {
  const fake = env.CAIRN_FAKE_CAPTURE_AI === "1";
  const ai = env.AI as unknown as Partial<ToMarkdown> | undefined;
  if (!fake && !ai?.toMarkdown) return { ok: false, error: "PDF reading is not available on this server (no AI binding)" };
  const estimate = Math.min(Math.ceil(bytes.byteLength / 8), 200_000);
  if (!(await spendAiBudget(env, userId, estimate).catch(() => false))) return { ok: false, budget: true, error: BUDGET_WAIT };
  const started = Date.now();
  let out: string | null = null;
  let tokens = 0;
  let error = "the converter returned nothing";
  try {
    if (fake) {
      if (name.includes("fail-extract")) throw new Error("injected failure");
      out = fakePdf(bytes);
    } else {
      const [r] = await race((ai as ToMarkdown).toMarkdown([{ name, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }) }]));
      if (r?.format === "markdown" && typeof r.data === "string") {
        out = r.data;
        tokens = r.tokens ?? 0;
      } else if (r?.format === "error") error = String(r.data ?? "conversion failed").slice(0, 200);
    }
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 200);
  }
  await recordAi(env.DB, {
    userId,
    model: "toMarkdown",
    purpose: "file_text",
    ok: out !== null,
    latencyMs: Date.now() - started,
    inputTokens: tokens || estimate,
    outputTokens: 0,
    estimated: !tokens,
  }).catch(() => {});
  if (out === null) return { ok: false, error };
  const { pages, text } = splitPages(out);
  return { ok: true, text, pages, totalPages: pages?.length };
}

/** Test fake: printable runs of 6+ characters inside the image bytes stand for its visible text. */
function fakeVision(bytes: Uint8Array, name: string): string {
  const runs = new TextDecoder("latin1").decode(bytes).match(/[\x20-\x7e]{6,}/g) ?? [];
  const words = runs.filter((r) => !/^(IHDR|IDAT|IEND|JFIF|Exif)/.test(r)).join("\n");
  return `## Text\n${words || "none"}\n\n## Description\nAn image named ${name}.`;
}

const VISION_PROMPT = `Read this image for the user's personal notes, so they can search it later.
First, under the heading "## Text", transcribe ALL visible text exactly as written, top to bottom, keeping line breaks; transcribe tables as markdown tables and whiteboards or handwriting as best you can. Write "none" if there is no text.
Then, under the heading "## Description", describe the image fully: what it shows, its layout, the people, objects, places, charts or diagrams in it, and anything notable.
No preamble.`;

async function readImage(env: Env, userId: string, name: string, bytes: Uint8Array, mime: string): Promise<Got> {
  const fake = env.CAIRN_FAKE_CAPTURE_AI === "1";
  const model = env.VISION_MODEL ?? DEFAULT_VISION_MODEL;
  if (!fake && (!model || !env.AI)) return { ok: false, error: "image reading is turned off on this server" };
  if (bytes.byteLength > EXTRACT.maxImageBytes) return { ok: false, error: `the image is over ${EXTRACT.maxImageBytes / 1024 / 1024} MB` };
  const estimate = 1600 + EXTRACT.visionMaxTokens;
  if (!(await spendAiBudget(env, userId, estimate).catch(() => false))) return { ok: false, budget: true, error: BUDGET_WAIT };
  const started = Date.now();
  let out: string | null = null;
  let error = "the vision model returned nothing";
  try {
    if (fake) {
      if (name.includes("fail-extract")) throw new Error("injected failure");
      out = fakeVision(bytes, name);
    } else {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = (await race(
        (env.AI as unknown as AiRunner).run(model, {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: VISION_PROMPT },
                { type: "image_url", image_url: { url: `data:${mime};base64,${btoa(s)}` } },
              ],
            },
          ],
          max_tokens: EXTRACT.visionMaxTokens,
        }),
      )) as { response?: string; choices?: { message?: { content?: string } }[] };
      const t = (r.response ?? r.choices?.[0]?.message?.content ?? "").trim();
      if (t) out = t;
    }
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 200);
  }
  await recordAi(env.DB, {
    userId,
    model: fake ? "fake-vision" : model,
    purpose: "file_text",
    ok: out !== null,
    latencyMs: Date.now() - started,
    inputTokens: 1600,
    outputTokens: out ? Math.ceil(out.length / 4) : 0,
    estimated: true,
  }).catch(() => {});
  if (out === null) return { ok: false, error };
  return { ok: true, text: out, pages: null };
}

function readText(bytes: Uint8Array): Got {
  return { ok: true, text: new TextDecoder().decode(bytes), pages: null };
}

// ---------------------------------------------------------------- one file

/** Claim a pending file for reading (a lease on extract_after), or null if it isn't ours to read now. */
async function claim(env: Env, vaultId: string, id: string): Promise<AttachmentRow | null> {
  const now = nowIso();
  return env.DB.prepare(
    `UPDATE attachments SET extract_after = ?1, extract_tries = extract_tries + 1
     WHERE id = ?2 AND vault_id = ?3 AND state = 'ready' AND extract_state = 'pending' AND (extract_after IS NULL OR extract_after <= ?4) RETURNING *`,
  )
    .bind(new Date(Date.now() + EXTRACT.leaseMs).toISOString(), id, vaultId, now)
    .first<AttachmentRow>();
}

async function settle(env: Env, id: string, state: "pending" | "failed" | "none", error: string, after: string | null): Promise<void> {
  await env.DB.prepare("UPDATE attachments SET extract_state = ?, extract_error = ?, extract_after = ?, extract_at = ? WHERE id = ? AND state = 'ready'")
    .bind(state, error, after, nowIso(), id)
    .run();
}

/**
 * Read a file's text now, if it is pending and not claimed by another run. Stores the text, charges
 * it to the owner's quota, and copies it into the notes that link the file.
 */
export async function extractAttachment(env: Env, vault: Vault, id: string): Promise<ExtractOutcome> {
  const row = await claim(env, vault.id, id);
  if (!row) {
    const cur = await env.DB.prepare("SELECT extract_state, extract_error, extract_pages, extract_bytes FROM attachments WHERE id = ? AND vault_id = ?")
      .bind(id, vault.id)
      .first<{ extract_state: ExtractOutcome["state"] | null; extract_error: string | null; extract_pages: number | null; extract_bytes: number }>();
    return cur?.extract_state
      ? { state: cur.extract_state, error: cur.extract_error ?? undefined, pages: cur.extract_pages, bytes: cur.extract_bytes }
      : { state: "skipped" };
  }
  const kind = extractKind(row.mime);
  if (!kind) {
    await settle(env, id, "none", "not a PDF, image or text file", null);
    return { state: "none", error: "not a PDF, image or text file" };
  }
  const obj = await env.FILES?.get(row.r2_key);
  if (!obj) {
    await settle(env, id, "failed", "the file's bytes are missing", null);
    return { state: "failed", error: "the file's bytes are missing" };
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let got: Got;
  try {
    got =
      kind === "pdf"
        ? await readPdf(env, row.user_id, row.name, bytes)
        : kind === "image"
          ? await readImage(env, row.user_id, row.name, bytes, row.mime)
          : readText(bytes);
  } catch (e) {
    got = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  if (!got.ok) {
    if (got.budget) {
      // Not a try: the budget refused before anything ran.
      await env.DB.prepare("UPDATE attachments SET extract_tries = MAX(0, extract_tries - 1) WHERE id = ?").bind(id).run();
      await settle(env, id, "pending", got.error, nextUtcDay());
      return { state: "pending", error: got.error };
    }
    await settle(env, id, "failed", got.error, null);
    return { state: "failed", error: got.error };
  }
  if (!hasText(got.pages ? got.pages.join("\n") : got.text)) {
    const why =
      kind === "pdf"
        ? "no text layer (a scanned PDF?); Cairn can't read scans yet"
        : kind === "image"
          ? "no text or description came back"
          : "the file is empty";
    await settle(env, id, "none", why, null);
    return { state: "none", error: why };
  }
  const c = composeText(row.name, kind, got);
  const bytesKept = new TextEncoder().encode(c.text).length + new TextEncoder().encode(c.label).length;
  // The text and its charge together: the delta against any earlier text, refused over quota.
  const old = row.extract_bytes ?? 0;
  const delta = bytesKept - old;
  const ts = nowIso();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE attachments SET extract_state = 'done', extract_error = NULL, extract_after = NULL, extract_pages = ?1, extract_bytes = ?2, extract_at = ?3
       WHERE id = ?4 AND state = 'ready' AND extract_bytes = ?5
         AND (?6 <= 0 OR (SELECT bytes_used + import_staged_bytes + ?6 <= ?7 FROM users WHERE id = ?8) = 1)`,
    ).bind(c.pages, bytesKept, ts, id, old, delta, LIMITS.userBytes, row.user_id),
    env.DB.prepare(
      "UPDATE users SET bytes_used = MAX(0, bytes_used + ?1) WHERE id = ?2 AND EXISTS (SELECT 1 FROM attachments WHERE id = ?3 AND extract_state = 'done' AND extract_at = ?4)",
    ).bind(delta, row.user_id, id, ts),
    env.DB.prepare(
      `INSERT INTO attachment_texts (attachment_id, vault_id, label, text, redactions, cut, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM attachments WHERE id = ?1 AND extract_state = 'done' AND extract_at = ?7)
       ON CONFLICT (attachment_id) DO UPDATE SET label = excluded.label, text = excluded.text, redactions = excluded.redactions, cut = excluded.cut, created_at = excluded.created_at`,
    ).bind(id, vault.id, c.label, c.text, c.redactions, c.cut ? 1 : 0, ts),
  ]);
  if (!res[0].meta.changes) {
    // Over quota (or the file went away meanwhile).
    const msg = `the text (${Math.ceil(bytesKept / 1024)} KB) would exceed this account's storage limit`;
    await settle(env, id, "failed", msg, null);
    return { state: "failed", error: msg };
  }
  const stub = env.VAULT.getByName(vault.id);
  const notes = await stub
    .fileText(vaultRef(vault), { attachment_id: id, label: c.label, text: c.text, redactions: c.redactions, cut: c.cut })
    .catch(() => [] as string[]);
  // Deleted while its text was being copied: take the copies back out.
  const still = await env.DB.prepare("SELECT 1 AS x FROM attachments WHERE id = ? AND state = 'ready'").bind(id).first();
  if (!still) await stub.dropFileText(vaultRef(vault), id).catch(() => 0);
  return { state: "done", pages: c.pages, bytes: bytesKept, notes };
}

/** One line for a receipt: what happened to the file's text. */
export function outcomeLine(o: ExtractOutcome): string {
  switch (o.state) {
    case "done":
      return `text: read${o.pages ? ` (${o.pages} page${o.pages === 1 ? "" : "s"})` : ""}, ${Math.ceil((o.bytes ?? 0) / 1024)} KB, searchable${o.notes?.length ? `; kept with ${o.notes.join(", ")}` : ""}`;
    case "pending":
      return `text: pending${o.error ? ` (${o.error})` : ""}`;
    case "failed":
      return `text: failed (${o.error ?? "unknown"}); it can be retried from the note's file list`;
    case "none":
      return `text: none (${o.error ?? "nothing to read"})`;
    default:
      return "text: being read by another request";
  }
}

// ---------------------------------------------------------------- queue, backfill, retry

/** Read the next due pending files (cron, and after a backfill). Bounded per run. */
export async function runExtractionQueue(
  env: Env,
  opts: { limit?: number; vaultId?: string } = {},
): Promise<{ read: number; outcomes: Record<string, number> }> {
  const limit = opts.limit ?? EXTRACT.batch;
  const due = (
    await env.DB.prepare(
      `SELECT a.id, a.vault_id FROM attachments a JOIN users u ON u.id = a.user_id
       WHERE a.extract_state = 'pending' AND a.state = 'ready' AND (a.extract_after IS NULL OR a.extract_after <= ?1)
         AND u.disabled_at IS NULL AND u.deleting_at IS NULL ${opts.vaultId ? "AND a.vault_id = ?3" : ""}
       ORDER BY a.extract_after IS NOT NULL, a.created_at LIMIT ?2`,
    )
      .bind(nowIso(), limit, ...(opts.vaultId ? [opts.vaultId] : []))
      .all<{ id: string; vault_id: string }>()
  ).results;
  const outcomes: Record<string, number> = {};
  const vaults = new Map<string, Vault | null>();
  for (const d of due) {
    if (!vaults.has(d.vault_id)) vaults.set(d.vault_id, await env.DB.prepare("SELECT * FROM vaults WHERE id = ?").bind(d.vault_id).first<Vault>());
    const v = vaults.get(d.vault_id);
    if (!v) continue;
    const o = await extractAttachment(env, v, d.id).catch((e) => ({ state: "failed" as const, error: String(e) }));
    outcomes[o.state] = (outcomes[o.state] ?? 0) + 1;
  }
  return { read: due.length, outcomes };
}

/** The owner's backfill: queue every file of a project whose text was never read. Returns how many were queued. */
export async function queueBackfill(env: Env, vault: Vault): Promise<{ queued: number; none: number }> {
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE attachments SET extract_state = 'pending', extract_after = NULL, extract_error = NULL
       WHERE vault_id = ? AND state = 'ready' AND extract_state IS NULL
         AND (mime IN ('application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json') OR mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'))`,
    ).bind(vault.id),
    env.DB.prepare(
      "UPDATE attachments SET extract_state = 'none', extract_error = 'not a PDF, image or text file' WHERE vault_id = ? AND state = 'ready' AND extract_state IS NULL",
    ).bind(vault.id),
  ]);
  return { queued: res[0].meta.changes ?? 0, none: res[1].meta.changes ?? 0 };
}

/** How many of a project's files wait to be read, and how many were never tried. */
export async function extractionCounts(env: Env, vault: Vault): Promise<{ pending: number; never: number; failed: number; done: number }> {
  const r = await env.DB.prepare(
    `SELECT SUM(extract_state = 'pending') AS pending, SUM(extract_state IS NULL) AS never, SUM(extract_state = 'failed') AS failed, SUM(extract_state = 'done') AS done
     FROM attachments WHERE vault_id = ? AND state = 'ready'`,
  )
    .bind(vault.id)
    .first<{ pending: number | null; never: number | null; failed: number | null; done: number | null }>();
  return { pending: r?.pending ?? 0, never: r?.never ?? 0, failed: r?.failed ?? 0, done: r?.done ?? 0 };
}

/** Queue one file to be read again (a failed one, or any the owner wants re-read). False if not found. */
export async function retryExtraction(env: Env, vault: Vault, id: string): Promise<boolean> {
  if (!/^[a-z0-9]{12}$/.test(id)) return false;
  const r = await env.DB.prepare(
    `UPDATE attachments SET extract_state = 'pending', extract_after = NULL, extract_error = NULL, extract_tries = 0
     WHERE id = ? AND vault_id = ? AND state = 'ready' AND (extract_state IS NULL OR extract_state != 'pending' OR extract_after IS NULL OR extract_after <= ?)`,
  )
    .bind(id, vault.id, nowIso())
    .run();
  return !!r.meta.changes;
}

/** A file's kept text, for read_note file=. */
export async function fileText(env: Env, vault: Vault, id: string): Promise<{ label: string; text: string } | null> {
  return env.DB.prepare(
    "SELECT t.label, t.text FROM attachment_texts t JOIN attachments a ON a.id = t.attachment_id WHERE t.attachment_id = ? AND t.vault_id = ? AND a.vault_id = ? AND a.state = 'ready'",
  )
    .bind(id, vault.id, vault.id)
    .first<{ label: string; text: string }>();
}

/** Pages `spec` ("3", "2-4") of a file's text, or null when the text has no page markers / no such page. */
export function pagesOf(text: string, spec: string): { text: string; from: number; to: number; total: number } | null {
  const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(spec);
  if (!m) return null;
  const parts = text.split(/^<!-- page (\d+) -->$/m);
  // parts: [before, n1, text1, n2, text2, ...]
  const pages = new Map<number, string>();
  for (let i = 1; i + 1 < parts.length; i += 2) pages.set(Number(parts[i]), parts[i + 1].trim());
  if (!pages.size) return null;
  const total = Math.max(...pages.keys());
  const from = Number(m[1]);
  const to = Math.min(Number(m[2] ?? m[1]), total, from + 49);
  if (from < 1 || from > total || to < from) return null;
  const out: string[] = [];
  for (let p = from; p <= to; p++) out.push(`<!-- page ${p} -->\n${pages.get(p) ?? ""}`);
  return { text: out.join("\n\n"), from, to, total };
}
