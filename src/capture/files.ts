// Attachments: bytes in R2 (`<vaultId>/<sha256>.<id>.<ext>`), metadata, lifecycle and quota in D1.
//
// Quota: each file is charged its size plus ATTACHMENT_OVERHEAD (its row and object metadata) to
// users.bytes_used, and each user may hold MAX_ATTACHMENTS live files. The charge is outside the
// vault ledger (vaults.charged_bytes), so the vault Durable Object's reconcile never touches it.
//
// Lifecycle (see migrations/0007_capture.sql): the 'pending' row and its charge are written in one
// D1 transaction, so a charge never exists without a row; the R2 object is then written and the
// row becomes 'ready' (only 'ready' rows are served). Deleting marks the row 'deleting', removes the
// object, and only then drops the row and releases the charge, so a failed R2 delete stays charged
// and retryable. sweepAttachments() (nightly cron) rolls back stale 'pending' rows and finishes
// 'deleting' ones. Object keys are unique per row, so a re-upload of deleted content never shares
// an object with the delete in flight. An account being deleted can't start uploads, and an upload
// whose row was purged mid-flight deletes its own object.

import { type Vault, vaultRef } from "../directory";
import { type Env, LIMITS } from "../env";
import { spendAiBudget } from "../stats/budget";
import { recordAi } from "../stats/record";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Charged per file on top of its bytes: covers its D1 row (name, mime, caption) and R2 metadata. */
export const ATTACHMENT_OVERHEAD = 2048;
/** Live files per user (bounds row count independently of the byte quota; export reads all of them). */
export const MAX_ATTACHMENTS = 5000;
export const DEFAULT_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const CAPTION_MAX_BYTES = 5 * 1024 * 1024;
const STALE_MS = 15 * 60e3;
/** How long a put that may still land after the sweeper gave up on it is watched for. */
const LATE_PUT_MS = 60 * 60e3;
/** Bounded wait for an identical upload in flight before answering BUSY. */
export const DEDUPE_WAIT = { tries: 10, ms: 300 };

/** Types we will serve inline (and caption). Decided by magic bytes, never by the client's claim. */
const INLINE_IMAGES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
/** The only other stored types; anything else is application/octet-stream. */
const OTHER_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/svg+xml": "svg",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/zip": "zip",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "application/octet-stream": "bin",
};

