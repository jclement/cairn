// Import a Basic Memory project or an Obsidian vault from a zip.
//
// Memory and storage safety (review of round 3b):
// - the request body is capped before it is parsed (Content-Length, see importer.ts);
// - the central directory is read without inflating anything: entry count, path safety and the
//   *declared* total are checked first;
// - each note is inflated through a streaming inflater with a hard cap on the *actual* output, and
//   the running total of actual output is capped too;
// - notes are read one at a time and staged in small batches; every batch's bytes (content and
//   metadata) are reserved atomically against the account before they are stored (see VaultDO).

import { commitImportFiles, isInlineImage, MAX_ATTACHMENT_BYTES, putAttachment, releaseImportFiles } from "./capture/files";
import type { Vault } from "./directory";
import { newId, vaultRef, vaultStub } from "./directory";
import type { Env } from "./env";
import { LIMITS } from "./env";
import { slugify, splitFrontmatter } from "./markdown/parse";
import { inflateEntry, MAX_PUSH_OUTPUT, readCentralDirectory, WorkMeter, type ZipEntry, ZipError } from "./zip";

export const IMPORT_LIMITS = {
  uploadBytes: 20 * 1024 * 1024,
  /** Whole multipart body (file + small fields). */
  requestBytes: 20 * 1024 * 1024 + 64 * 1024,
  entries: 5000,
  /** Declared and actual markdown, in total. Never more than an account may store anyway. */
  totalBytes: LIMITS.userBytes,
  stageBatchBytes: 1024 * 1024,
  stageBatchItems: 100,
  /** Outstanding (staging or running) import jobs per account. */
  outstandingJobs: 2,
  /** Import jobs an account may start per UTC day (report-only jobs included). */
  jobsPerDay: 20,
  /** Non-markdown files stored as attachments per import (each costs a few subrequests); the rest are reported. */
  attachments: 100,
  /** Notes whose frontmatter is peeked for Basic Memory's project prefix, and bytes per peek. */
  peekNotes: 200,
  peekBytes: 4096,
};

/** Inflation work allowed for one archive: the declared total, plus bounded peeks (each may overshoot by one push). */
export const newMeter = () => new WorkMeter(IMPORT_LIMITS.totalBytes + IMPORT_LIMITS.peekNotes * (IMPORT_LIMITS.peekBytes + MAX_PUSH_OUTPUT));

export type ImportSource = "obsidian" | "basic-memory";

export interface StagedItem {
  path: string;
  folder: string;
  title: string;
  content: string | null;
  status?: string;
  message?: string;
}

interface PlannedNote {
  entry: ZipEntry;
  path: string;
  folder: string;
  title: string;
}

interface PlannedFile {
  entry: ZipEntry;
  path: string;
}

export interface ImportPlan {
  source: ImportSource;
  /** Every byte inflated from this archive, peeks included. */
  meter: WorkMeter;
  notes: PlannedNote[];
  /** Reported, never read: unsafe paths, over-size notes and files, files over the per-import cap. */
  reported: StagedItem[];
  /** Non-markdown files to store as attachments (at most IMPORT_LIMITS.attachments, each within the file size cap). */
  files: PlannedFile[];
  /** Every non-markdown path in the archive (stored or not). */
  attachments: string[];
  ignored: number;
}

const IGNORED = /(^|\/)(\.obsidian|\.git|\.trash|__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)|(^|\/)\._/;

/** Why an archive path is unsafe, or null. Checked before anything else looks at the path. */
export function unsafePath(name: string): string | null {
  if (!name) return "empty path";
  if ([...name].some((ch) => ch.charCodeAt(0) < 0x20)) return "control character in path";
  if (name.includes("\\")) return "backslash in path";
  if (name.startsWith("/")) return "absolute path";
  if (/^[A-Za-z]:/.test(name)) return "drive letter in path";
  if (new TextEncoder().encode(name).length > 1024) return "path longer than 1024 bytes";
  const segs = name.replace(/\/$/, "").split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "empty, '.' or '..' segment in path";
  return null;
}

