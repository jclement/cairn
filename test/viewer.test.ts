import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createVault } from "../src/directory";
import { createApp } from "../src/web/app";
import { renderMarkdown } from "../src/web/render";
import { BASE, caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { fetchWorker } from "./oauth";

const json = (cookie: string, body: unknown, origin: string | null = ORIGIN) =>
  ({
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  }) satisfies RequestInit;

async function seed() {
  const u = await makeUser();
  const { stub, ref } = await defaultVault(u.user.id);
  await stub.writeNote(ref, caller(u.user), {
    title: "Coffee Brewing",
    directory: "kitchen",
    tags: ["drinks"],
    note_type: "guide",
    content: "Pour over needs a gooseneck kettle.\n\n- [technique] Bloom the grounds for 30 seconds\n- relates_to [[Tea Steeping]]\n- requires [[Kettle]]\n",
  });
  await stub.writeNote(ref, caller(u.user), { title: "Tea Steeping", directory: "kitchen", content: "Green tea at 80C. See [[Coffee Brewing]]." });
  await stub.writeNote(ref, caller(u.user), { title: "Lonely", content: "No links at all." });
  return { ...u, stub, ref };
}

describe("viewer: search API and page", () => {
  it("searches with highlights-ready matches, filters and counts", async () => {
    const { cookie } = await seed();
    const r = await fetchWorker("/app/api/search?q=kettle", { headers: { cookie } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { total: number; strong: boolean; hits: { title: string; href: string; matches: { text: string }[]; strong: boolean }[] };
    expect(j.total).toBeGreaterThan(0);
    expect(j.strong).toBe(true);
    const coffee = j.hits.find((h) => h.title === "Coffee Brewing");
    expect(coffee?.href).toBe("/app/v/main/n/kitchen/coffee-brewing");
    expect(coffee?.matches.some((m) => m.text.includes("kettle"))).toBe(true);

    const typed = (await (await fetchWorker("/app/api/search?q=tea&type=guide", { headers: { cookie } })).json()) as { hits: { title: string }[] };
    expect(typed.hits.map((h) => h.title)).toEqual(["Coffee Brewing"]);
    const byTag = (await (await fetchWorker("/app/api/search?tag=drinks", { headers: { cookie } })).json()) as { hits: { title: string }[] };
    expect(byTag.hits.map((h) => h.title)).toEqual(["Coffee Brewing"]);
    const byFolder = (await (await fetchWorker("/app/api/search?folder=kitchen&since=7d", { headers: { cookie } })).json()) as { total: number };
    expect(byFolder.total).toBe(2);
    expect((await fetchWorker("/app/api/search?q=x")).status).toBe(401);
  });

  it("renders results server-side for no-JS, with <mark> highlights and escaped text", async () => {
    const { cookie, stub, ref, user } = await seed();
    await stub.writeNote(ref, caller(user), { title: "Kettle <b>evil</b>", content: "a kettle <script>alert(1)</script>" });
    const html = await (await fetchWorker("/app/search?q=kettle", { headers: { cookie } })).text();
    expect(html).toContain("<mark>Kettle</mark>");
    expect(html).toContain('name="type"');
    expect(html).toMatch(/\d+ results?/);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<b>evil</b>");
    const empty = await (await fetchWorker("/app/search?q=zzzqqq", { headers: { cookie } })).text();
    expect(empty).toContain('data-state="empty"');
  });
});

describe("viewer: titles and graph APIs", () => {
  it("lists titles with an ETag", async () => {
    const { cookie } = await seed();
    const r = await fetchWorker("/app/api/titles", { headers: { cookie } });
    const j = (await r.json()) as { notes: { title: string; href: string }[] };
    expect(j.notes.map((n) => n.title).sort()).toEqual(["Coffee Brewing", "Lonely", "Tea Steeping"]);
    const etag = r.headers.get("etag") ?? "";
    expect((await fetchWorker("/app/api/titles", { headers: { cookie, "if-none-match": etag } })).status).toBe(304);
  });

  it("returns nodes, typed edges and ghost nodes; 304 until the vault changes", async () => {
    const { cookie, stub, ref, user } = await seed();
    const r = await fetchWorker("/app/api/graph", { headers: { cookie } });
    expect(r.status).toBe(200);
    const g = (await r.json()) as { nodes: { id: string; ghost?: boolean }[]; edges: { source: string; target: string; type: string }[] };
    expect(g.nodes.find((n) => n.id === "ghost:kettle")?.ghost).toBe(true);
    expect(g.edges).toContainEqual({ source: "kitchen/coffee-brewing", target: "kitchen/tea-steeping", type: "relates_to" });
    expect(g.edges).toContainEqual({ source: "kitchen/tea-steeping", target: "kitchen/coffee-brewing", type: "links_to" });
    expect(g.edges).toContainEqual({ source: "kitchen/coffee-brewing", target: "ghost:kettle", type: "requires" });
    expect(g.nodes.some((n) => n.id === "lonely")).toBe(true);
    const etag = r.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\/"g-/);
    expect((await fetchWorker("/app/api/graph", { headers: { cookie, "if-none-match": etag } })).status).toBe(304);
    await stub.writeNote(ref, caller(user), { title: "Kettle", content: "now real" });
    const r2 = await fetchWorker("/app/api/graph", { headers: { cookie, "if-none-match": etag } });
    expect(r2.status).toBe(200);
    const g2 = (await r2.json()) as { nodes: { id: string }[]; edges: { target: string }[] };
    expect(g2.nodes.some((n) => n.id === "ghost:kettle")).toBe(false);
    expect(g2.edges.some((e) => e.target === "kettle")).toBe(true);
  });

  it("isolates users: B cannot graph, search or list A's project", async () => {
    const a = await seed();
    const created = await createVault(env, a.user.id, "secret-a");
    if (!created.ok) throw new Error(created.message);
    const b = await makeUser("bee");
    for (const path of ["/app/api/graph?project=secret-a", "/app/api/titles?project=secret-a", "/app/api/search?q=kettle&project=secret-a"]) {
      expect((await fetchWorker(path, { headers: { cookie: b.cookie } })).status).toBe(404);
    }
    // B's own default project is B's, not A's
    const g = (await (await fetchWorker("/app/api/graph", { headers: { cookie: b.cookie } })).json()) as { nodes: unknown[] };
    expect(g.nodes).toEqual([]);
    expect((await fetchWorker("/app/graph?project=secret-a", { headers: { cookie: b.cookie } })).status).toBe(404);
    const save = await fetchWorker("/app/api/notes", json(b.cookie, { project: "secret-a", title: "Intrude", content: "x" }));
    expect(save.status).toBe(404);
  });
});

describe("viewer: editing", () => {
  it("creates, edits with the checksum guard, reports conflicts, deletes; writes are by client web", async () => {
    const { cookie, user, stub, ref } = await seed();
    const created = await fetchWorker("/app/api/notes", json(cookie, { title: "Draft Idea", folder: "ideas", content: "First [[Lonely]] thought." }));
    expect(created.status).toBe(201);
    const c = (await created.json()) as { note: { permalink: string; checksum: string }; href: string; content: string };
    expect(c.href).toBe("/app/v/main/n/ideas/draft-idea");
    expect(c.content).toContain("title: Draft Idea");
    const read = await stub.readNote(ref, { identifier: c.note.permalink });
    if (!read.ok) throw new Error();
    expect(read.value.note.updated_by_client).toBe("web");
    const revs = await stub.revisions(ref, c.note.permalink);
    expect(revs[0]).toMatchObject({ client: "web", tool: "web_create", username: user.username });

    // duplicate create refused
    expect((await fetchWorker("/app/api/notes", json(cookie, { title: "Draft Idea", folder: "ideas", content: "dup" }))).status).toBe(409);

    const edited = await fetchWorker(
      "/app/api/notes",
      json(cookie, { permalink: c.note.permalink, content: `${c.content}\nMore.`, expected_checksum: c.note.checksum, folder: "ideas" }),
    );
    expect(edited.status).toBe(200);
    const e = (await edited.json()) as { note: { checksum: string } };

    // a stale checksum is a conflict that carries the newer version
    const stale = await fetchWorker(
      "/app/api/notes",
      json(cookie, { permalink: c.note.permalink, content: "mine", expected_checksum: c.note.checksum, folder: "ideas" }),
    );
    expect(stale.status).toBe(409);
    const s = (await stale.json()) as { code: string; current: { checksum: string; content: string } };
    expect(s.code).toBe("REVISION_CONFLICT");
    expect(s.current.checksum).toBe(e.note.checksum);
    expect(s.current.content).toContain("More.");
    // no checksum at all is refused too (never a blind overwrite)
    expect((await fetchWorker("/app/api/notes", json(cookie, { permalink: c.note.permalink, content: "blind" }))).status).toBe(409);

    // rename via the title field wins over the frontmatter title
    const renamed = await fetchWorker(
      "/app/api/notes",
      json(cookie, { permalink: c.note.permalink, title: "Better Idea", content: s.current.content, expected_checksum: e.note.checksum, folder: "ideas" }),
    );
    expect(renamed.status).toBe(200);
    const rn = (await renamed.json()) as { note: { title: string; checksum: string } };
    expect(rn.note.title).toBe("Better Idea");

    const del = await fetchWorker("/app/api/notes/delete", json(cookie, { permalink: c.note.permalink, expected_checksum: rn.note.checksum }));
    expect(del.status).toBe(200);
    expect((await stub.readNote(ref, { identifier: c.note.permalink })).ok).toBe(false);
  });

  it("refuses cross-origin and origin-less POSTs (CSRF)", async () => {
    const { cookie } = await seed();
    for (const origin of ["https://evil.example", null]) {
      const r = await fetchWorker("/app/api/notes", json(cookie, { title: "CSRF", content: "x" }, origin));
      expect(r.status).toBe(403);
      const f = await fetchWorker("/app/editor/save", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
        body: "title=CSRF&content=x",
      });
      expect(f.status).toBe(403);
    }
    expect((await fetchWorker("/app/api/titles", { headers: { cookie } }).then((r) => r.json())) as { notes: { title: string }[] }).not.toMatchObject({
      notes: expect.arrayContaining([expect.objectContaining({ title: "CSRF" })]),
    });
  });

  it("works without JS: editor page, form save, conflict re-arms the form", async () => {
    const { cookie, stub, ref, user } = await seed();
    const page = await (await fetchWorker("/app/v/main/edit/lonely", { headers: { cookie } })).text();
    expect(page).toContain('<textarea name="content"');
    const checksum = /name="expected_checksum" value="([0-9a-f]+)"/.exec(page)?.[1] ?? "";
    expect(checksum).toMatch(/^[0-9a-f]{16,}$/);
    const form = (content: string, sum: string) =>
      new URLSearchParams({ project: "main", permalink: "lonely", title: "Lonely", folder: "", content, expected_checksum: sum }).toString();
    const ok = await fetchWorker("/app/editor/save", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form("Edited without JS.", checksum),
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/app/v/main/n/lonely");
    await stub.writeNote(ref, caller(user), { identifier: "lonely", content: "agent wrote this", overwrite: true });
    const conflict = await fetchWorker("/app/editor/save", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form("my stale edit", checksum),
    });
    expect(conflict.status).toBe(409);
    const html = await conflict.text();
    expect(html).toContain("Someone else changed this note");
    expect(html).toContain("my stale edit");
    expect(html).not.toContain(`value="${checksum}"`);
    expect((await fetchWorker("/app/new?title=Hello", { headers: { cookie } }).then((r) => r.text())).includes('value="Hello"')).toBe(true);
  });
});

describe("viewer: note page rendering", () => {
  const render = (md: string, links: Record<string, string | null> = {}) => renderMarkdown(md, { vault: "main", links });

  it("renders GFM: tables, tasks, footnotes, callouts, anchors, code, mermaid, images, links", () => {
    const html = render(
      [
        "## Plan *now*",
        "| a | b |\n|---|---|\n| 1 | ~~2~~ |",
        "- [ ] todo\n- [x] done",
        "- [fact] Water boils at 100C",
        "- depends_on [[Kettle]]",
        "Text with a note.[^1]\n\n[^1]: The footnote.",
        "> [!warning] Hot\n> Careful.",
        "```ts\nconst x: number = 1;\n```",
        "```mermaid\ngraph TD; A-->B\n```",
        "![a cat](https://example.com/cat.png)",
        "[ext](https://example.com) and [mem](memory://main/kitchen/tea) and https://auto.example",
      ].join("\n\n"),
      { Kettle: "kettle" },
    );
    expect(html).toContain('<h2 id="plan-now">');
    expect(html).toContain('<a class="anchor" href="#plan-now"');
    expect(html).toContain("<table>");
    expect(html).toContain("<s>2</s>");
    expect(html).toMatch(/<input type="checkbox" class="task" disabled aria-label="to do">/);
    expect(html).toMatch(/<input type="checkbox" class="task" disabled checked aria-label="done">/);
    expect(html).toContain('<span class="obs-chip" data-cat="fact">fact</span>');
    expect(html).toContain('<span class="rel-badge">depends_on</span>');
    expect(html).toContain('class="footnote-ref"');
    expect(html).toContain('<blockquote class="callout callout-warning" data-callout="warning">');
    expect(html).toContain('<span class="callout-title">Hot</span>');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<span class="code-lang">ts</span>');
    expect(html).toContain('<figure class="mermaid-block"><pre class="mermaid-src"><code>graph TD; A--&gt;B');
    expect(html).toMatch(/<img src="https:\/\/example.com\/cat.png" alt="a cat" loading="lazy" decoding="async" class="zoomable">/);
    expect(html).toMatch(/<a href="https:\/\/example.com" rel="noopener noreferrer nofollow" target="_blank" class="external">ext<\/a>/);
    expect(html).toContain('href="/app/v/main/n/kitchen/tea"');
    expect(html).toContain('href="https://auto.example"');
  });

  it("stays inert on hostile input in code, mermaid, footnotes, callouts and links", () => {
    const html = render(
      [
        "```html\n<script>alert(1)</script>\n```",
        "```mermaid\ngraph TD; A-->B\nclick A call alert(1)\n</code></pre><script>alert(2)</script>\n```",
        "Note[^x]\n\n[^x]: [bad](javascript:alert(3)) <img src=x onerror=alert(4)>",
        "> [!note] <script>alert(5)</script>\n> body",
        "![x](javascript:alert(6)) [y](vbscript:alert(7)) [z](data:text/html,alert(8))",
        '[[Ghost" onmouseover="alert(9)]]',
        '```"><script>alert(10)</script>\nx\n```',
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toMatch(/href="(javascript|vbscript|data):/i);
    expect(html).not.toMatch(/src="javascript:/i);
    expect(html).not.toMatch(/ onmouseover="/i);
    expect(html).toContain("click A call alert(1)"); // stays as escaped source; mermaid runs with securityLevel strict
  });

  it("serves a note page with side panel, mermaid bundle only when needed, and unresolved links that offer creation", async () => {
    const { cookie, stub, ref, user } = await seed();
    const page = await (await fetchWorker("/app/v/main/n/kitchen/coffee-brewing", { headers: { cookie } })).text();
    expect(page).toContain('class="note-side"');
    expect(page).toContain("Backlinks");
    expect(page).toContain('data-graph="local"');
    expect(page).toContain('href="/app/new?project=main&amp;title=Kettle"');
    expect(page).not.toContain("/app/dist/mermaid.js");
    await stub.writeNote(ref, caller(user), { title: "Diagram", content: "```mermaid\ngraph LR; A-->B\n```\n" });
    const d = await (await fetchWorker("/app/v/main/n/diagram", { headers: { cookie } })).text();
    expect(d).toContain('<script type="module" src="/app/dist/mermaid.js">');
  });
});

describe("viewer: dev login and bundles", () => {
  it("dev login exists only when DEV_LOGIN is 1", async () => {
    const app = createApp();
    const off = await app.request(`${BASE}/app/dev-login?u=devperson`, {}, { ...env, DEV_LOGIN: undefined });
    expect(off.status).toBe(404);
    const on = await app.request(`${BASE}/app/dev-login?u=devperson`, {}, { ...env, DEV_LOGIN: "1" });
    expect(on.status).toBe(303);
    expect(on.headers.get("set-cookie")).toContain("__Host-cairn_session=");
  });

  it("serves the built client bundles as static assets", async () => {
    if (!env.ASSETS) throw new Error("no ASSETS binding");
    for (const name of ["app", "search", "editor", "graph", "mermaid"]) {
      const r = await env.ASSETS.fetch(new Request(`${BASE}/app/dist/${name}.js`));
      expect(r.status, name).toBe(200);
      const text = await r.text();
      expect(text.length, name).toBeGreaterThan(500);
    }
    const m = await env.ASSETS.fetch(new Request(`${BASE}/app/dist/mermaid/mermaid.esm.min.mjs`));
    expect(m.status).toBe(200);
  });
});