export interface AttachmentRow {
  id: string;
  user_id: string;
  vault_id: string;
  sha256: string;
  r2_key: string;
  name: string;
  mime: string;
  bytes: number;
  caption: string | null;
  source: string;
  state: "pending" | "ready" | "deleting";
  /** Set while an import that stored this file hasn't committed (see migrations/0014). */
  import_job?: string | null;
  /** Reading the file's text (migrations/0020): null never tried, pending, done, failed, none. */
  extract_state?: "pending" | "done" | "failed" | "none" | null;
  extract_error?: string | null;
  extract_after?: string | null;
  extract_tries?: number;
  extract_pages?: number | null;
  extract_bytes?: number;
  extract_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type PutResult =
  | { ok: true; attachment: AttachmentRow; url: string; markdown: string; created: boolean }
  | { ok: false; code: "UNAVAILABLE" | "TOO_LARGE" | "QUOTA" | "INVALID" | "BUSY"; message: string };

export function isInlineImage(mime: string): boolean {
  return mime in INLINE_IMAGES;
}

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/** How Cairn reads a file's text: a PDF through toMarkdown, an image through the vision model, a text file as is. */
export function extractKind(mime: string): "pdf" | "image" | "text" | null {
  if (mime === "application/pdf") return "pdf";
  if (isInlineImage(mime)) return "image";
  if (TEXT_TYPES.has(mime)) return "text";
  return null;
}

/** The extraction state a newly stored file starts in. */
export function initialExtract(mime: string): { state: "pending" | "none"; error: string | null } {
  return extractKind(mime) ? { state: "pending", error: null } : { state: "none", error: "not a PDF, image or text file" };
}

const charge = (bytes: number) => bytes + ATTACHMENT_OVERHEAD;

/**
 * Content type from magic bytes, else the declared type (or the file extension) **if** it is on the
 * short allowlist; anything else is application/octet-stream. Never inline-able unless sniffed.
 */
export function sniffMime(bytes: Uint8Array, declared: string | undefined, name: string): string {
  const b = bytes;
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return "image/avif";
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")) || /\.svg$/i.test(name)) return "image/svg+xml";
  const d = (declared ?? "").slice(0, 100).split(";")[0].trim().toLowerCase();
  if (d in OTHER_EXT && d !== "image/svg+xml" && d !== "application/pdf") return d;
  if (/\.(md|markdown)$/i.test(name)) return "text/markdown";
  if (/\.txt$/i.test(name)) return "text/plain";
  if (/\.csv$/i.test(name)) return "text/csv";
  return "application/octet-stream";
}

export function extFor(mime: string): string {
  return INLINE_IMAGES[mime] ?? OTHER_EXT[mime] ?? "bin";
}

export function safeName(name: string | undefined, mime: string): string {
  const base = (name ?? "")
    .slice(0, 1000)
    .split(/[\\/]/)
    .pop()
    ?.replace(/[^\p{L}\p{N} ._()-]+/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return base || `file.${extFor(mime)}`;
}

export function fileUrl(project: string, id: string): string {
  return `/app/files/${encodeURIComponent(project)}/${id}`;
}

/** The markdown that embeds (images) or links (anything else) an attachment. */
export function attachmentMarkdown(project: string, a: Pick<AttachmentRow, "id" | "name" | "mime" | "caption">): string {
  const label = (s: string) => s.replace(/[[\]\n\r]/g, " ").trim();
  return isInlineImage(a.mime) ? `![${label(a.caption || a.name)}](${fileUrl(project, a.id)})` : `[${label(a.name)}](${fileUrl(project, a.id)})`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function newId(): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(12));
  return [...r].map((x) => a[x % a.length]).join("");
}

const nowIso = () => new Date().toISOString();

async function liveBySha(env: Env, vaultId: string, sha: string): Promise<AttachmentRow | null> {
  return env.DB.prepare("SELECT * FROM attachments WHERE vault_id = ? AND sha256 = ? AND state != 'deleting'").bind(vaultId, sha).first<AttachmentRow>();
}

/** Record that `key` must be deleted (durable; survives the row, the vault and the user). */
async function tombstone(env: Env, key: string, reason: string, notBeforeMs = 0): Promise<void> {
  const ts = nowIso();
  await env.DB.prepare(
    "INSERT INTO r2_cleanup (r2_key, reason, not_before, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (r2_key) DO UPDATE SET not_before = MAX(not_before, excluded.not_before)",
  )
    .bind(key, reason, new Date(Date.now() + notBeforeMs).toISOString(), ts)
    .run();
}

/** Delete an object that has no row: tombstone first, drop the tombstone only once R2 acknowledges. */
async function deleteOrphan(env: Env, key: string, reason: string): Promise<void> {
  await tombstone(env, key, reason);
  try {
    await env.FILES?.delete(key);
    await env.DB.prepare("DELETE FROM r2_cleanup WHERE r2_key = ? AND not_before <= ?").bind(key, nowIso()).run();
  } catch {
    // the sweeper retries it
  }
}

/** Move a pending row to 'deleting' (still charged) so the object is cleaned up before the charge is released. */
async function claimPending(env: Env, id: string, olderThan?: string): Promise<AttachmentRow | null> {
  return env.DB.prepare(
    `UPDATE attachments SET state = 'deleting', updated_at = ?1 WHERE id = ?2 AND state = 'pending'${olderThan ? " AND updated_at < ?3" : ""} RETURNING *`,
  )
    .bind(nowIso(), id, ...(olderThan ? [olderThan] : []))
    .first<AttachmentRow>();
}

/** Drop a 'deleting' row and release its charge together, after its object is gone (idempotent). */
async function settleDeleted(env: Env, row: Pick<AttachmentRow, "id" | "user_id" | "bytes">): Promise<void> {
  // The file's kept text (extract_bytes, read from the row itself) is released with it.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET bytes_used = MAX(0, bytes_used - ?1 - COALESCE((SELECT extract_bytes FROM attachments WHERE id = ?3 AND state = 'deleting'), 0)) WHERE id = ?2 AND EXISTS (SELECT 1 FROM attachments WHERE id = ?3 AND state = 'deleting')",
    ).bind(charge(row.bytes), row.user_id, row.id),
    env.DB.prepare("DELETE FROM attachment_texts WHERE attachment_id = ? AND EXISTS (SELECT 1 FROM attachments WHERE id = ? AND state = 'deleting')").bind(
      row.id,
      row.id,
    ),
    env.DB.prepare("DELETE FROM attachments WHERE id = ? AND state = 'deleting'").bind(row.id),
  ]);
}

