import { env } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/directory";
import { caller, defaultVault, freshReauth, makeUser } from "./helpers";
import { fetchWorker } from "./oauth";

describe("viewer", () => {
  it("serves the landing page and /connect, and redirects signed-in users to /app", async () => {
    const res = await fetchWorker("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/signup");
    expect(res.headers.get("content-security-policy")).toContain("style-src 'self' 'unsafe-inline'");
    const connect = await fetchWorker("/connect");
    expect(connect.status).toBe(200);
    expect(await connect.text()).toContain("claude mcp add --transport http cairn");
    const { cookie } = await makeUser();
    const r2 = await fetchWorker("/", { headers: { cookie } });
    expect(r2.status).toBe(302);
    expect(r2.headers.get("location")).toBe("/app");
    expect((await fetchWorker("/app")).status).toBe(302);
  });

  it("renders notes inertly: no script, no javascript: links, no raw HTML", async () => {
    const { user, cookie } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    await stub.writeNote(ref, caller(user), {
      title: 'Evil <script>alert("t")</script>',
      content: [
        "<script>alert(1)</script>",
        '<img src=x onerror="alert(2)">',
        "[click me](javascript:alert(3))",
        "[data](data:text/html;base64,PHNjcmlwdD5hbGVydCg0KTwvc2NyaXB0Pg==)",
        "[[<b>bold</b> target]]",
        "- [cat<script>] obs <i>x</i>",
        '- rel [[Thing" onmouseover="alert(5)]]',
      ].join("\n\n"),
    });
    const listing = await stub.listDirectory(ref, {});
    const permalink = listing.notes[0].permalink;
    const res = await fetchWorker(`/app/v/main/n/${permalink}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(html).not.toMatch(/<script>alert/i);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/href="data:/i);
    expect(html).not.toContain("<b>bold</b>");
    expect(html).not.toContain("<i>x</i>");
    expect(html).not.toMatch(/onmouseover="alert/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // the only scripts are our own
    const scripts = [...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toContain('<script type="module" src="/app/cairn/passkey.js">');
    for (const tag of scripts) expect(tag).toMatch(/^<script (type="module" )?src="\/app\/(cairn|dist|ui)\/[a-z]+\.js"( defer)?>$/);
  });

  it("shows backlinks and unresolved links", async () => {
    const { user, cookie } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    await stub.writeNote(ref, caller(user), { title: "Hub", content: "Links to [[Spoke]] and [[Ghost]]." });
    await stub.writeNote(ref, caller(user), { title: "Spoke", content: "spoke" });
    const hub = await (await fetchWorker("/app/v/main/n/hub", { headers: { cookie } })).text();
    expect(hub).toContain('<a href="/app/v/main/n/spoke" class="wikilink">Spoke</a>');
    expect(hub).toMatch(/class="wikilink unresolved"[^>]*>Ghost</);
    const spoke = await (await fetchWorker("/app/v/main/n/spoke", { headers: { cookie } })).text();
    expect(spoke).toContain('href="/app/v/main/n/hub"');
  });

  it("exports a zip of markdown exactly as stored, with an index", async () => {
    const { user, cookie } = await makeUser();
    const { stub, ref } = await defaultVault(user.id);
    const w = await stub.writeNote(ref, caller(user), { title: "Dana Roe", directory: "people", content: "- works_at [[Acme Corp]]\n" });
    if (!w.ok) throw new Error();
    const stored = await stub.readNote(ref, { identifier: "people/dana-roe" });
    await freshReauth(user.id);
    const res = await fetchWorker("/export", { headers: { cookie } });
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["README.md", "account.json", "main/people/Dana Roe.md"]);
    expect(strFromU8(files["main/people/Dana Roe.md"])).toBe(stored.ok ? stored.value.content : "");
    expect(strFromU8(files["README.md"])).toContain("[Dana Roe](main/people/Dana%20Roe.md)");
    const raw = await fetchWorker("/app/v/main/raw/people/dana-roe", { headers: { cookie } });
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(await raw.text()).toContain("- works_at [[Acme Corp]]");
  });

  it("requires sign-in for app pages and export", async () => {
    for (const p of ["/app", "/app/settings", "/app/search?q=x", "/export", "/app/v/main"]) {
      const r = await fetchWorker(p);
      expect(r.status, p).toBe(302);
      expect(r.headers.get("location")).toMatch(/^\/login\?next=/);
    }
  });

  it("accepts personal access tokens on /mcp and honours their scope", async () => {
    const { user } = await makeUser();
    const rw = await createPat(env, user.id, "cli", ["memory:read", "memory:write"], 30);
    const ro = await createPat(env, user.id, "ro", ["memory:read"], null);
    const { callTool } = await import("./oauth");
    const w = await callTool(rw, "write_note", { title: "From PAT", content: "hello" });
    expect(w.content[0].text).toMatch(/^saved main\/from-pat/);
    const r = await callTool(ro, "read_note", { identifier: "from-pat" });
    expect(r.content[0].text).toContain("by token: cli");
    const denied = await callTool(ro, "write_note", { title: "x", content: "y" });
    expect(denied.content[0].text).toMatch(/^FORBIDDEN/);
    const bad = await fetchWorker("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer cairn_pat_nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(bad.status).toBe(401);
  });
});