/** Plan from the central directory alone. Throws ZipError for archives that must be refused whole. */
export function planImport(zip: Uint8Array): ImportPlan {
  const entries = readCentralDirectory(zip, IMPORT_LIMITS.entries);
  const reported: StagedItem[] = [];
  const isObsidian = entries.some((e) => e.name.startsWith(".obsidian/") || e.name.includes("/.obsidian/"));
  const safe: ZipEntry[] = [];
  let ignored = 0;
  for (const e of entries) {
    if (e.isDir) continue;
    const why = unsafePath(e.name);
    if (why) {
      reported.push({ path: e.name.slice(0, 300), folder: "", title: "", content: null, status: "skipped", message: `rejected: ${why}` });
      continue;
    }
    if (IGNORED.test(e.name)) {
      ignored++;
      continue;
    }
    safe.push(e);
  }
  const tops = new Set(safe.map((e) => e.name.split("/")[0]));
  const wrapper = tops.size === 1 && safe.every((e) => e.name.includes("/")) ? [...tops][0] : null;
  const rel = (n: string) => (wrapper ? n.slice(wrapper.length + 1) : n);

  const notes: PlannedNote[] = [];
  const attachments: string[] = [];
  const files: PlannedFile[] = [];
  let declared = 0;
  for (const e of safe) {
    const path = rel(e.name);
    if (!/\.md$/i.test(path)) {
      attachments.push(path);
      const skip = (message: string) => reported.push({ path, folder: "", title: path, content: null, status: "skipped", message });
      if (e.size > MAX_ATTACHMENT_BYTES) skip(`attachment: larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB file limit`);
      else if (!e.size) skip("attachment: empty file");
      else if (files.length >= IMPORT_LIMITS.attachments)
        skip(`attachment: over ${IMPORT_LIMITS.attachments} files in one import; import the rest in another zip`);
      else {
        declared += e.size;
        files.push({ entry: e, path });
      }
      continue;
    }
    const parts = path.split("/");
    const file = parts.pop() as string;
    const folder = parts.join("/");
    const title = file.replace(/\.md$/i, "");
    if (e.size > LIMITS.noteBytes) {
      reported.push({ path, folder, title, content: null, status: "skipped", message: `larger than the ${LIMITS.noteBytes / 1024 / 1024} MB note limit` });
      continue;
    }
    declared += e.size;
    notes.push({ entry: e, path, folder, title });
  }
  if (declared > IMPORT_LIMITS.totalBytes) throw new ZipError(`the files in this zip add up to more than ${IMPORT_LIMITS.totalBytes / 1024 / 1024} MB`);
  return { source: isObsidian ? "obsidian" : "basic-memory", meter: newMeter(), notes, reported, files, attachments, ignored };
}