export async function putAttachment(
  env: Env,
  vault: Vault,
  input: {
    bytes: Uint8Array;
    name?: string;
    mime?: string;
    source: "upload" | "email" | "url" | "mcp" | "import";
    caption?: boolean;
    /** An import storing this file provisionally: the row is owned by that job until it commits. */
    importJob?: string;
  },
): Promise<PutResult> {
  const files = env.FILES;
  if (!files) return { ok: false, code: "UNAVAILABLE", message: "Attachments are not configured on this server (no FILES R2 binding)." };
  const size = input.bytes.byteLength;
  if (!size) return { ok: false, code: "INVALID", message: "Empty file." };
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, code: "TOO_LARGE", message: `File is ${size} bytes; the limit is ${MAX_ATTACHMENT_BYTES} (10 MB).` };
  const mime = sniffMime(input.bytes, input.mime, input.name ?? "");
  const name = safeName(input.name, mime);
  const sha = await sha256Hex(input.bytes);
  const found = (r: AttachmentRow): PutResult => ({
    ok: true,
    attachment: r,
    url: fileUrl(vault.name, r.id),
    markdown: attachmentMarkdown(vault.name, r),
    created: false,
  });
  const settled = async (): Promise<PutResult | null> => {
    // The same content already stored or being stored: success only once it is ready.
    for (let i = 0; ; i++) {
      const r = await liveBySha(env, vault.id, sha);
      if (!r) return null;
      if (r.state === "ready") {
        // Reusing a file an import hasn't committed yet adopts it, so that import's rollback can't
        // delete it. Adoption and rollback are both conditional on the row: whichever lands first
        // wins; if rollback won, the row is being deleted and this upload stores its own copy.
        if (r.import_job && r.import_job !== input.importJob) {
          const adopted = await env.DB.prepare("UPDATE attachments SET import_job = NULL WHERE id = ? AND state = 'ready' RETURNING id").bind(r.id).first();
          if (!adopted) continue;
        }
        return found(r);
      }
      if (i >= DEDUPE_WAIT.tries) return { ok: false, code: "BUSY", message: "The same file is being stored right now. Try again in a moment." };
      await new Promise((res) => setTimeout(res, DEDUPE_WAIT.ms));
    }
  };
  const existing = await settled();
  if (existing) return existing;

  const owner = vault.owner_id;
  const id = newId();
  const key = `${vault.id}/${sha}.${id}.${extFor(mime)}`;
  const ts = nowIso();
  // Row and charge in one transaction; refused when over quota or file count, or the account is being deleted.
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attachments (id, user_id, vault_id, sha256, r2_key, name, mime, bytes, caption, source, state, created_at, updated_at, import_job)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, 'pending', ?10, ?10, ?14
       WHERE (SELECT deleting_at IS NULL AND disabled_at IS NULL AND bytes_used + import_staged_bytes + ?11 <= ?12 FROM users WHERE id = ?2) = 1
         AND (SELECT COUNT(*) FROM attachments WHERE user_id = ?2 AND state != 'deleting') < ?13
       ON CONFLICT (vault_id, sha256) WHERE state != 'deleting' DO NOTHING`,
    ).bind(id, owner, vault.id, sha, key, name, mime, size, input.source, ts, charge(size), LIMITS.userBytes, MAX_ATTACHMENTS, input.importJob ?? null),
    env.DB.prepare(
      "UPDATE users SET bytes_used = bytes_used + ?1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM attachments WHERE id = ?3 AND state = 'pending')",
    ).bind(charge(size), owner, id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE id = ?").bind(id),
  ]);
  if (!(res[2].results as { n: number }[])[0]?.n) {
    const raced = await settled();
    if (raced) return raced;
    return {
      ok: false,
      code: "QUOTA",
      message: `This account's storage limit (${LIMITS.userBytes} bytes, 50 MB, notes and attachments, ${ATTACHMENT_OVERHEAD} bytes per file) or file limit (${MAX_ATTACHMENTS} files) would be exceeded.`,
    };
  }
  try {
    await files.put(key, input.bytes, { httpMetadata: { contentType: mime }, customMetadata: { id } });
  } catch (e) {
    // The put may or may not have landed. Keep the row (charged) as 'deleting' until R2 confirms the
    // object is gone; if the delete fails too, the sweeper finishes it. Never drop the record first.
    const claimed = await claimPending(env, id).catch(() => null);
    if (claimed) await finishDelete(env, claimed).catch(() => {});
    else await deleteOrphan(env, key, "put-failed").catch(() => {});
    throw e;
  }
  const caption = input.caption !== false && isInlineImage(mime) ? await captionImage(env, owner, input.bytes, mime, name) : null;
  // Its text is read afterwards (extractAttachment: right away by the caller, else the queue).
  const ex = initialExtract(mime);
  const done = await env.DB.prepare(
    "UPDATE attachments SET state = 'ready', caption = ?, updated_at = ?, extract_state = ?, extract_error = ? WHERE id = ? AND state = 'pending'",
  )
    .bind(caption, nowIso(), ex.state, ex.error, id)
    .run();
  if (!done.meta.changes) {
    // The row was purged (account deletion) or claimed by the sweeper while we worked: our object
    // has no row now, so delete it under a durable cleanup record.
    await deleteOrphan(env, key, "finalize-lost").catch(() => {});
    return { ok: false, code: "UNAVAILABLE", message: "The project was removed while the file was being stored." };
  }
  const ready: AttachmentRow = {
    id,
    user_id: owner,
    vault_id: vault.id,
    sha256: sha,
    r2_key: key,
    name,
    mime,
    bytes: size,
    caption,
    source: input.source,
    state: "ready",
    import_job: input.importJob ?? null,
    extract_state: ex.state,
    extract_error: ex.error,
    extract_after: null,
    extract_tries: 0,
    extract_pages: null,
    extract_bytes: 0,
    extract_at: null,
    created_at: ts,
    updated_at: ts,
  };
  return { ok: true, attachment: ready, url: fileUrl(vault.name, id), markdown: attachmentMarkdown(vault.name, ready), created: true };
}

