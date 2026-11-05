// Email capture: Cloudflare Email Routing delivers mail for INBOUND_EMAIL_ADDRESS to the Worker's
// email() handler; each message becomes a note in the user's default project under inbox/.
//
// Who is it for? One of, in order:
//  (a) the recipient carries the user's inbox key as a subaddress: cairn+<key>@domain (works only
//      if the zone has subaddressing enabled in Email Routing);
//  (b) the subject starts with [k:<key>];
//  (c) the From address is on exactly one user's sender allowlist AND Cloudflare's own
//      Authentication-Results (the first one on the delivered message's headers, whose authserv-id
//      must be mx.cloudflare.net) shows dmarc=pass for that From domain, or dkim=pass with a signing
//      domain aligned to it. SPF alone is not enough. Authentication-Results inside the raw MIME are
//      never consulted: a sender can write those.
// Anything else is rejected without saying why.

import PostalMime, { type Attachment, type Email } from "postal-mime";
import { type Vault, vaultRef, vaultStub } from "../directory";
import type { Caller, Env } from "../env";
import { bump } from "../stats/record";
import { putAttachment } from "./files";
import { htmlToMarkdown } from "./html";

export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
const KEY_RE = /^[a-z0-9]{12,40}$/;

export function newInboxKey(): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(16))].map((x) => a[x % a.length]).join("");
}

export interface Identity {
  userId: string;
  username: string;
  via: "address" | "subject" | "sender";
}

type UserRow = { id: string; username: string; disabled_at: string | null; deleting_at: string | null };

function domainOf(addr: string): string {
  return addr.split("@").pop()?.toLowerCase() ?? "";
}

/** The only Authentication-Results issuer trusted for the allowlist (Cloudflare Email Routing). */
export const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

/**
 * dmarc=pass for the From domain, or dkim=pass with an aligned signing domain, in Cloudflare's
 * Authentication-Results. `value` is `message.headers.get("authentication-results")` from the
 * email() event: Cloudflare prepends its result, so it comes first; Headers.get() joins any later
 * (possibly sender-supplied) ones with ", ", so only the text before the next "<authserv-id>;"
 * counts. Anything else (missing, another issuer) fails closed.
 */
