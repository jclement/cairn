// Links that work without signing in, for handing files to and from agents.
//
// - Signed download links (/files/s/<token>): an HMAC over (vault id, attachment id, expiry) with a
//   per-instance key Cairn generates once and keeps in D1 (site_settings 'file_link_key'; there was no
//   existing signing secret). Serving checks the signature, the expiry, and that the file is still
//   ready in that vault, so a link dies with its file and can't name another vault's file.
// - One-time upload URLs (/files/upload/<token>): a random token whose hash is a row in
//   upload_tickets, bound to a user and a vault; single use, 15 minutes, 10 MB.

import { canWriteVault, listVaults, type Vault } from "../directory";
import { type Env, publicOrigin } from "../env";
import { type AttachmentRow, MAX_ATTACHMENT_BYTES, putAttachment } from "./files";

export const LINK_TTL_S = 3600;
export const UPLOAD_TTL_MS = 15 * 60e3;
/** Open upload tickets one user may hold. */
export const UPLOAD_TICKETS_OPEN_MAX = 20;

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

let cachedKey: { raw: string; key: CryptoKey } | null = null;

async function linkKey(env: Env): Promise<CryptoKey> {
  let row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'file_link_key'").first<{ value: string }>();
  if (!row) {
    const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('file_link_key', ?, ?) ON CONFLICT (key) DO NOTHING")
      .bind(fresh, new Date().toISOString())
      .run();
    row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'file_link_key'").first<{ value: string }>();
  }
  const raw = row?.value as string;
  if (cachedKey?.raw === raw) return cachedKey.key;
  const key = await crypto.subtle.importKey("raw", unb64url(raw) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  cachedKey = { raw, key };
  return key;
}

/** A link to download one file without signing in, valid `ttlS` seconds. */
export async function signedFileUrl(
  env: Env,
  vaultId: string,
  attachmentId: string,
  ttlS = LINK_TTL_S,
  nowMs = Date.now(),
): Promise<{ url: string; expires: string }> {
  const exp = Math.floor(nowMs / 1000) + ttlS;
  const payload = `${vaultId}.${attachmentId}.${exp}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await linkKey(env), new TextEncoder().encode(payload)));
  return { url: `${publicOrigin(env)}/files/s/${b64url(new TextEncoder().encode(payload))}.${b64url(sig)}`, expires: new Date(exp * 1000).toISOString() };
}

/** The file a signed link names, if the signature is good, it hasn't expired and the file is still there. */
export async function resolveSignedLink(env: Env, token: string, nowMs = Date.now()): Promise<AttachmentRow | null> {
  const m = /^([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  let payload: string;
  let sig: Uint8Array;
  try {
    payload = new TextDecoder().decode(unb64url(m[1]));
    sig = unb64url(m[2]);
  } catch {
    return null;
  }
  const p = /^([A-Za-z0-9_-]{1,64})\.([a-z0-9]{12})\.(\d{1,12})$/.exec(payload);
  if (!p) return null;
  const ok = await crypto.subtle.verify("HMAC", await linkKey(env), sig as Uint8Array<ArrayBuffer>, new TextEncoder().encode(payload));
  if (!ok || Number(p[3]) * 1000 < nowMs) return null;
  return env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND vault_id = ? AND state = 'ready'").bind(p[2], p[1]).first<AttachmentRow>();
}

// ---------------------------------------------------------------- upload tickets

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export interface UploadTicket {
  id: string;
  user_id: string;
  vault_id: string;
  filename: string | null;
  mime: string | null;
  note: string | null;
  max_bytes: number;
  state: "open" | "uploading" | "uploaded" | "done" | "failed";
  attachment_id: string | null;
  created_at: string;
  expires_at: string;
}

/** A one-time upload URL for `vault` (the caller must be able to write it). */
export async function createUploadTicket(
  env: Env,
  userId: string,
  vault: Vault,
  opts: { filename?: string; mime?: string; note?: string },
): Promise<{ ok: true; ref: string; upload_url: string; expires: string } | { ok: false; code: string; message: string }> {
  if (!env.FILES) return { ok: false, code: "UNAVAILABLE", message: "Attachments are not configured on this server (no FILES R2 binding)." };
  const now = new Date();
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = `up_${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  const expires = new Date(now.getTime() + UPLOAD_TTL_MS).toISOString();
  const r = await env.DB.prepare(
    `INSERT INTO upload_tickets (id, token_hash, user_id, vault_id, filename, mime, note, max_bytes, state, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?10
     WHERE (SELECT COUNT(*) FROM upload_tickets WHERE user_id = ?3 AND state IN ('open', 'uploading') AND expires_at > ?9) < ?11`,
  )
    .bind(
      id,
      await sha256Hex(token),
      userId,
      vault.id,
      opts.filename?.slice(0, 200) ?? null,
      opts.mime?.slice(0, 100) ?? null,
      opts.note?.slice(0, 500) ?? null,
      MAX_ATTACHMENT_BYTES,
      now.toISOString(),
      expires,
      UPLOAD_TICKETS_OPEN_MAX,
    )
    .run();
  if (!r.meta.changes)
    return { ok: false, code: "RATE_LIMITED", message: `You have ${UPLOAD_TICKETS_OPEN_MAX} upload URLs open; use or let them expire (15 minutes).` };
  return { ok: true, ref: id, upload_url: `${publicOrigin(env)}/files/upload/${token}`, expires };
}

/** Read a request body up to `max` bytes; null when it is larger. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** PUT /files/upload/<token>: store the bytes as an attachment of the ticket's vault. Single use. */
export async function handleUpload(env: Env, req: Request, token: string): Promise<Response> {
  const j = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (req.method !== "PUT") return j(405, { error: "PUT the file's raw bytes to this URL." });
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return j(404, { error: "No such upload URL." });
  const now = new Date().toISOString();
  // Claimed before the body is read: a second PUT of the same URL finds nothing.
  const t = await env.DB.prepare("UPDATE upload_tickets SET state = 'uploading' WHERE token_hash = ? AND state = 'open' AND expires_at > ? RETURNING *")
    .bind(await sha256Hex(token), now)
    .first<UploadTicket>();
  if (!t) return j(404, { error: "This upload URL is unknown, used or expired. Ask attach_file for a new one (upload=true)." });
  const fail = async (status: number, code: string, error: string) => {
    await env.DB.prepare("UPDATE upload_tickets SET state = 'failed' WHERE id = ?").bind(t.id).run();
    return j(status, { error, code });
  };
  if (Number(req.headers.get("content-length") ?? 0) > t.max_bytes) return fail(413, "TOO_LARGE", `The file is larger than ${t.max_bytes / 1024 / 1024} MB.`);
  const bytes = await readCapped(req, t.max_bytes);
  if (!bytes) return fail(413, "TOO_LARGE", `The file is larger than ${t.max_bytes / 1024 / 1024} MB.`);
  // Access is checked again now: a member removed since the URL was issued can't use it.
  const vault = (await listVaults(env, t.user_id)).find((v) => v.id === t.vault_id);
  if (!vault || !canWriteVault(vault)) return fail(404, "NOT_FOUND", "The project is gone or no longer writable by you.");
  const r = await putAttachment(env, vault, {
    bytes,
    name: t.filename ?? undefined,
    mime: t.mime ?? req.headers.get("content-type") ?? undefined,
    source: "mcp",
  });
  if (!r.ok) return fail(r.code === "TOO_LARGE" || r.code === "QUOTA" ? 413 : r.code === "UNAVAILABLE" ? 503 : 400, r.code, r.message);
  await env.DB.prepare("UPDATE upload_tickets SET state = 'uploaded', attachment_id = ? WHERE id = ? AND state = 'uploading'")
    .bind(r.attachment.id, t.id)
    .run();
  return j(201, { ok: true, ref: t.id, name: r.attachment.name, bytes: r.attachment.bytes, next: `Call attach_file with ref="${t.id}" to finish.` });
}

/** attach_file ref=…: the uploaded file, once (the ticket becomes 'done'). */
export async function finishUploadTicket(
  env: Env,
  userId: string,
  vault: Vault,
  ref: string,
): Promise<{ ok: true; ticket: UploadTicket; attachment: AttachmentRow } | { ok: false; code: string; message: string }> {
  const t = await env.DB.prepare("SELECT * FROM upload_tickets WHERE id = ? AND user_id = ? AND vault_id = ?")
    .bind(ref, userId, vault.id)
    .first<UploadTicket>();
  if (!t) return { ok: false, code: "NOT_FOUND", message: `No upload ${ref} for this project.` };
  if (t.state === "done") return { ok: false, code: "INVALID", message: "This upload was already finished." };
  if (t.state === "failed") return { ok: false, code: "INVALID", message: "This upload failed; ask for a new upload URL." };
  if (t.state === "open" || t.state === "uploading") {
    if (t.expires_at <= new Date().toISOString())
      return { ok: false, code: "INVALID", message: "This upload URL expired before the file arrived; ask for a new one." };
    return { ok: false, code: "INVALID", message: "The file hasn't arrived yet: PUT its bytes to the upload_url first." };
  }
  const claimed = await env.DB.prepare("UPDATE upload_tickets SET state = 'done' WHERE id = ? AND state = 'uploaded' RETURNING *")
    .bind(t.id)
    .first<UploadTicket>();
  if (!claimed?.attachment_id) return { ok: false, code: "INVALID", message: "This upload was already finished." };
  const a = await env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND vault_id = ? AND state = 'ready'")
    .bind(claimed.attachment_id, vault.id)
    .first<AttachmentRow>();
  if (!a) return { ok: false, code: "NOT_FOUND", message: "The uploaded file is gone." };
  return { ok: true, ticket: claimed, attachment: a };
}

/** Nightly: forget tickets a day past expiry. */
export async function sweepUploadTickets(env: Env, nowMs = Date.now()): Promise<number> {
  const r = await env.DB.prepare("DELETE FROM upload_tickets WHERE expires_at < ?")
    .bind(new Date(nowMs - 86400e3).toISOString())
    .run();
  return r.meta.changes ?? 0;
}