export async function getAttachment(env: Env, vault: Vault, id: string): Promise<AttachmentRow | null> {
  if (!/^[a-z0-9]{12}$/.test(id)) return null;
  return env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND vault_id = ? AND state = 'ready'").bind(id, vault.id).first<AttachmentRow>();
}

/** The newest 1,000 ready files (the Files page). Export reads all of them with readyAttachments(). */
export async function listAttachments(env: Env, vault: Vault): Promise<AttachmentRow[]> {
  return (
    await env.DB.prepare("SELECT * FROM attachments WHERE vault_id = ? AND state = 'ready' ORDER BY created_at DESC LIMIT 1000")
      .bind(vault.id)
      .all<AttachmentRow>()
  ).results;
}

/** Every ready file in a project, in pages (keyset on id). */
export async function* readyAttachments(env: Env, vault: Vault, pageSize = 500): AsyncGenerator<AttachmentRow> {
  let after = "";
  for (;;) {
    const page = (
      await env.DB.prepare("SELECT * FROM attachments WHERE vault_id = ? AND state = 'ready' AND id > ? ORDER BY id LIMIT ?")
        .bind(vault.id, after, pageSize)
        .all<AttachmentRow>()
    ).results;
    for (const r of page) yield r;
    if (page.length < pageSize) return;
    after = page[page.length - 1].id;
  }
}

