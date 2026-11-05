// Email ingestion end to end: real-looking messages from common clients go through the Worker's own
// email() entry point (src/index.ts), shaped the way Cloudflare Email Routing delivers them, and we
// check the notes, attachments and rejections that come out.
//
// How the fake message mirrors Email Routing: Cloudflare prepends its own Authentication-Results
// (authserv-id mx.cloudflare.net) to the message, and `message.headers` is parsed from the delivered
// message, so any Authentication-Results the sender wrote come after Cloudflare's and Headers.get()
// joins them behind it with ", ".

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_EMAIL_BYTES } from "../src/capture/email";
import { LIMITS } from "../src/env";
import worker from "../src/index";
import calendarInvite from "./fixtures/email/e2e/calendar-invite.eml?raw";
import forgedAuth from "./fixtures/email/e2e/forged-auth-results.eml?raw";
import forwarded from "./fixtures/email/e2e/forwarded.eml?raw";
import gmail from "./fixtures/email/e2e/gmail-alternative.eml?raw";
import htmlOnly from "./fixtures/email/e2e/html-only.eml?raw";
import latin1 from "./fixtures/email/e2e/latin1-qp.eml?raw";
import noSubject from "./fixtures/email/e2e/no-subject-no-id.eml?raw";
import outlook from "./fixtures/email/e2e/outlook-related-attachments.eml?raw";
import shiftJis from "./fixtures/email/e2e/shift-jis.eml?raw";
import { defaultVault, makeUser, ORIGIN } from "./helpers";
import { fetchWorker } from "./oauth";

const INBOUND = "cairn@example.test"; // env.local INBOUND_EMAIL_ADDRESS
const CF_PASS = (domain: string) =>
  `mx.cloudflare.net; dkim=pass header.d=${domain} header.s=s1 header.b=abc; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=REJECT) header.from=${domain}`;
const CF_FAIL = (domain: string) =>
  `mx.cloudflare.net; dkim=fail header.d=${domain}; spf=softfail smtp.mailfrom=attacker.test; dmarc=fail header.from=${domain}`;

/** Fill a fixture's placeholders. */
function fill(fixture: string, v: { from: string; to?: string; key?: string; subjectKey?: boolean }) {
  return fixture
    .replaceAll("{{FROM}}", v.from)
    .replaceAll("{{TO}}", v.to ?? INBOUND)
    .replaceAll("{{SUBJECT_PREFIX}}", v.subjectKey && v.key ? `[k:${v.key}] ` : "")
    .replaceAll("{{NONCE}}", crypto.randomUUID());
}

/** The delivered message's headers, as the runtime parses them (unfolded; repeats joined by append). */
function parseHeaders(raw: string): Headers {
  const block = raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, " ");
  const h = new Headers();
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return h;
}

/** Deliver one message to the Worker's email() handler the way Email Routing would. */
async function deliver(raw: string, envelope: { from: string; to: string; cfAuth?: string | null; rawSize?: number }): Promise<{ rejected: string | null }> {
  const full = `${envelope.cfAuth ? `Authentication-Results: ${envelope.cfAuth}\r\n` : ""}${raw}`;
  const bytes = new TextEncoder().encode(full);
  let rejected: string | null = null;
  const message = {
    from: envelope.from,
    to: envelope.to,
    raw: new Response(bytes).body,
    rawSize: envelope.rawSize ?? bytes.byteLength,
    headers: parseHeaders(full),
    setReject: (reason: string) => {
      rejected = reason;
    },
    forward: async () => {
      throw new Error("forward is never used");
    },
    reply: async () => {
      throw new Error("reply is never used");
    },
  } as unknown as ForwardableEmailMessage;
  const ctx = createExecutionContext();
  await worker.email(message, env);
  await waitOnExecutionContext(ctx);
  return { rejected };
}

async function userWithKey(prefix = "mail") {
  const u = await makeUser(prefix);
  const r = await fetchWorker("/app/settings/capture/key", { method: "POST", headers: { cookie: u.cookie, origin: ORIGIN } });
  expect(r.status).toBe(303);
  const key = (await env.DB.prepare("SELECT inbox_key FROM users WHERE id = ?").bind(u.user.id).first<{ inbox_key: string }>())?.inbox_key ?? "";
  expect(key).toMatch(/^[a-z0-9]{12,40}$/);
  return { ...u, key };
}