/** Basic Memory writes "<project>/<path>" permalinks; detect the shared prefix by peeking at frontmatter only. */
export function detectPrefix(zip: Uint8Array, plan: ImportPlan): string | null {
  const firsts = new Map<string, number>();
  let withPermalink = 0;
  // A bounded sample: the first peekNotes notes, PEEK bytes each, charged to the archive's meter.
  // An entry that fails here (corrupt, larger than it claims) fails the whole archive.
  for (const n of plan.notes.slice(0, IMPORT_LIMITS.peekNotes)) {
    const head = new TextDecoder().decode(inflateEntry(zip, n.entry, Math.min(IMPORT_LIMITS.peekBytes, n.entry.size), plan.meter, true));
    const m = /^---\r?\n[\s\S]*?^permalink:\s*["']?\/?([^\s"'/]+)\//m.exec(head);
    if (!m) continue;
    withPermalink++;
    firsts.set(m[1], (firsts.get(m[1]) ?? 0) + 1);
  }
  const topFolders = new Set(plan.notes.map((n) => slugify(n.folder.split("/")[0] ?? "")).filter(Boolean));
  for (const [s, count] of firsts) if (withPermalink && count / withPermalink >= 0.8 && !topFolders.has(slugify(s))) return s;
  return null;
}

/**
 * Read notes one at a time. Each is inflated with output capped at its *declared* size (which
 * planImport already summed and capped), so an entry that expands beyond its claim, or is corrupt,
 * throws ZipError and stops the whole archive; all work is charged to the archive's meter.
 */
export function* readNotes(zip: Uint8Array, plan: ImportPlan, prefix: string | null, links?: AttachmentLinks): Generator<StagedItem> {
  const re = prefix ? new RegExp(`^(permalink:\\s*["']?)/?${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "m") : null;
  for (const n of plan.notes) {
    const bytes = inflateEntry(zip, n.entry, Math.min(n.entry.size, LIMITS.noteBytes), plan.meter);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      yield { path: n.path, folder: n.folder, title: n.title, content: null, status: "skipped", message: "not valid UTF-8 text" };
      continue;
    }
    if (re) {
      const fm = splitFrontmatter(content);
      if (fm.raw !== null) content = content.slice(0, content.length - fm.body.length).replace(re, "$1") + fm.body;
    }
    if (links?.byPath.size) content = rewriteAttachmentLinks(content, n.folder, links);
    yield { path: n.path, folder: n.folder, title: n.title, content };
  }
}

// ---------- attachments ----------

export interface StoredFile {
  url: string;
  name: string;
  inline: boolean;
}

/** Where the archive's files went: by archive path, and by file name when that name is unique. */
export interface AttachmentLinks {
  byPath: Map<string, StoredFile>;
  byName: Map<string, StoredFile | null>;
}

export function attachmentLinks(stored: [string, StoredFile][]): AttachmentLinks {
  const byPath = new Map<string, StoredFile>();
  const byName = new Map<string, StoredFile | null>();
  for (const [path, f] of stored) {
    byPath.set(path.toLowerCase(), f);
    const name = (path.split("/").pop() ?? "").toLowerCase();
    byName.set(name, byName.has(name) && byName.get(name)?.url !== f.url ? null : f);
  }
  return { byPath, byName };
}

function joinPath(folder: string, rel: string): string | null {
  const out = folder ? folder.split("/").filter(Boolean) : [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** A link target as the note wrote it, resolved like Obsidian: relative to the note, then to the root, then by unique file name. */
function resolveFile(target: string, folder: string, links: AttachmentLinks): StoredFile | null {
  const t = target.trim();
  if (!t || /\.md$/i.test(t)) return null;
  for (const p of [joinPath(folder, t), joinPath("", t)]) {
    const hit = p ? links.byPath.get(p.toLowerCase()) : undefined;
    if (hit) return hit;
  }
  return links.byName.get((t.split("/").pop() ?? "").toLowerCase()) ?? null;
}

const WIKI_FILE_RE = /(!?)\[\[([^\]\n|#]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
// A destination may hold one level of balanced parentheses ("photo%20(1).png"), as CommonMark allows.
const MD_FILE_RE = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|(?:[^()\s]|\([^()\s]*\))+)(\s+"[^"\n]*")?\s*\)/g;
const baseName = (p: string) => p.split("/").pop() ?? p;
const label = (s: string) => s.replace(/[[\]\n\r]/g, " ").trim();

function rewriteSpan(text: string, folder: string, links: AttachmentLinks): string {
  const embed = (f: StoredFile, alt: string) => (f.inline ? `![${label(alt)}](${f.url})` : `[${label(alt)}](${f.url})`);
  return text
    .replace(WIKI_FILE_RE, (m, _bang: string, target: string, alias?: string) => {
      const f = resolveFile(target, folder, links);
      if (!f) return m;
      // "|300" on an image is a display size, not a label.
      const alt = alias && !/^\d+(x\d+)?$/.test(alias.trim()) ? alias : baseName(target.trim());
      return embed(f, alt);
    })
    .replace(MD_FILE_RE, (m, bang: string, text: string, rawHref: string) => {
      const raw = rawHref.startsWith("<") ? rawHref.slice(1, -1) : rawHref;
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/") || raw.startsWith("#")) return m;
      const decode = (x: string) => {
        try {
          return decodeURIComponent(x);
        } catch {
          return null;
        }
      };
      // The name as written first ("budget #3.pdf" in <...>), then without a ?query or #fragment.
      let href = "";
      let f: StoredFile | null = null;
      for (const cand of [raw, raw.replace(/[?#].*$/, "")]) {
        const d = decode(cand);
        if (!d) continue;
        f = resolveFile(d, folder, links);
        if (f) {
          href = d;
          break;
        }
      }
      if (!f) return m;
      const alt = label(text) || baseName(href);
      return bang && f.inline ? `![${alt}](${f.url})` : `[${alt}](${f.url})`;
    });
}

/**
 * Point a note's links to archive files at their stored attachments: `![[img.png]]`,
 * `![[img.png|300]]`, `[[doc.pdf]]`, `![](img.png)`, `[x](../files/doc%20v2.pdf)`. Code blocks and
 * inline code are left alone, and so is anything that isn't a file from this archive.
 */
export function rewriteAttachmentLinks(content: string, folder: string, links: AttachmentLinks): string {
  const lines = content.split("\n");
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(```+|~~~+)/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence || (!lines[i].includes("[") && !lines[i].includes("]"))) continue;
    // Inline code spans stay as written: rewrite only the text between them.
    lines[i] = lines[i]
      .split(/(`+[^`]*`+)/)
      .map((part) => (part.startsWith("`") ? part : rewriteSpan(part, folder, links)))
      .join("");
  }
  return lines.join("\n");
}