/** Delete a file. True once it is no longer served; the charge is released when R2 confirms (else the sweeper retries). */
export async function deleteAttachment(env: Env, vault: Vault, id: string): Promise<boolean> {
  if (!/^[a-z0-9]{12}$/.test(id)) return false;
  const marked = await env.DB.prepare("UPDATE attachments SET state = 'deleting', updated_at = ? WHERE id = ? AND vault_id = ? AND state = 'ready' RETURNING *")
    .bind(nowIso(), id, vault.id)
    .first<AttachmentRow>();
  if (!marked) return false;
  // Its text leaves the notes that kept a copy (search, read_note) before the file goes.
  await env.VAULT.getByName(vault.id)
    .dropFileText(vaultRef(vault), id)
    .catch(() => {});
  await finishDelete(env, marked).catch(() => {});
  return true;
}

async function finishDelete(env: Env, row: AttachmentRow): Promise<void> {
  await env.FILES?.delete(row.r2_key);
  await settleDeleted(env, row);
}

/**
 * Roll back an import's files: delete those it stored that are still its own (not adopted by
 * another operation, not committed). Each delete is conditional on the row still being owned by
 * the job and ready, so it can't race an adoption. Returns how many were removed.
 */
export async function releaseImportFiles(env: Env, vaultId: string, jobId: string): Promise<number> {
  let n = 0;
  const rows = (
    await env.DB.prepare("SELECT id FROM attachments WHERE vault_id = ? AND import_job = ? AND state = 'ready' LIMIT 500")
      .bind(vaultId, jobId)
      .all<{ id: string }>()
  ).results;
  for (const r of rows) {
    const claimed = await env.DB.prepare(
      "UPDATE attachments SET state = 'deleting', updated_at = ? WHERE id = ? AND import_job = ? AND state = 'ready' RETURNING *",
    )
      .bind(nowIso(), r.id, jobId)
      .first<AttachmentRow>();
    if (!claimed) continue;
    if (claimed.extract_state === "done")
      await env.VAULT.getByName(vaultId)
        .dropFileText({ id: vaultId, name: "", ownerId: claimed.user_id }, claimed.id)
        .catch(() => {});
    await finishDelete(env, claimed).catch(() => {}); // a failed R2 delete stays 'deleting' for the sweeper
    n++;
  }
  return n;
}

/** Commit an import's files: they are ordinary attachments from now on. */
export async function commitImportFiles(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare("UPDATE attachments SET import_job = NULL WHERE import_job = ?").bind(jobId).run();
}

/** How long an import's files may stay uncommitted before the sweeper settles them (the staging TTL). */
export const IMPORT_FILES_STALE_MS = 30 * 60e3;

/**
 * Recovery (nightly cron, and safe any time):
 * - stale 'pending' rows (an upload that died between charge and object) are first *claimed*
 *   (pending -> deleting, atomically), so a late finalize fails, then cleaned like any delete; a
 *   tombstone re-deletes the key after LATE_PUT_MS in case the old put lands later;
 * - 'deleting' rows: delete the object, then drop the row and release its charge;
 * - due r2_cleanup records: delete the object, then the record.
 * Bounded per run.
 */
