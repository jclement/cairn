import { env } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { deleteAccount } from "../src/account";
import { authenticated, handleEmail, ingestEmail } from "../src/capture/email";
import { blockedHost, checkUrl, safeFetch } from "../src/capture/fetch";
import { ATTACHMENT_OVERHEAD, DEDUPE_WAIT, MAX_ATTACHMENTS, putAttachment, readyAttachments, sweepAttachments } from "../src/capture/files";
import { aiToMarkdown, convertingNow, htmlToMarkdown } from "../src/capture/html";
import { getVault } from "../src/directory";
import { LIMITS } from "../src/env";
import { createApp } from "../src/web/app";
import allowlisted from "./fixtures/email/allowlisted.eml?raw";
import forged from "./fixtures/email/forged.eml?raw";
import htmlAttachments from "./fixtures/email/html-attachments.eml?raw";
import plain from "./fixtures/email/plain.eml?raw";
import { BASE, defaultVault, freshReauth, makeUser, ORIGIN } from "./helpers";
import { callTool, fetchWorker, getAccessToken } from "./oauth";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

async function withKey() {
  const u = await makeUser("cap");
  const r = await fetchWorker("/app/settings/capture/key", { method: "POST", headers: { cookie: u.cookie, origin: ORIGIN } });
  expect(r.status).toBe(303);
  const row = await env.DB.prepare("SELECT inbox_key FROM users WHERE id = ?").bind(u.user.id).first<{ inbox_key: string }>();
  return { ...u, key: row?.inbox_key ?? "" };
}

const eml = (fixture: string, key: string) => new TextEncoder().encode(fixture.replaceAll("{{KEY}}", key).replaceAll("{{NONCE}}", crypto.randomUUID()));