/**
 * Store the archive's files as attachments of `vault` (through putAttachment: type sniffing and
 * allowlist, 10 MB per file, the per-account file count and storage quota, which counts imports
 * being staged). Same content already stored is reused. Returns the links for rewriting and a
 * report row per file.
 */
export async function storeArchiveFiles(
  env: Env,
  vault: Vault,
  zip: Uint8Array,
  plan: ImportPlan,
  jobId: string,
): Promise<{ links: AttachmentLinks; report: StagedItem[]; created: string[] }> {
  const stored: [string, StoredFile][] = [];
  const report: StagedItem[] = [];
  const created: string[] = [];
  try {
    await storeEach();
  } catch (e) {
    // A corrupt entry stops the whole archive: take back the files this import still owns (not
    // ones another upload has since reused: see releaseImportFiles).
    await releaseImportFiles(env, vault.id, jobId).catch(() => {});
    throw e;
  }
  return { links: attachmentLinks(stored), report, created };

  async function storeEach() {
    for (const f of plan.files) {
      const name = f.path.split("/").pop() ?? f.path;
      const bytes = inflateEntry(zip, f.entry, Math.min(f.entry.size, MAX_ATTACHMENT_BYTES), plan.meter);
      let r: Awaited<ReturnType<typeof putAttachment>>;
      try {
        r = await putAttachment(env, vault, { bytes, name, source: "import", caption: false, importJob: jobId });
      } catch (e) {
        report.push({ path: f.path, folder: "", title: name, content: null, status: "failed", message: `attachment: ${(e as Error).message}` });
        continue;
      }
      if (!r.ok) {
        report.push({ path: f.path, folder: "", title: name, content: null, status: "skipped", message: `attachment: ${r.code}: ${r.message}` });
        continue;
      }
      if (r.created) created.push(r.attachment.id);
      stored.push([f.path, { url: r.url, name: r.attachment.name, inline: isInlineImage(r.attachment.mime) }]);
      report.push({ path: f.path, folder: "", title: name, content: null, status: "attached", message: r.url });
    }
  }
}

/** Everything at once: for tests and small archives. */
export function prepareImport(zip: Uint8Array) {
  const plan = planImport(zip);
  const strippedPrefix = detectPrefix(zip, plan);
  const items = [...readNotes(zip, plan, strippedPrefix), ...plan.reported.filter((r) => !r.message?.startsWith("attachment"))];
  return { source: plan.source, items, attachments: plan.attachments, ignored: plan.ignored, strippedPrefix };
}

/** Bytes an item occupies while staged (content and metadata). */
export const stagedBytes = (it: StagedItem) =>
  64 + [it.content ?? "", it.path, it.folder, it.title, it.message ?? ""].reduce((n, x) => n + new TextEncoder().encode(x).length, 0);

export type StartResult = { ok: true; job: string; strippedPrefix: string | null } | { ok: false; status: 400 | 413 | 429; error: string };