export async function sweepAttachments(
  env: Env,
  opts: { now?: number; limit?: number } = {},
): Promise<{ rolledBack: number; deleted: number; orphans: number; importFiles: number }> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 200;
  const staleCutoff = new Date(now - STALE_MS).toISOString();
  let rolledBack = 0;
  let deleted = 0;
  let orphans = 0;
  const stale = (
    await env.DB.prepare("SELECT id FROM attachments WHERE state = 'pending' AND updated_at < ? ORDER BY updated_at LIMIT ?")
      .bind(staleCutoff, limit)
      .all<{ id: string }>()
  ).results;
  for (const s of stale) {
    const claimed = await claimPending(env, s.id, staleCutoff).catch(() => null);
    if (!claimed) continue; // finalized (or claimed) meanwhile: not ours to touch
    try {
      await tombstone(env, claimed.r2_key, "late-put", LATE_PUT_MS);
      await finishDelete(env, claimed);
      rolledBack++;
    } catch {
      // stays 'deleting'; retried below on a later run
    }
  }
  const deleting = (
    await env.DB.prepare("SELECT * FROM attachments WHERE state = 'deleting' AND updated_at < ? ORDER BY updated_at LIMIT ?")
      .bind(new Date(now - 60e3).toISOString(), limit)
      .all<AttachmentRow>()
  ).results;
  for (const r of deleting) {
    try {
      await finishDelete(env, r);
      deleted++;
    } catch {
      // next run
    }
  }
  // Files of imports that never committed (the uploader died, or the job was aborted): settle by
  // the job's state in the directory. A job that started (running/done) commits them; one that
  // didn't (staging past its TTL, aborted, or gone) has its still-owned files deleted.
  let importFiles = 0;
  const owned = (
    await env.DB.prepare(
      "SELECT DISTINCT a.import_job AS job, a.vault_id AS vault_id, j.status AS status FROM attachments a LEFT JOIN import_jobs j ON j.id = a.import_job WHERE a.import_job IS NOT NULL AND a.state = 'ready' AND a.created_at < ? LIMIT ?",
    )
      .bind(new Date(now - IMPORT_FILES_STALE_MS).toISOString(), limit)
      .all<{ job: string; vault_id: string; status: string | null }>()
  ).results;
  for (const o of owned) {
    try {
      if (o.status === "running" || o.status === "done") await commitImportFiles(env, o.job);
      else importFiles += await releaseImportFiles(env, o.vault_id, o.job);
    } catch {
      // next run
    }
  }
  const due = (
    await env.DB.prepare("SELECT r2_key, not_before FROM r2_cleanup WHERE not_before <= ? ORDER BY not_before LIMIT ?")
      .bind(new Date(now).toISOString(), limit)
      .all<{ r2_key: string; not_before: string }>()
  ).results;
  for (const t of due) {
    try {
      await env.FILES?.delete(t.r2_key);
      await env.DB.prepare("DELETE FROM r2_cleanup WHERE r2_key = ? AND not_before = ?").bind(t.r2_key, t.not_before).run();
      orphans++;
    } catch {
      // next run
    }
  }
  return { rolledBack, deleted, orphans, importFiles };
}

/**
 * Account deletion: the rows first (so an upload in flight finds its row gone and removes its own
 * object), then every R2 object under `<vaultId>/`, orphans included. Idempotent.
 */