async function upload(cookie: string, bytes: Uint8Array, name: string, type: string, origin: string | null = ORIGIN) {
  const fd = new FormData();
  fd.append("file", new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
  return fetchWorker("/app/api/files", { method: "POST", headers: { cookie, ...(origin ? { origin } : {}) }, body: fd });
}

const bytesUsed = async (id: string) =>
  (await env.DB.prepare("SELECT bytes_used FROM users WHERE id = ?").bind(id).first<{ bytes_used: number }>())?.bytes_used ?? 0;

const attachmentCount = async (userId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?").bind(userId).first<{ n: number }>())?.n ?? 0;

describe("capture: email", () => {
  it("files mail sent to cairn+<key>@ into inbox/ with provenance, and dedupes on Message-ID", async () => {
    const { user, key } = await withKey();
    const raw = eml(plain, key);
    const out = await ingestEmail(env, raw, { to: `cairn+${key}@example.test`, from: "alice@example.com" });
    expect(out).toMatchObject({ status: "saved", permalink: "inbox/lunch-ideas-for-the-offsite" });
    const { stub, ref } = await defaultVault(user.id);
    const r = await stub.readNote(ref, { identifier: "inbox/lunch-ideas-for-the-offsite" });
    if (!r.ok || !r.value.content) throw new Error("not saved");
    expect(r.value.content).toMatch(/source: email/);
    expect(r.value.content).toMatch(/from: Alice Example <alice@example.com>/);
    expect(r.value.content).toMatch(/message_id: <plain-/);
    expect(r.value.content).toContain("- [idea] Book the back room");
    expect(r.value.note.updated_by_client).toBe("email");
    const again = await ingestEmail(env, raw, { to: `cairn+${key}@example.test`, from: "alice@example.com" });
    expect(again.status).toBe("duplicate");
  });

  it("accepts the [k:key] subject form, converts HTML, stores attachments (SVG never inline)", async () => {
    const { user, cookie, key } = await withKey();
    const out = await ingestEmail(env, eml(htmlAttachments, key), { to: "cairn@example.test", from: "bob@example.net" });
    expect(out).toMatchObject({ status: "saved", attachments: 2 });
    if (out.status !== "saved") throw new Error();
    const { stub, ref } = await defaultVault(user.id);
    const r = await stub.readNote(ref, { identifier: out.permalink });
    if (!r.ok || !r.value.content) throw new Error();
    expect(r.value.note.title).toBe("Receipt and diagram");
    expect(r.value.content).toContain("## Hello");
    expect(r.value.content).toContain("[the receipt](https://example.org/r)");
    expect(r.value.content).not.toContain("alert(1)");
    const img = /!\[An image named dot\.png\.\]\((\/app\/files\/main\/[a-z0-9]{12})\)/.exec(r.value.content);
    const svg = /\[evil\.svg\]\((\/app\/files\/main\/[a-z0-9]{12})\)/.exec(r.value.content);
    expect(img && svg).toBeTruthy();
    const png = await fetchWorker(img?.[1] ?? "", { headers: { cookie } });
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    const s = await fetchWorker(svg?.[1] ?? "", { headers: { cookie } });
    expect(s.headers.get("content-type")).toBe("application/octet-stream");
    expect(s.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(s.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("accepts an allowlisted sender only on Cloudflare's own DMARC/DKIM pass (event header, mx.cloudflare.net)", async () => {
    const { user, cookie } = await withKey();
    const save = await fetchWorker("/app/settings/capture/allow", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "allow=Trusted%40Example.org%0Anot-an-address",
    });
    expect(save.status).toBe(303);
    const allow = await env.DB.prepare("SELECT inbox_allow FROM users WHERE id = ?").bind(user.id).first<{ inbox_allow: string }>();
    expect(JSON.parse(allow?.inbox_allow ?? "[]")).toEqual(["trusted@example.org"]);
    const env1 = { to: "cairn@example.test", from: "trusted@example.org" };
    const cfPass = "mx.cloudflare.net; spf=pass smtp.mailfrom=example.org; dkim=pass header.d=example.org header.s=s1; dmarc=pass header.from=example.org";
    expect((await ingestEmail(env, eml(allowlisted, ""), { ...env1, authResults: cfPass })).status).toBe("saved");
    // The raw message's own (sender-writable) Authentication-Results are never trusted: no event header -> rejected.
    expect((await ingestEmail(env, eml(allowlisted, ""), env1)).status).toBe("rejected");
    // Cloudflare's result failed; a passing header the sender added below it (joined by Headers.get) is ignored.
    const joined =
      "mx.cloudflare.net; spf=fail smtp.mailfrom=attacker.test; dmarc=fail header.from=example.org, mx.cloudflare.net; dmarc=pass header.from=example.org";
    expect(await ingestEmail(env, eml(forged, ""), { ...env1, authResults: joined })).toEqual({ status: "rejected", reason: "unknown recipient" });
    // A pass from any other issuer is ignored.
    expect((await ingestEmail(env, eml(forged, ""), { ...env1, authResults: "attacker.test; dmarc=pass header.from=example.org" })).status).toBe("rejected");
  });

  it("checks issuer and alignment: SPF alone, another authserv-id, a bare TLD or an unrelated DKIM domain is not enough", () => {
    const cf = (v: string) => `mx.cloudflare.net; ${v}`;
    expect(authenticated(cf("spf=pass smtp.mailfrom=example.org"), "a@example.org")).toBe(false);
    expect(authenticated(cf("dkim=pass header.d=evil.test"), "a@example.org")).toBe(false);
    expect(authenticated(cf("dkim=pass header.d=org"), "a@example.org")).toBe(false);
    expect(authenticated(cf("dkim=pass header.d=example.org"), "a@mail.example.org")).toBe(true);
    expect(authenticated(cf("dmarc=pass header.from=example.org"), "a@example.org")).toBe(true);
    expect(authenticated(cf("dmarc=fail header.from=example.org"), "a@example.org")).toBe(false);
    expect(authenticated("mx.example.net; dmarc=pass header.from=example.org", "a@example.org")).toBe(false);
    expect(authenticated(null, "a@example.org")).toBe(false);
  });

  it("rejects unknown recipients and bad keys through the email() handler", async () => {
    await withKey();
    const rejects: string[] = [];
    const msg = (raw: string, to: string) =>
      ({
        from: "x@example.com",
        to,
        raw: new Response(raw).body,
        rawSize: raw.length,
        headers: new Headers(),
        setReject: (r: string) => rejects.push(r),
        forward: async () => {},
        reply: async () => {},
      }) as unknown as ForwardableEmailMessage;
    await handleEmail(msg(plain.replaceAll("{{KEY}}", "wrongwrongwrong1").replaceAll("{{NONCE}}", "a"), "cairn+wrongwrongwrong1@example.test"), env);
    await handleEmail(msg(plain.replaceAll("{{KEY}}", "x").replaceAll("{{NONCE}}", "b"), "someone@example.test"), env);
    expect(rejects).toEqual(["Unknown recipient", "Unknown recipient"]);
  });

  it("shows the inbox key, addresses and bookmarklet in Settings → Capture", async () => {
    const { cookie, key } = await withKey();
    const html = await (await fetchWorker("/app/settings/capture", { headers: { cookie } })).text();
    expect(html).toContain(`cairn+${key}@example.test`);
    expect(html).toContain(`[k:${key}]`);
    expect(html).toMatch(/class="button bookmarklet" href="javascript:/);
    expect(html).toContain("/app/clip?url=");
  });
});

describe("capture: attachments", () => {
  it("uploads, serves only to the owner, dedupes, charges and releases quota", async () => {
    const a = await makeUser("own");
    const b = await makeUser("other");
    const before = await bytesUsed(a.user.id);
    const up = await upload(a.cookie, PNG, "dot.png", "application/octet-stream"); // type is sniffed, not trusted
    expect(up.status).toBe(201);
    const j = (await up.json()) as { id: string; url: string; markdown: string; mime: string; caption: string };
    expect(j.mime).toBe("image/png");
    expect(j.markdown).toBe(`![An image named dot.png.](${j.url})`);
    expect(await bytesUsed(a.user.id)).toBe(before + PNG.byteLength + ATTACHMENT_OVERHEAD);
    const again = await upload(a.cookie, PNG, "copy.png", "image/png");
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(j.id);
    expect(await bytesUsed(a.user.id)).toBe(before + PNG.byteLength + ATTACHMENT_OVERHEAD);

    const got = await fetchWorker(j.url, { headers: { cookie: a.cookie } });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("content-disposition")).toMatch(/^inline/);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    expect((await fetchWorker(j.url, { headers: { cookie: a.cookie, "if-none-match": got.headers.get("etag") ?? "" } })).status).toBe(304);
    // B, with their own project also called "main", cannot read A's file; nor can anonymous users.
    expect((await fetchWorker(j.url, { headers: { cookie: b.cookie } })).status).toBe(404);
    expect((await fetchWorker(j.url)).status).toBe(404);
    expect(
      (await fetchWorker("/app/api/files/delete", { method: "POST", headers: { cookie: b.cookie, origin: ORIGIN }, body: JSON.stringify({ id: j.id }) }))
        .status,
    ).toBe(404);

    const del = await fetchWorker("/app/api/files/delete", {
      method: "POST",
      headers: { cookie: a.cookie, origin: ORIGIN },
      body: JSON.stringify({ id: j.id }),
    });
    expect(del.status).toBe(200);
    expect(await bytesUsed(a.user.id)).toBe(before);
    expect((await fetchWorker(j.url, { headers: { cookie: a.cookie } })).status).toBe(404);
  });

  it("refuses cross-origin uploads, files over quota, and serves non-images as downloads", async () => {
    const a = await makeUser("q");
    expect((await upload(a.cookie, PNG, "dot.png", "image/png", "https://evil.example")).status).toBe(403);
    const pdf = new TextEncoder().encode("%PDF-1.4\n%fake\n");
    const p = await upload(a.cookie, pdf, "doc.pdf", "application/pdf");
    const pj = (await p.json()) as { url: string; markdown: string };
    expect(pj.markdown).toBe(`[doc.pdf](${pj.url})`);
    const got = await fetchWorker(pj.url, { headers: { cookie: a.cookie } });
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''doc.pdf");
    const html = await upload(a.cookie, new TextEncoder().encode("<html><script>alert(1)</script>"), "x.html", "text/html");
    const hj = (await html.json()) as { url: string; mime: string };
    expect(hj.mime).toBe("application/octet-stream");
    await env.DB.prepare("UPDATE users SET bytes_used = ? WHERE id = ?")
      .bind(LIMITS.userBytes - 10, a.user.id)
      .run();
    const over = await upload(a.cookie, new TextEncoder().encode("x".repeat(100)), "big.txt", "text/plain");
    expect(over.status).toBe(413);
    expect(await bytesUsed(a.user.id)).toBe(LIMITS.userBytes - 10);
  });

  it("deleting the account removes its files from R2 and D1, and its inbox key stops working", async () => {
    const { user, cookie, key } = await withKey();
    const j = (await (await upload(cookie, PNG, "dot.png", "image/png")).json()) as { id: string };
    const row = await env.DB.prepare("SELECT r2_key, vault_id FROM attachments WHERE id = ?").bind(j.id).first<{ r2_key: string; vault_id: string }>();
    expect(await env.FILES?.head(row?.r2_key ?? "")).toBeTruthy();
    await deleteAccount(env, env.OAUTH_PROVIDER, user.id);
    expect(await env.FILES?.head(row?.r2_key ?? "")).toBeNull();
    expect((await env.FILES?.list({ prefix: `${row?.vault_id}/` }))?.objects.length).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?").bind(user.id).first<{ n: number }>()).toEqual({ n: 0 });
    expect((await ingestEmail(env, eml(plain, key), { to: `cairn+${key}@example.test`, from: "alice@example.com" })).status).toBe("rejected");
  });

  it("normalises MIME to a short list and charges a per-file overhead (no cheap metadata)", async () => {
    const { user, cookie } = await makeUser("mime");
    const before = await bytesUsed(user.id);
    const huge = `application/${"x".repeat(100_000)}`;
    const files: { mime: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await upload(cookie, new TextEncoder().encode(`t${i}`), `t${i}.bin`, huge);
      expect(r.status).toBe(201);
      files.push((await r.json()) as { mime: string });
    }
    expect(files.map((f) => f.mime)).toEqual(["application/octet-stream", "application/octet-stream", "application/octet-stream"]);
    const longest = await env.DB.prepare("SELECT MAX(length(mime)) AS m, MAX(length(name)) AS n FROM attachments WHERE user_id = ?")
      .bind(user.id)
      .first<{ m: number; n: number }>();
    expect(longest?.m).toBeLessThanOrEqual(30);
    expect(longest?.n).toBeLessThanOrEqual(120);
    expect(await bytesUsed(user.id)).toBe(before + 3 * (2 + ATTACHMENT_OVERHEAD));
    // declared types on the allowlist are kept; others aren't
    const csv = (await (await upload(cookie, new TextEncoder().encode("a,b"), "x.csv", "text/csv")).json()) as { mime: string };
    expect(csv.mime).toBe("text/csv");
    const html = (await (await upload(cookie, new TextEncoder().encode("hi"), "x", "text/html")).json()) as { mime: string };
    expect(html.mime).toBe("application/octet-stream");
  });

  it("enforces the per-user file count", async () => {
    const { user, cookie } = await makeUser("count");
    const { vault } = await defaultVault(user.id);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
       INSERT INTO attachments (id, user_id, vault_id, sha256, r2_key, name, mime, bytes, source, state, created_at, updated_at)
       SELECT printf('c%011d', i), ?1, ?2, printf('sha%d', i), 'k', 'f', 'text/plain', 1, 'upload', 'ready', '2026-01-01', '2026-01-01' FROM n`,
    )
      .bind(user.id, vault.id, MAX_ATTACHMENTS)
      .run();
    const r = await upload(cookie, new TextEncoder().encode("one more"), "x.txt", "text/plain");
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: string }).error).toMatch(/file limit/);
  });

  it("recovers from failures: R2 put error, R2 delete error, stale pending rows", async () => {
    const { user } = await makeUser("life");
    const vault = await getVault(env, user.id);
    if (!vault || !env.FILES) throw new Error();
    const files = env.FILES;
    const before = await bytesUsed(user.id);
    // put fails: no row, no charge
    const putFails = {
      ...env,
      FILES: { ...files, put: async () => Promise.reject(new Error("r2 down")), delete: files.delete.bind(files) } as unknown as R2Bucket,
    };
    await expect(putAttachment(putFails, vault, { bytes: new TextEncoder().encode("p1"), name: "p1.txt", source: "upload" })).rejects.toThrow("r2 down");
    expect(await attachmentCount(user.id)).toBe(0);
    expect(await bytesUsed(user.id)).toBe(before);

    // delete fails: hidden at once, still charged, retried by the sweeper
    const ok = await putAttachment(env, vault, { bytes: new TextEncoder().encode("d1"), name: "d1.txt", source: "upload" });
    if (!ok.ok) throw new Error(ok.message);
    const charged = await bytesUsed(user.id);
    const delFails = { ...env, FILES: { ...files, delete: async () => Promise.reject(new Error("r2 down")) } as unknown as R2Bucket };
    const { deleteAttachment } = await import("../src/capture/files");
    expect(await deleteAttachment(delFails, vault, ok.attachment.id)).toBe(true);
    expect(await env.DB.prepare("SELECT state FROM attachments WHERE id = ?").bind(ok.attachment.id).first()).toEqual({ state: "deleting" });
    expect(await bytesUsed(user.id)).toBe(charged);
    expect(await files.head(ok.attachment.r2_key)).toBeTruthy();
    const swept = await sweepAttachments(env, { now: Date.now() + 120e3 });
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    expect(await files.head(ok.attachment.r2_key)).toBeNull();
    expect(await attachmentCount(user.id)).toBe(0);
    expect(await bytesUsed(user.id)).toBe(before);

    // a pending row whose upload died (charge taken, maybe an object): rolled back once stale
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO attachments (id, user_id, vault_id, sha256, r2_key, name, mime, bytes, source, state, created_at, updated_at) VALUES ('stalepending', ?, ?, 'x', ?, 'f', 'text/plain', 10, 'upload', 'pending', '2026-01-01', '2026-01-01')",
      ).bind(user.id, vault.id, `${vault.id}/x.stalepending.txt`),
      env.DB.prepare("UPDATE users SET bytes_used = bytes_used + ? WHERE id = ?").bind(10 + ATTACHMENT_OVERHEAD, user.id),
    ]);
    await files.put(`${vault.id}/x.stalepending.txt`, "0123456789");
    expect((await sweepAttachments(env)).rolledBack).toBeGreaterThanOrEqual(1);
    expect(await attachmentCount(user.id)).toBe(0);
    expect(await bytesUsed(user.id)).toBe(before);
    expect(await files.head(`${vault.id}/x.stalepending.txt`)).toBeNull();
  });

  it("a re-upload of content whose delete is still in flight gets its own object", async () => {
    const { user } = await makeUser("race");
    const vault = await getVault(env, user.id);
    if (!vault || !env.FILES) throw new Error();
    const files = env.FILES;
    const first = await putAttachment(env, vault, { bytes: PNG, name: "a.png", source: "upload" });
    if (!first.ok) throw new Error();
    // the delete marks the row but R2 is slow
    let releaseDelete: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseDelete = r;
    });
    const slow = { ...env, FILES: { ...files, delete: async (k: string | string[]) => gate.then(() => files.delete(k)) } as unknown as R2Bucket };
    const { deleteAttachment } = await import("../src/capture/files");
    const pending = deleteAttachment(slow, vault, first.attachment.id);
    for (let i = 0; i < 100; i++) {
      const st = await env.DB.prepare("SELECT state FROM attachments WHERE id = ?").bind(first.attachment.id).first<{ state: string }>();
      if (st?.state === "deleting") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const again = await putAttachment(env, vault, { bytes: PNG, name: "b.png", source: "upload" });
    if (!again.ok) throw new Error(again.message);
    expect(again.created).toBe(true);
    expect(again.attachment.r2_key).not.toBe(first.attachment.r2_key);
    releaseDelete();
    expect(await pending).toBe(true);
    expect(await files.head(again.attachment.r2_key)).toBeTruthy();
    expect(await files.head(first.attachment.r2_key)).toBeNull();
  });

  it("an upload that races account deletion leaves no row and no object", async () => {
    const { user } = await makeUser("fence");
    const vault = await getVault(env, user.id);
    if (!vault || !env.FILES) throw new Error();
    const files = env.FILES;
    let releasePut: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releasePut = r;
    });
    const slow = {
      ...env,
      FILES: {
        ...files,
        put: async (k: string, v: Uint8Array, o: R2PutOptions) => gate.then(() => files.put(k, v, o)),
        delete: files.delete.bind(files),
      } as unknown as R2Bucket,
    };
    const upload = putAttachment(slow, vault, { bytes: new TextEncoder().encode("racing"), name: "r.txt", source: "upload" });
    for (let i = 0; i < 100 && !(await attachmentCount(user.id)); i++) await new Promise((r) => setTimeout(r, 10)); // pending row + charge are in
    expect(await attachmentCount(user.id)).toBe(1);
    await deleteAccount(env, env.OAUTH_PROVIDER, user.id);
    releasePut();
    const r = await upload;
    expect(r.ok).toBe(false);
    expect((await files.list({ prefix: `${vault.id}/` })).objects.length).toBe(0);
    expect(await attachmentCount(user.id)).toBe(0);
    // and a deleting account can't start a new upload
    const { user: u2 } = await makeUser("fence2");
    const v2 = await getVault(env, u2.id);
    if (!v2) throw new Error();
    await env.DB.prepare("UPDATE users SET deleting_at = ? WHERE id = ?").bind(new Date().toISOString(), u2.id).run();
    expect((await putAttachment(env, v2, { bytes: new TextEncoder().encode("late"), name: "l.txt", source: "upload" })).ok).toBe(false);
  });

  // ---- capture fix 2: failed compensation, sweep vs finalize, pending dedupe, conversion slots

  const cleanupRecord = async (key: string) => env.DB.prepare("SELECT reason, not_before FROM r2_cleanup WHERE r2_key = ?").bind(key).first();
  const waitFor = async (cond: () => Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 10));
  };
  const gated = () => {
    let open: (ok: boolean) => void = () => {};
    const p = new Promise<boolean>((r) => {
      open = r;
    });
    return { p, open };
  };

  it("a put that landed but reported failure, with a failing delete, stays charged and recoverable", async () => {
    const { user } = await makeUser("lost");
    const vault = await getVault(env, user.id);
    if (!vault || !env.FILES) throw new Error();
    const files = env.FILES;
    const before = await bytesUsed(user.id);
    const flaky = {
      ...env,
      FILES: {
        ...files,
        put: async (k: string, v: Uint8Array, o: R2PutOptions) => {
          await files.put(k, v, o);
          throw new Error("response lost");
        },
        delete: async () => Promise.reject(new Error("r2 down")),
      } as unknown as R2Bucket,
    };
    await expect(putAttachment(flaky, vault, { bytes: new TextEncoder().encode("lost-1"), name: "l.txt", source: "upload" })).rejects.toThrow("response lost");
    const row = await env.DB.prepare("SELECT * FROM attachments WHERE user_id = ?").bind(user.id).first<{ state: string; r2_key: string }>();
    expect(row?.state).toBe("deleting"); // the record survives: charged, not served
    expect(await bytesUsed(user.id)).toBe(before + 6 + ATTACHMENT_OVERHEAD);
    expect(await files.head(row?.r2_key ?? "")).toBeTruthy();
    expect((await sweepAttachments(env, { now: Date.now() + 120e3 })).deleted).toBeGreaterThanOrEqual(1);
    expect(await files.head(row?.r2_key ?? "")).toBeNull();
    expect(await attachmentCount(user.id)).toBe(0);
    expect(await bytesUsed(user.id)).toBe(before);
  });

  it("an upload that lands after account purge, with its cleanup failing, leaves a durable record the sweeper finishes", async () => {
    const { user } = await makeUser("purgefail");
    const vault = await getVault(env, user.id);
    if (!vault || !env.FILES) throw new Error();
    const files = env.FILES;
    const g = gated();
    const slow = {
      ...env,
      FILES: {
        ...files,
        put: async (k: string, v: Uint8Array, o: R2PutOptions) => g.p.then(() => files.put(k, v, o)),
        delete: async () => Promise.reject(new Error("r2 down")),
      } as unknown as R2Bucket,
    };
    const up = putAttachment(slow, vault, { bytes: new TextEncoder().encode("late"), name: "late.txt", source: "upload" });
    await waitFor(async () => (await attachmentCount(user.id)) === 1);
    const key = (await env.DB.prepare("SELECT r2_key FROM attachments WHERE user_id = ?").bind(user.id).first<{ r2_key: string }>())?.r2_key ?? "";
    await deleteAccount(env, env.OAUTH_PROVIDER, user.id);
    g.open(true);
    expect((await up).ok).toBe(false);
    expect(await files.head(key)).toBeTruthy(); // landed after the prefix sweep; its delete failed
    expect(await cleanupRecord(key)).toMatchObject({ reason: "finalize-lost" });
    expect((await sweepAttachments(env)).orphans).toBeGreaterThanOrEqual(1);
    expect(await files.head(key)).toBeNull();
    expect(await cleanupRecord(key)).toBeNull();
  });

  it("the sweeper claims a stale upload before deleting; a late finalize then fails and a late put is caught", async () => {
    const { user } = await makeUser("sweeprace");
    const vault = await getVault(env, user.id);
    if (!vault || !env.FILES) throw new Error();
    const files = env.FILES;
    const before = await bytesUsed(user.id);
    const g = gated();
    const slow = {
      ...env,
      FILES: {
        ...files,
        put: async (k: string, v: Uint8Array, o: R2PutOptions) => g.p.then(() => files.put(k, v, o)),
        delete: async () => Promise.reject(new Error("r2 down")),
      } as unknown as R2Bucket,
    };
    const up = putAttachment(slow, vault, { bytes: new TextEncoder().encode("stale-but-alive"), name: "s.txt", source: "upload" });
    await waitFor(async () => (await attachmentCount(user.id)) === 1);
    const row = await env.DB.prepare("SELECT id, r2_key FROM attachments WHERE user_id = ?").bind(user.id).first<{ id: string; r2_key: string }>();
    await env.DB.prepare("UPDATE attachments SET updated_at = '2026-01-01' WHERE id = ?").bind(row?.id).run();
    const swept = await sweepAttachments(env);
    expect(swept.rolledBack).toBe(1);
    expect(await attachmentCount(user.id)).toBe(0);
    expect(await bytesUsed(user.id)).toBe(before);
    expect(await cleanupRecord(row?.r2_key ?? "")).toMatchObject({ reason: "late-put" });
    // the slow put lands now; finalize must fail (row claimed), and its own cleanup fails too
    g.open(true);
    const r = await up;
    expect(r.ok).toBe(false);
    expect(await attachmentCount(user.id)).toBe(0);
    expect(await files.head(row?.r2_key ?? "")).toBeTruthy();
    // the late-put record is due after an hour: the sweeper removes the stray object then
    expect((await sweepAttachments(env, { now: Date.now() + 2 * 3600e3 })).orphans).toBeGreaterThanOrEqual(1);
    expect(await files.head(row?.r2_key ?? "")).toBeNull();
    expect(await cleanupRecord(row?.r2_key ?? "")).toBeNull();
  });

  it("an identical upload in flight is reported as busy, never as saved", async () => {
    const { user } = await makeUser("dupe");
    const vault = await getVault(env, user.id);
    if (!vault || !env.FILES) throw new Error();
    const files = env.FILES;
    const saved = { ...DEDUPE_WAIT };
    DEDUPE_WAIT.tries = 2;
    DEDUPE_WAIT.ms = 5;
    try {
      const g = gated();
      const slow = {
        ...env,
        FILES: {
          ...files,
          put: async (k: string, v: Uint8Array, o: R2PutOptions) => g.p.then((ok) => (ok ? files.put(k, v, o) : Promise.reject(new Error("put failed")))),
          delete: files.delete.bind(files),
        } as unknown as R2Bucket,
      };
      const bytes = new TextEncoder().encode("same bytes");
      const first = putAttachment(slow, vault, { bytes, name: "a.txt", source: "upload" });
      await waitFor(async () => (await attachmentCount(user.id)) === 1);
      const second = await putAttachment(env, vault, { bytes, name: "b.txt", source: "upload" });
      expect(second).toMatchObject({ ok: false, code: "BUSY" });
      g.open(false); // the first upload fails
      await expect(first).rejects.toThrow("put failed");
      const third = await putAttachment(env, vault, { bytes, name: "c.txt", source: "upload" });
      expect(third.ok && third.created).toBe(true);
    } finally {
      Object.assign(DEDUPE_WAIT, saved);
    }
  });

  it("PDF conversion admits at most two at once per user, including while budget admission is pending", async () => {
    const { user } = await makeUser("conv");
    const pdf = new TextEncoder().encode("%PDF-1.4 x");
    const results = await Promise.all([1, 2, 3, 4].map((i) => aiToMarkdown(env, user.id, `d${i}.pdf`, pdf, "application/pdf")));
    expect(results.filter(Boolean).length).toBe(2);
    expect(convertingNow(user.id)).toBe(0);
    // a refused budget releases the slot too
    expect(await aiToMarkdown({ ...env, AI_DAILY_TOKENS: "0" }, user.id, "x.pdf", pdf, "application/pdf")).toBeNull();
    expect(convertingNow(user.id)).toBe(0);
  });

  it("export reads every attachment, past the first 1,000", async () => {
    const { user } = await makeUser("many");
    const vault = await getVault(env, user.id);
    if (!vault || !env.FILES) throw new Error();
    const n = 1005;
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
       INSERT INTO attachments (id, user_id, vault_id, sha256, r2_key, name, mime, bytes, source, state, created_at, updated_at)
       SELECT printf('m%011d', i), ?1, ?2, printf('sha%d', i), printf('%s/m%d', ?2, i), printf('f%d.txt', i), 'text/plain', 1, 'upload', 'ready', '2026-01-01', '2026-01-01' FROM n`,
    )
      .bind(user.id, vault.id, n)
      .run();
    const ids: string[] = [];
    for await (const r of readyAttachments(env, vault, 400)) ids.push(r.id);
    expect(ids.length).toBe(n);
    expect(new Set(ids).size).toBe(n);
    // and the export itself includes the 1,001st+ (objects for a few at the end)
    for (const i of [1001, 1003, 1005]) await env.FILES.put(`${vault.id}/m${i}`, "x");
    const { exportAttachments } = await import("../src/capture/files");
    const out = await exportAttachments(env, vault);
    expect(Object.keys(out.files).sort()).toEqual([
      "attachments/m00000001001-f1001.txt",
      "attachments/m00000001003-f1003.txt",
      "attachments/m00000001005-f1005.txt",
    ]);
  });

  it("exports attachments with links rewritten to relative paths", async () => {
    const { user, cookie } = await makeUser("exp");
    const j = (await (await upload(cookie, PNG, "dot.png", "image/png")).json()) as { id: string; markdown: string };
    const { stub, ref } = await defaultVault(user.id);
    await stub.writeNote(
      ref,
      { userId: user.id, username: user.username, client: "t", tool: "t" },
      { title: "Pics", directory: "a/b", content: `Look: ${j.markdown}\n` },
    );
    await freshReauth(user.id); // download is gated on a fresh passkey re-auth
    const zip = unzipSync(new Uint8Array(await (await fetchWorker("/export", { headers: { cookie } })).arrayBuffer()));
    const att = Object.keys(zip).find((k) => k.startsWith("main/attachments/"));
    expect(att).toBe(`main/attachments/${j.id}-dot.png`);
    expect(zip[att ?? ""]).toEqual(PNG);
    const note = strFromU8(zip["main/a/b/Pics.md"]);
    expect(note).toContain(`](../../attachments/${j.id}-dot.png)`);
    expect(note).not.toContain("/app/files/");
  });

  it("MCP: attach_file stores base64 and links it into a note; read_note lists attachments", async () => {
    const { user, cookie } = await makeUser("mcp");
    const { stub, ref } = await defaultVault(user.id);
    await stub.writeNote(ref, { userId: user.id, username: user.username, client: "t", tool: "t" }, { title: "Gallery", content: "Pictures:\n" });
    const { accessToken } = await getAccessToken(cookie);
    const r = await callTool(accessToken, "attach_file", { data_base64: btoa(String.fromCharCode(...PNG)), filename: "dot.png", note: "gallery" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/attached dot\.png \(image\/png/);
    expect(r.content[0].text).toMatch(/saved main\/gallery rev/);
    const read = await callTool(accessToken, "read_note", { identifier: "gallery" });
    expect(read.content[0].text).toMatch(/attachments \(open the URLs signed in/);
    expect(read.content[0].text).toMatch(
      /- dot\.png \(image\/png, 1 KB\): An image named dot\.png\. — http:\/\/localhost:8787\/app\/files\/main\/[a-z0-9]{12}/,
    );
    const bad = await callTool(accessToken, "attach_file", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/^BLOCKED/);
  });
});

describe("capture: clipper", () => {
  it("refuses private, loopback, link-local and odd-port URLs", () => {
    for (const u of [
      "http://127.0.0.1/",
      "http://localhost:8787/",
      "http://10.0.0.5/",
      "http://172.20.1.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]/",
      "http://2130706433/", // 127.0.0.1 as an integer
      "http://0x7f.1/",
      "http://printer.local/",
      "http://example.com:8080/",
      "file:///etc/passwd",
      "http://user:pw@example.com/",
    ]) {
      expect(checkUrl(u).ok, u).toBe(false);
    }
    expect(checkUrl("https://example.com/a?b").ok).toBe(true);
    expect(blockedHost("100.64.0.1")).toBe("private address");
  });

  it("re-checks every redirect hop", async () => {
    const fake = (async (u: string) =>
      u.startsWith("https://public.example/")
        ? new Response(null, { status: 302, headers: { location: "http://10.1.2.3/admin" } })
        : new Response("secret")) as unknown as typeof fetch;
    const r = await safeFetch("https://public.example/go", { fetcher: fake });
    expect(r).toMatchObject({ ok: false, code: "BLOCKED" });
  });

  const form = (cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) => ({
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  const counting = (respond: (u: string) => Response) => {
    const calls: string[] = [];
    const f = (async (u: string) => {
      calls.push(String(u));
      return respond(String(u));
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it("GET /app/clip (any link, the bookmarklet, the share target) never fetches, stores or charges", async () => {
    const { user, cookie } = await makeUser("clipget");
    const app = createApp();
    const fake = counting(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const before = await bytesUsed(user.id);
    // A cross-site top-level navigation carries the Lax cookie and no Origin: it must stay a preview.
    const res = await app.request(
      `${BASE}/app/clip?url=${encodeURIComponent("https://attacker.example/payload.bin")}`,
      { headers: { cookie } },
      {
        ...env,
        CAPTURE_FETCH: fake.f,
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="fetch"');
    expect(html).toContain("](https://attacker.example/payload.bin)");
    expect(fake.calls).toEqual([]);
    expect(await attachmentCount(user.id)).toBe(0);
    expect(await bytesUsed(user.id)).toBe(before);
    const { vault } = await defaultVault(user.id);
    expect((await env.FILES?.list({ prefix: `${vault.id}/` }))?.objects.length).toBe(0);
  });

  it("fetches page text only on a same-origin POST, with the built-in converter, and saves to clips/ with source_url", async () => {
    const { user, cookie } = await makeUser("clip");
    const page = `<html><head><title>A Great Article</title></head><body><nav>menu junk</nav><article><h1>Big idea</h1><p>First <em>point</em>.</p><ul><li>one</li><li>two</li></ul></article><footer>footer junk</footer></body></html>`;
    const fake = counting(() => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }));
    const app = createApp();
    const testEnv = { ...env, CAPTURE_FETCH: fake.f };
    const fields = { action: "fetch", url: "https://news.example/story", title: "", folder: "clips", tags: "", comment: "", content: "", project: "main" };
    expect((await app.request(`${BASE}/app/clip`, form(cookie, fields, "https://evil.example"), testEnv)).status).toBe(403);
    expect((await app.request(`${BASE}/app/clip`, form(cookie, fields, null), testEnv)).status).toBe(403);
    expect(fake.calls).toEqual([]);
    const res = await app.request(`${BASE}/app/clip`, form(cookie, fields), testEnv);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(fake.calls).toEqual(["https://news.example/story"]);
    expect(html).toContain('value="A Great Article"');
    expect(html).toContain("# Big idea");
    expect(html).toContain("- one");
    expect(html).not.toContain("menu junk");
    expect(html).not.toContain("footer junk");
    expect(await attachmentCount(user.id)).toBe(0);

    const save = await app.request(
      `${BASE}/app/clip`,
      form(cookie, {
        action: "save",
        url: "https://news.example/story",
        title: "A Great Article",
        folder: "clips",
        tags: "reading, ai",
        comment: "Worth a reread.",
        content: "# Big idea\n\nFirst _point_.",
        project: "main",
      }),
      testEnv,
    );
    expect(save.status).toBe(200);
    expect(await save.text()).toContain("data-close-window");
    const { stub, ref } = await defaultVault(user.id);
    const r = await stub.readNote(ref, { identifier: "clips/a-great-article" });
    if (!r.ok || !r.value.content) throw new Error("clip not saved");
    expect(r.value.content).toContain("source_url: https://news.example/story");
    expect(r.value.content).toContain("source: clip");
    expect(r.value.content).toMatch(/Worth a reread\.\n\n---\n\n# Big idea/);
    expect(r.value.note.tags).toEqual(["reading", "ai"]);
  });

  it("a fetched file is only described; it is stored (and charged) when the clip is saved", async () => {
    const { user, cookie } = await makeUser("clipfile");
    const fake = counting(() => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const app = createApp();
    const testEnv = { ...env, CAPTURE_FETCH: fake.f };
    const base = { url: "https://img.example/dot.png", folder: "clips", tags: "", comment: "", content: "", project: "main" };
    const before = await bytesUsed(user.id);
    const pre = await (await app.request(`${BASE}/app/clip`, form(cookie, { ...base, action: "fetch", title: "" }), testEnv)).text();
    expect(pre).toContain('name="attach" value="1"');
    expect(pre).toMatch(/Save stores it as an attachment/);
    expect(await attachmentCount(user.id)).toBe(0);
    expect(await bytesUsed(user.id)).toBe(before);
    const save = await app.request(
      `${BASE}/app/clip`,
      form(cookie, { ...base, action: "save", attach: "1", title: "A dot", content: "— [img](https://img.example/dot.png)" }),
      testEnv,
    );
    expect(save.status).toBe(200);
    expect(await attachmentCount(user.id)).toBe(1);
    expect(await bytesUsed(user.id)).toBeGreaterThan(before);
    const { stub, ref } = await defaultVault(user.id);
    const r = await stub.readNote(ref, { identifier: "clips/a-dot" });
    expect(r.ok && r.value.content).toMatch(/!\[An image named dot\.png\.\]\(\/app\/files\/main\/[a-z0-9]{12}\)/);
  });

  it("selection mode keeps the selection and link without fetching; private URLs are refused on fetch", async () => {
    const { cookie } = await makeUser("sel");
    const app = createApp();
    const boom = (async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    const sel = await app.request(
      `${BASE}/app/clip?url=${encodeURIComponent("https://ex.example/p")}&title=Page&sel=${encodeURIComponent("quoted line")}`,
      { headers: { cookie } },
      { ...env, CAPTURE_FETCH: boom },
    );
    const sh = await sel.text();
    expect(sh).toContain("&gt; quoted line");
    expect(sh).toContain("— [Page](https://ex.example/p)");
    const priv = await fetchWorker("/app/clip", form(cookie, { action: "fetch", url: "http://127.0.0.1/app/settings", title: "x", project: "main" }));
    expect(priv.status).toBe(200);
    expect(await priv.text()).toMatch(/Couldn(&#39;|')t fetch the page \(Refused: private address\.\)/);
    // phones share the link inside `text`
    const share = await app.request(
      `${BASE}/app/clip?title=T&text=${encodeURIComponent("look at this https://ex.example/x")}`,
      { headers: { cookie } },
      { ...env, CAPTURE_FETCH: boom },
    );
    expect(await share.text()).toContain("[T](https://ex.example/x)");
    expect((await fetchWorker("/app/clip?url=https://ex.example/")).status).toBe(302);
  });

  it("converts HTML to markdown without leaking scripts", () => {
    const md = htmlToMarkdown(
      '<h2>T</h2><p>a <a href="javascript:alert(1)">bad</a> <a href="/rel">rel</a> &amp; <code>x</code></p><blockquote><p>q</p></blockquote><pre>code\n  line</pre><img src="data:image/png;base64,AA" alt="d"><img src="https://i.example/p.png" alt="p">',
      "https://base.example/dir/",
    );
    expect(md).toContain("## T");
    expect(md).not.toContain("javascript:");
    expect(md).toContain("[rel](https://base.example/rel)");
    expect(md).toContain("&");
    expect(md).toContain("`x`");
    expect(md).toContain("> q");
    expect(md).toContain("```\ncode\n  line\n```");
    expect(md).not.toContain("data:image");
    expect(md).toContain("![p](https://i.example/p.png)");
  });
});