async function inbox(userId: string): Promise<string[]> {
  const { stub, ref } = await defaultVault(userId);
  const l = await stub.listDirectory(ref, { path: "inbox" });
  return l.notes.map((n) => n.permalink).sort();
}

async function read(userId: string, permalink: string) {
  const { stub, ref } = await defaultVault(userId);
  const r = await stub.readNote(ref, { identifier: permalink });
  if (!r.ok || !r.value.content) throw new Error(`no note ${permalink}`);
  return { content: r.value.content, title: r.value.note.title, client: r.value.note.updated_by_client };
}

const attachmentRows = async (userId: string) =>
  (
    await env.DB.prepare("SELECT name, mime, bytes, state, source FROM attachments WHERE user_id = ? ORDER BY name")
      .bind(userId)
      .all<{ name: string; mime: string; bytes: number; state: string; source: string }>()
  ).results;

const fileLinks = (content: string) => [...content.matchAll(/\]\((\/app\/files\/main\/[a-z0-9]{12})\)/g)].map((m) => m[1]);

describe("email ingestion end to end (Worker email() handler, Email Routing-shaped messages)", () => {
  it("Gmail multipart/alternative to cairn+<key>@: the text part becomes the note, QP decoded, with provenance", async () => {
    const { user, key } = await userWithKey();
    const out = await deliver(fill(gmail, { from: "sender@example.com", to: `cairn+${key}@example.test` }), {
      from: "sender@example.com",
      to: `cairn+${key}@example.test`,
      cfAuth: CF_PASS("gmail.com"),
    });
    expect(out.rejected).toBeNull();
    expect(await inbox(user.id)).toEqual(["inbox/notes-from-the-vendor-call"]);
    const n = await read(user.id, "inbox/notes-from-the-vendor-call");
    expect(n.title).toBe("Notes from the vendor call");
    expect(n.client).toBe("email");
    expect(n.content).toContain("Quick notes from today’s call with Northwind:");
    expect(n.content).toContain("- [decision] Renew for 12 months, not 36");
    expect(n.content).toContain("- follow_up [[Dana Roe]]");
    expect(n.content).toContain("— Jeff");
    expect(n.content).not.toContain("HTML-ONLY-MARKER"); // text/plain wins over the HTML alternative
    expect(n.content).toMatch(/from: Jeff Example <sender@example.com>/);
    expect(n.content).toMatch(/date: 2026-11-03T17:13:51/);
    expect(n.content).toMatch(/message_id: <CAJ\+/);
    // The observation and relation are indexed like any other note.
    const { stub, ref } = await defaultVault(user.id);
    const s = await stub.search(ref, { query: "SSO connector beta", items: ["observation"] });
    if (!s.ok) throw new Error(s.message);
    expect(s.value.hits.some((h) => h.observation?.category === "risk")).toBe(true);
  });

  it("Outlook mixed/related/alternative: inline image, PDF and a UTF-8-named .docx are stored, byte for byte, owner-only", async () => {
    const { user, cookie, key } = await userWithKey();
    const other = await makeUser("mail-other");
    const out = await deliver(fill(outlook, { from: "casey@contoso.example", key, subjectKey: true }), {
      from: "casey@contoso.example",
      to: INBOUND,
      cfAuth: CF_PASS("contoso.example"),
    });
    expect(out.rejected).toBeNull();
    const [permalink] = await inbox(user.id);
    expect(permalink).toBe("inbox/q4-budget-draft");
    const n = await read(user.id, permalink);
    expect(n.title).toBe("Q4 budget draft"); // the [k:key] prefix is stripped
    expect(n.content).not.toContain(key);
    expect(n.content).toContain("Draft attached. The chart is inline below.");
    expect(n.content).toContain("## Attachments");
    const rows = await attachmentRows(user.id);
    // Names are sanitised; types outside the attachment allowlist (.docx) are kept as downloads.
    expect(rows.map((r) => [r.name, r.mime, r.bytes, r.state, r.source])).toEqual([
      ["Meeting notes _ final.docx", "application/octet-stream", 281, "ready", "email"],
      ["Q4 budget draft.pdf", "application/pdf", 77, "ready", "email"],
      ["image001.png", "image/png", 70, "ready", "email"],
    ]);
    const links = fileLinks(n.content);
    expect(links).toHaveLength(3);
    const pdfLink = /\[Q4 budget draft\.pdf\]\((\/app\/files\/main\/[a-z0-9]{12})\)/.exec(n.content)?.[1] ?? "";
    const pdf = await fetchWorker(pdfLink, { headers: { cookie } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode(await pdf.arrayBuffer())).toMatch(/^%PDF-1\.4\n1 0 obj/);
    for (const l of links) {
      expect((await fetchWorker(l, { headers: { cookie: other.cookie } })).status).toBe(404);
      expect((await fetchWorker(l)).status).toBe(404);
    }
  });

  it("HTML-only newsletter (base64): converted to markdown; script, style and tracking pixel dropped", async () => {
    const { user, key } = await userWithKey();
    const out = await deliver(fill(htmlOnly, { from: "news@mailer.example.com", key, subjectKey: true }), {
      from: "bounce-123@mailer.example.com",
      to: INBOUND,
      cfAuth: CF_PASS("mailer.example.com"),
    });
    expect(out.rejected).toBeNull();
    const n = await read(user.id, "inbox/release-4-2-is-out");
    expect(n.content).toMatch(/# Release 4\.2 is out/);
    expect(n.content).toMatch(/Faster sync/);
    expect(n.content).toContain("[full changelog](https://example.com/changelog?utm_source=mail)");
    for (const bad of ["SCRIPT-MARKER", "STYLE-MARKER", "<script", "<style", "tracker.example.com"]) expect(n.content).not.toContain(bad);
  });

  it("forwarded message (inline message/rfc822): the forwarded body is kept in the note", async () => {
    const { user, key } = await userWithKey();
    const out = await deliver(fill(forwarded, { from: "jeff@example.org", key, subjectKey: true }), { from: "jeff@example.org", to: INBOUND });
    expect(out.rejected).toBeNull();
    const n = await read(user.id, "inbox/fwd-contract-renewal-terms");
    expect(n.title).toBe("Fwd: Contract renewal terms");
    expect(n.content).toContain("Keep this one for the renewal.");
    expect(n.content).toContain("FORWARDED-BODY-MARKER");
    expect(n.content).toContain("legal@northwind.example");
  });

  it("non-UTF-8: ISO-8859-1 QP body, windows-1252 subject, ISO-2022-JP subject with a Shift_JIS body", async () => {
    const { user, key } = await userWithKey();
    expect((await deliver(fill(latin1, { from: "renee@example.fr", key, subjectKey: true }), { from: "renee@example.fr", to: INBOUND })).rejected).toBeNull();
    expect((await deliver(fill(shiftJis, { from: "taro@example.jp", key, subjectKey: true }), { from: "taro@example.jp", to: INBOUND })).rejected).toBeNull();
    const notes = await inbox(user.id);
    expect(notes).toHaveLength(2);
    const byTitle = new Map(await Promise.all(notes.map(async (p) => [(await read(user.id, p)).title, await read(user.id, p)] as const)));
    const fr = byTitle.get("Café réunion – jeudi");
    expect(fr?.content).toContain("Le café de la réunion coûte 4,50 EUR. À bientôt.");
    expect(fr?.content).toMatch(/from: Renée Dupré <renee@example.fr>/);
    const jp = byTitle.get("会議の予定");
    expect(jp?.content).toContain("会議は木曜日の午後三時です。");
  });

  it("no Subject and no Message-ID: titled from the sender, deduped by content hash", async () => {
    const { user, key } = await userWithKey();
    const raw = fill(noSubject, { from: "pat@example.com" });
    const to = `cairn+${key}@example.test`;
    expect((await deliver(raw, { from: "pat@example.com", to })).rejected).toBeNull();
    expect((await deliver(raw, { from: "pat@example.com", to })).rejected).toBeNull(); // a resend is accepted silently...
    const notes = await inbox(user.id);
    expect(notes).toEqual(["inbox/email-from-pat"]); // ...and makes no second note
    expect((await read(user.id, notes[0])).content).toMatch(/message_id: sha256:[0-9a-f]{64}/);
  });

  it("calendar invite: the text part is the note, the .ics is stored as an attachment", async () => {
    const { user, key } = await userWithKey();
    expect(
      (await deliver(fill(calendarInvite, { from: "calendar@example.com", key, subjectKey: true }), { from: "calendar@example.com", to: INBOUND })).rejected,
    ).toBeNull();
    const [p] = await inbox(user.id);
    const n = await read(user.id, p);
    expect(n.content).toContain("You have been invited to Planning sync.");
    expect((await attachmentRows(user.id)).some((r) => r.name === "invite.ics")).toBe(true);
  });

  it("allowlisted sender: accepted on Cloudflare's DKIM/DMARC pass; refused on fail even with a forged pass in the message", async () => {
    const { user, cookie } = await userWithKey();
    const save = await fetchWorker("/app/settings/capture/allow", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "allow=boss%40example.org",
    });
    expect(save.status).toBe(303);
    const send = (cfAuth: string | null) => deliver(fill(forgedAuth, { from: "boss@example.org" }), { from: "boss@example.org", to: INBOUND, cfAuth });

    // Cloudflare says fail; the sender's own "pass" header sits behind it and is ignored.
    expect((await send(CF_FAIL("example.org"))).rejected).toBe("Unknown recipient");
    // A pass for a different (unaligned) domain is not enough either.
    expect((await send(CF_PASS("attacker.test"))).rejected).toBe("Unknown recipient");
    expect(await inbox(user.id)).toEqual([]);
    // Cloudflare's own aligned pass: accepted.
    expect((await send(CF_PASS("example.org"))).rejected).toBeNull();
    const [p] = await inbox(user.id);
    expect((await read(user.id, p)).content).toContain("FORGED-MARKER");
  });

  it("rejections: wrong key, plain address with no key, oversize, disabled account, storage full", async () => {
    const victim = await userWithKey();
    const plainMsg = (from: string) => fill(gmail, { from });
    // Unknown key, and the bare inbound address with no key: the sender learns nothing.
    expect((await deliver(plainMsg("x@example.com"), { from: "x@example.com", to: "cairn+zzzzzzzzzzzzzzzz@example.test" })).rejected).toBe("Unknown recipient");
    expect((await deliver(plainMsg("x@example.com"), { from: "x@example.com", to: INBOUND })).rejected).toBe("Unknown recipient");
    // Another user's key on a different domain's plus-address is not the inbound address.
    expect((await deliver(plainMsg("x@example.com"), { from: "x@example.com", to: `other+${victim.key}@example.test` })).rejected).toBe("Unknown recipient");
    expect(await inbox(victim.user.id)).toEqual([]);

    // Oversize (Email Routing's rawSize) is refused before the body is read.
    expect(
      (await deliver(plainMsg("x@example.com"), { from: "x@example.com", to: `cairn+${victim.key}@example.test`, rawSize: MAX_EMAIL_BYTES + 1 })).rejected,
    ).toBe("Message too large");

    // A disabled account's key no longer works.
    const disabled = await userWithKey("mail-disabled");
    await env.DB.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").bind(new Date().toISOString(), disabled.user.id).run();
    expect((await deliver(plainMsg("x@example.com"), { from: "x@example.com", to: `cairn+${disabled.key}@example.test` })).rejected).toBe("Unknown recipient");

    // Storage full: the known user gets the reason, and the Message-ID is not burned (a resend after
    // freeing space works).
    const full = await userWithKey("mail-full");
    await env.DB.prepare("UPDATE users SET bytes_used = ? WHERE id = ?").bind(LIMITS.userBytes, full.user.id).run();
    const raw = plainMsg("me@example.com");
    const to = `cairn+${full.key}@example.test`;
    const refused = await deliver(raw, { from: "me@example.com", to });
    expect(refused.rejected).toMatch(/^Cairn: not saved: .*storage limit/);
    expect(await inbox(full.user.id)).toEqual([]);
    await env.DB.prepare("UPDATE users SET bytes_used = 0 WHERE id = ?").bind(full.user.id).run();
    expect((await deliver(raw, { from: "me@example.com", to })).rejected).toBeNull();
    expect(await inbox(full.user.id)).toEqual(["inbox/notes-from-the-vendor-call"]);
  });
});