export async function purgeVaultAttachments(env: Env, vaultId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments WHERE vault_id = ?").bind(vaultId),
    env.DB.prepare("DELETE FROM attachment_texts WHERE vault_id = ?").bind(vaultId),
    env.DB.prepare("DELETE FROM upload_tickets WHERE vault_id = ?").bind(vaultId),
  ]);
  if (env.FILES) {
    let cursor: string | undefined;
    do {
      const page = await env.FILES.list({ prefix: `${vaultId}/`, cursor, limit: 1000 });
      if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

/** "attachments: …" lines for the /app/files links in a note (read_note). */
export async function describeAttachments(env: Env, vault: Vault, content: string, origin: string): Promise<string[]> {
  const ids = [...new Set([...content.matchAll(/\/app\/files\/[^/\s)]+\/([a-z0-9]{12})/g)].map((m) => m[1]))].slice(0, 50);
  if (!ids.length) return [];
  const rows = (
    await env.DB.prepare(`SELECT * FROM attachments WHERE vault_id = ? AND state = 'ready' AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(vault.id, ...ids)
      .all<AttachmentRow>()
  ).results;
  return rows.map(
    (a) =>
      `- ${a.name} (${a.mime}, ${Math.ceil(a.bytes / 1024)} KB)${a.caption ? `: ${a.caption}` : ""} — ${origin}${fileUrl(vault.name, a.id)}${extractNote(a)}`,
  );
}

/** " [text: …]" after a file in read_note: whether its text is searchable, and how to quote it or hand it over. */
export function extractNote(a: Pick<AttachmentRow, "id" | "extract_state" | "extract_error" | "extract_pages">): string {
  const more = `read_note file=${a.id}`;
  switch (a.extract_state) {
    case "done":
      return ` [text searchable${a.extract_pages ? `, ${a.extract_pages} page${a.extract_pages === 1 ? "" : "s"}` : ""}; ${more} for its text or a link for the user]`;
    case "pending":
      return ` [text pending${a.extract_error ? ` (${a.extract_error})` : ""}; ${more} for a link for the user]`;
    case "failed":
      return ` [text failed: ${a.extract_error ?? "unknown error"}; ${more} for a link for the user]`;
    case "none":
      return ` [no text${a.extract_error ? ` (${a.extract_error})` : ""}; ${more} for a link for the user]`;
    default:
      return ` [${more} for a link for the user]`;
  }
}

/** Attachment bytes for export (all of them, paginated), and a rewriter for links in notes `depth` folders deep. */
export async function exportAttachments(
  env: Env,
  vault: Vault,
): Promise<{ files: Record<string, Uint8Array>; rewrite: (content: string, depth: number) => string }> {
  const files: Record<string, Uint8Array> = {};
  const paths = new Map<string, string>();
  if (env.FILES) {
    for await (const r of readyAttachments(env, vault)) {
      const obj = await env.FILES.get(r.r2_key);
      if (!obj) continue;
      const p = `attachments/${r.id}-${r.name}`;
      files[p] = new Uint8Array(await obj.arrayBuffer());
      paths.set(r.id, p);
    }
  }
  // Any project segment: a note in a shared project may link a file as owner/name or by plain
  // name, depending on who attached it. Only this project's file ids (in `paths`) are rewritten.
  const re = /\/app\/files\/[^/\s)"']+\/([a-z0-9]{12})/g;
  return {
    files,
    rewrite: (content, depth) =>
      paths.size
        ? content.replace(re, (m, id: string) => {
            const p = paths.get(id);
            return p ? `${"../".repeat(depth)}${p.split("/").map(encodeURIComponent).join("/")}` : m;
          })
        : content,
  };
}

// ---------------------------------------------------------------- AI: captions

type AiRunner = { run(model: string, input: unknown): Promise<unknown> };

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A one-or-two sentence caption (for search) or null. Charged to the daily AI budget; usage recorded. */
export async function captionImage(env: Env, userId: string, bytes: Uint8Array, mime: string, name: string): Promise<string | null> {
  if (env.CAIRN_FAKE_CAPTURE_AI === "1") return `An image named ${name}.`;
  const model = env.VISION_MODEL ?? DEFAULT_VISION_MODEL;
  if (!model || !env.AI || bytes.byteLength > CAPTION_MAX_BYTES) return null;
  const estimate = 1600; // image tokens + prompt + up to 120 output tokens
  if (!(await spendAiBudget(env, userId, estimate).catch(() => false))) return null;
  const started = Date.now();
  let ok = false;
  let out: string | null = null;
  try {
    const run = (env.AI as unknown as AiRunner).run(model, {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe this image in one or two plain sentences for a search index: what it shows and any important visible text. No preamble.",
            },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64(bytes)}` } },
          ],
        },
      ],
      max_tokens: 120,
    });
    const r = (await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000))])) as {
      response?: string;
      choices?: { message?: { content?: string } }[];
    };
    const t = (r.response ?? r.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim();
    out = t ? t.slice(0, 400) : null;
    ok = !!out;
  } catch {
    out = null;
  }
  await recordAi(env.DB, {
    userId,
    model,
    purpose: "caption",
    ok,
    latencyMs: Date.now() - started,
    inputTokens: 1500,
    outputTokens: out ? Math.ceil(out.length / 4) : 0,
    estimated: true,
  }).catch(() => {});
  return out;
}