export function authenticated(value: string | null | undefined, fromAddress: string): boolean {
  if (!value) return false;
  const first = value.split(/,\s*(?=[^\s;,=]+\s*;)/)[0];
  const parts = first.split(";");
  if (parts[0].trim().toLowerCase() !== TRUSTED_AUTHSERV_ID) return false;
  const fromDomain = domainOf(fromAddress);
  if (!fromDomain) return false;
  const aligned = (d: string) => {
    const x = d.toLowerCase().replace(/[;"'\s]/g, "");
    if (!x.includes(".")) return false;
    return x === fromDomain || fromDomain.endsWith(`.${x}`) || x.endsWith(`.${fromDomain}`);
  };
  // Results are ";"-separated; each is "method=result prop=value ...".
  for (const part of parts.slice(1)) {
    const p = part.trim().toLowerCase();
    const dm = /^dmarc=pass\b.*\bheader\.from=([^\s;]+)/.exec(p);
    if (dm && aligned(dm[1])) return true;
    const dk = /^dkim=pass\b.*\bheader\.(?:d|i)=@?([^\s;]+)/.exec(p);
    if (dk && aligned(dk[1].replace(/^.*@/, ""))) return true;
  }
  return false;
}

export async function identify(env: Env, msg: { to: string; subject: string; from: string; authResults: string | null }): Promise<Identity | null> {
  const byKey = async (key: string, via: Identity["via"]) => {
    if (!KEY_RE.test(key)) return null;
    const u = await env.DB.prepare("SELECT id, username, disabled_at, deleting_at FROM users WHERE inbox_key = ?").bind(key).first<UserRow>();
    return u && !u.disabled_at && !u.deleting_at ? { userId: u.id, username: u.username, via } : null;
  };
  const inbound = (env.INBOUND_EMAIL_ADDRESS ?? "").toLowerCase();
  const to = msg.to.toLowerCase();
  const sub = /^([^+@]+)\+([^@]+)@(.+)$/.exec(to);
  if (sub && (!inbound || `${sub[1]}@${sub[3]}` === inbound)) {
    const r = await byKey(sub[2], "address");
    if (r) return r;
  }
  const subj = /^\s*\[k:([a-z0-9]+)\]/i.exec(msg.subject);
  if (subj) {
    const r = await byKey(subj[1].toLowerCase(), "subject");
    if (r) return r;
  }
  const from = msg.from.toLowerCase().trim();
  if (from && authenticated(msg.authResults, from)) {
    const rows = (
      await env.DB.prepare("SELECT u.id, u.username, u.disabled_at, u.deleting_at FROM users u, json_each(u.inbox_allow) j WHERE j.value = ?")
        .bind(from)
        .all<UserRow>()
    ).results.filter((u) => !u.disabled_at && !u.deleting_at);
    if (rows.length === 1) return { userId: rows[0].id, username: rows[0].username, via: "sender" };
  }
  return null;
}

function mailbox(a: Email["from"]): { name: string; address: string } {
  if (!a) return { name: "", address: "" };
  if (a.address !== undefined) return { name: a.name, address: a.address };
  const first = a.group?.[0];
  return { name: first?.name ?? "", address: first?.address ?? "" };
}

export function emailBodyMarkdown(email: Pick<Email, "text" | "html">): string {
  if (email.text?.trim()) return email.text.replace(/\r\n/g, "\n").trim();
  if (email.html) return htmlToMarkdown(email.html);
  return "";
}

export type IngestOutcome =
  | { status: "saved"; userId: string; permalink: string; attachments: number }
  | { status: "duplicate"; userId: string }
  | { status: "rejected"; reason: string };

/** Parse, identify, dedupe and save one message. Pure of Email-Routing objects so tests can drive it. */
export async function ingestEmail(
  env: Env,
  raw: Uint8Array,
  envelope: { to: string; from: string /** Cloudflare's Authentication-Results from the email() event headers. */; authResults?: string | null },
): Promise<IngestOutcome> {
  if (raw.byteLength > MAX_EMAIL_BYTES) return { status: "rejected", reason: "too large" };
  let email: Email;
  try {
    email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  } catch {
    return { status: "rejected", reason: "unparseable" };
  }
  const from = mailbox(email.from);
  const subject = (email.subject ?? "").trim();
  const who = await identify(env, { to: envelope.to, subject, from: from.address || envelope.from, authResults: envelope.authResults ?? null });
  if (!who) return { status: "rejected", reason: "unknown recipient" };

  if (env.RL_WRITE) {
    const { success } = await env.RL_WRITE.limit({ key: `email:${who.userId}` });
    if (!success) return { status: "rejected", reason: "rate limited" };
  }
  const vault = await env.DB.prepare("SELECT * FROM vaults WHERE owner_id = ? AND is_default = 1").bind(who.userId).first<Vault>();
  if (!vault) return { status: "rejected", reason: "no project" };

  const messageId = (email.messageId ?? "").trim() || `sha256:${await digest(raw)}`;
  const seen = await env.DB.prepare("INSERT INTO email_seen (user_id, message_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(who.userId, messageId.slice(0, 500), new Date().toISOString())
    .run();
  if (!seen.meta.changes) return { status: "duplicate", userId: who.userId };
  const forget = () => env.DB.prepare("DELETE FROM email_seen WHERE user_id = ? AND message_id = ?").bind(who.userId, messageId.slice(0, 500)).run();
  try {
    return await saveEmail(env, email, who, vault, messageId, from, subject, forget);
  } catch (e) {
    // Don't leave a dedupe claim for a message that wasn't saved: a resend must be able to work.
    await forget().catch(() => {});
    throw e;
  }
}

async function saveEmail(
  env: Env,
  email: Email,
  who: Identity,
  vault: Vault,
  messageId: string,
  from: { name: string; address: string },
  subject: string,
  forget: () => Promise<unknown>,
): Promise<IngestOutcome> {
  const lines: string[] = [];
  let stored = 0;
  for (const a of email.attachments.slice(0, 20)) {
    const r = await storeAttachment(env, vault, a);
    if (r.ok) {
      stored++;
      lines.push(`- ${r.markdown}`);
    } else lines.push(`- ${a.filename ?? "attachment"} (not saved: ${r.message})`);
  }
  const body = emailBodyMarkdown(email);
  const content = `${[body || "_(no text)_", lines.length ? `\n## Attachments\n\n${lines.join("\n")}` : ""].join("\n").trim()}\n`;
  const baseTitle = subject.replace(/^\s*\[k:[a-z0-9]+\]\s*/i, "").trim() || `Email from ${from.name || from.address || "unknown sender"}`;
  const date = email.date ? new Date(email.date) : new Date();
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  const caller: Caller = { userId: who.userId, username: who.username, client: "email", tool: "email_ingest" };
  const stub = vaultStub(env, vault);
  const metadata = {
    source: "email",
    from: from.name ? `${from.name} <${from.address}>` : from.address,
    date: iso,
    message_id: messageId,
  };
  let result = null;
  for (const title of [baseTitle, `${baseTitle} (${iso.slice(0, 16).replace("T", " ")})`, `${baseTitle} (${messageId.slice(-8).replace(/[^\w]/g, "")})`]) {
    const r = await stub.writeNote(vaultRef(vault), caller, { title: title.slice(0, 200), directory: "inbox", content, tags: ["email"], metadata });
    if (r.ok || r.code !== "ALREADY_EXISTS") {
      result = r;
      break;
    }
  }
  if (!result?.ok) {
    // Not saved: forget the Message-ID so a resend can work, and bounce with the reason.
    await forget();
    return { status: "rejected", reason: result && !result.ok ? `not saved: ${result.message}` : "not saved" };
  }
  await env.DB.prepare("UPDATE email_seen SET permalink = ? WHERE user_id = ? AND message_id = ?")
    .bind(result.value.note.permalink, who.userId, messageId.slice(0, 500))
    .run();
  await bump(env.DB, who.userId, { email_in: 1, email_attachments: stored }).catch(() => {});
  return { status: "saved", userId: who.userId, permalink: result.value.note.permalink, attachments: stored };
}

async function storeAttachment(env: Env, vault: Vault, a: Attachment) {
  const bytes =
    typeof a.content === "string"
      ? new TextEncoder().encode(a.content)
      : a.content instanceof Uint8Array
        ? a.content
        : new Uint8Array(a.content as ArrayBuffer);
  const r = await putAttachment(env, vault, { bytes, name: a.filename ?? undefined, mime: a.mimeType, source: "email" });
  return r.ok ? { ok: true as const, markdown: r.markdown } : { ok: false as const, message: r.message };
}

async function digest(raw: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", raw as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The Worker's email() entry point. */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  if (message.rawSize > MAX_EMAIL_BYTES) {
    message.setReject("Message too large");
    return;
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const out = await ingestEmail(env, raw, { to: message.to, from: message.from, authResults: message.headers.get("authentication-results") });
  if (out.status === "rejected") {
    // Unknown senders learn nothing; known users get the reason (quota, rate limit).
    message.setReject(out.reason === "unknown recipient" || out.reason === "unparseable" ? "Unknown recipient" : `Cairn: ${out.reason}`);
  }
}