/** Plan, register the job (outstanding cap), stream notes into the vault DO in reserved batches, start. */
export async function startImport(env: Env, vault: Vault, user: { id: string; username: string }, zip: Uint8Array, overwrite: boolean): Promise<StartResult> {
  // The directory only (nothing inflated) before admission; inflation starts after the job is admitted.
  let plan: ImportPlan;
  try {
    plan = planImport(zip);
  } catch (e) {
    return { ok: false, status: 400, error: `Couldn't read that zip: ${(e as Error).message}` };
  }
  if (!plan.notes.length && !plan.reported.length && !plan.files.length) return { ok: false, status: 400, error: "No markdown files found in that zip." };
  const id = newId();
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  // Admission, one transaction: at most `outstandingJobs` in progress and `jobsPerDay` started today.
  const reg = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO import_jobs (id, user_id, vault_id, status, staged_bytes, created_at)
       SELECT ?1, ?2, ?3, 'staging', 0, ?4
       WHERE (SELECT COUNT(*) FROM import_jobs WHERE user_id = ?2 AND status IN ('staging', 'running')) < ?5
         AND COALESCE((SELECT jobs FROM import_daily WHERE user_id = ?2 AND day = ?6), 0) < ?7`,
    ).bind(id, user.id, vault.id, ts, IMPORT_LIMITS.outstandingJobs, day, IMPORT_LIMITS.jobsPerDay),
    env.DB.prepare(
      `INSERT INTO import_daily (user_id, day, notes, jobs) SELECT ?1, ?2, 0, 1 WHERE EXISTS (SELECT 1 FROM import_jobs WHERE id = ?3)
       ON CONFLICT (user_id, day) DO UPDATE SET jobs = jobs + 1`,
    ).bind(user.id, day, id),
  ]);
  if (!(reg[0].meta.changes ?? 0)) {
    return {
      ok: false,
      status: 429,
      error: `You can have ${IMPORT_LIMITS.outstandingJobs} imports in progress and start ${IMPORT_LIMITS.jobsPerDay} a day. Wait for one to finish, or try tomorrow.`,
    };
  }
  const job = { id, source: plan.source, userId: user.id, username: user.username, overwrite };
  const stub = vaultStub(env, vault);
  const ref = vaultRef(vault);
  const fail = async (status: 400 | 413, error: string): Promise<StartResult> => {
    await stub.importAbort(ref, id).catch(() => {});
    return { ok: false, status, error };
  };
  let prefix: string | null;
  try {
    prefix = detectPrefix(zip, plan);
  } catch (e) {
    return await fail(400, `Couldn't read that zip: ${(e as Error).message}`);
  }
  // Files first, so notes can point at them; the quota check counts this import's staged notes too.
  let files: Awaited<ReturnType<typeof storeArchiveFiles>>;
  try {
    files = await storeArchiveFiles(env, vault, zip, plan, id);
  } catch (e) {
    return await fail(400, `Couldn't read that zip: ${(e as Error).message}`);
  }
  // Files stay owned by this job until it starts. Rolling back deletes only the ones still owned
  // (another upload that reused one has adopted it); if this request dies first, the nightly sweep
  // settles them by the job's state (sweepAttachments).
  const failAndClean = async (status: 400 | 413, error: string): Promise<StartResult> => {
    await releaseImportFiles(env, vault.id, id).catch(() => {});
    return fail(status, error);
  };
  let batch: StagedItem[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return null;
    const r = await stub.importStage(ref, job, batch);
    batch = [];
    size = 0;
    return r.ok ? null : r.error;
  };
  try {
    for (const it of [...plan.reported, ...files.report]) {
      batch.push(it);
      size += stagedBytes(it);
      if (size >= IMPORT_LIMITS.stageBatchBytes || batch.length >= IMPORT_LIMITS.stageBatchItems) {
        const err = await flush();
        if (err) return await failAndClean(413, err);
      }
    }
    for (const it of readNotes(zip, plan, prefix, files.links)) {
      batch.push(it);
      size += stagedBytes(it);
      if (size >= IMPORT_LIMITS.stageBatchBytes || batch.length >= IMPORT_LIMITS.stageBatchItems) {
        const err = await flush();
        if (err) return await failAndClean(413, err);
      }
    }
    const err = await flush();
    if (err) return await failAndClean(413, err);
  } catch (e) {
    return await failAndClean(400, `Couldn't read that zip: ${(e as Error).message}`);
  }
  try {
    await stub.importStart(ref, id);
  } catch (e) {
    return await failAndClean(400, `Couldn't start the import: ${(e as Error).message}`);
  }
  // The job runs now: its files are ordinary attachments. (If this write fails, the sweep commits
  // them, since the job is running.)
  await commitImportFiles(env, id).catch(() => {});
  return { ok: true, job: id, strippedPrefix: prefix };
}
