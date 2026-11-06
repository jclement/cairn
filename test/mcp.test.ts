import { describe, expect, it } from "vitest";
import { makeUser } from "./helpers";
import { callTool, fetchWorker, getAccessToken, mcp } from "./oauth";

describe("MCP over OAuth", () => {
  it("rejects /mcp without a token: 401 + WWW-Authenticate pointing at resource metadata", async () => {
    const res = await fetchWorker("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toMatch(/^Bearer /);
    expect(www).toContain("resource_metadata=");
    const metaUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1] ?? "";
    const meta = await fetchWorker(new URL(metaUrl).pathname);
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("http://localhost:8787/mcp");
    expect(body.authorization_servers[0]).toBe("http://localhost:8787");
  });

  it("publishes authorization server metadata with CIMD, S256 and offline_access", async () => {
    const res = await fetchWorker("/.well-known/oauth-authorization-server");
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.scopes_supported).toEqual(expect.arrayContaining(["memory:read", "memory:write", "offline_access"]));
    // What clients request comes from the resource metadata and the 401: read and write, so the
    // consent page offers write ticked (Claude requests exactly these; oauth-live found read-only grants).
    const prm = (await (await fetchWorker("/.well-known/oauth-protected-resource/mcp")).json()) as { scopes_supported: string[] };
    expect(prm.scopes_supported).toEqual(["memory:read", "memory:write"]);
    const anon = await fetchWorker("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(anon.headers.get("www-authenticate")).toContain('scope="memory:read memory:write"');
    expect(m.registration_endpoint).toBe("http://localhost:8787/oauth/register");
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(["none"]));
  });

  it("redirects /authorize to sign-in when there is no session", async () => {
    const reg = await fetchWorker("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "X", redirect_uris: ["http://127.0.0.1:1/cb"], token_endpoint_auth_method: "none" }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "http://127.0.0.1:1/cb",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const res = await fetchWorker(`/authorize?${q}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/login\?next=%2Fauthorize/);
  });

  it("lists tools and round-trips write/read/search with receipts and provenance", async () => {
    const { cookie } = await makeUser();
    const { accessToken } = await getAccessToken(cookie);
    const init = await mcp(accessToken, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result?.serverInfo?.name).toBe("cairn");
    expect(init.result?.instructions).toContain("receipt");
    const list = await mcp(accessToken, "tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      [
        "attach_file",
        "build_context",
        "core_memory",
        "delete_note",
        "edit_note",
        "find_notes",
        "list_notes",
        "help",
        "log_miss",
        "move_note",
        "projects",
        "read_note",
        "recent_activity",
        "check_schema",
        "search_notes",
        "supersede",
        "write_note",
      ].sort(),
    );

    const w = await callTool(accessToken, "write_note", {
      title: "Cairn launch",
      directory: "projects",
      content: "- [goal] Ship the slice #launch\n- depends_on [[Vectorize]]",
    });
    expect(w.isError).toBeFalsy();
    expect(w.content[0].text).toMatch(
      /^saved main\/projects\/cairn-launch rev [0-9a-f]{8} at \S+ — http:\/\/localhost:8787\/app\/v\/main\/n\/projects\/cairn-launch/,
    );
    expect(w.content[0].text).toContain("unresolved links");

    const r = await callTool(accessToken, "read_note", { identifier: "projects/cairn-launch" });
    expect(r.content[0].text).toContain("updated");
    expect(r.content[0].text).toContain("by Test Client");
    expect(r.content[0].text).toContain("- [goal] Ship the slice #launch");

    const s = await callTool(accessToken, "search_notes", { query: "slice" });
    expect(s.content[0].text).toContain("Cairn launch — projects/cairn-launch");
    expect(s.content[0].text).toContain("[goal] Ship the slice #launch");

    const e = await callTool(accessToken, "edit_note", { identifier: "projects/cairn-launch", command: "append", content: "More.", expected_checksum: "nope" });
    expect(e.isError).toBe(true);
    expect(e.content[0].text).toMatch(/^REVISION_CONFLICT/);

    const missing = await callTool(accessToken, "read_note", { identifier: "nope/nothing" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/^NOT_FOUND/);

    const p = await callTool(accessToken, "projects", { command: "list" });
    expect(p.content[0].text).toContain("main (default) — 1 notes");
    const recent = await callTool(accessToken, "projects", { command: "recent" });
    expect(recent.content[0].text).toContain("by Test Client (write_note)");
    const ls = await callTool(accessToken, "list_notes", {});
    expect(ls.content[0].text).toContain("projects/");
    const ctx = await callTool(accessToken, "build_context", { identifier: "memory://projects/cairn-launch" });
    expect(ctx.content[0].text).toContain("depends_on [[Vectorize]] (unresolved)");
    const d = await callTool(accessToken, "delete_note", { identifier: "projects/cairn-launch" });
    expect(d.content[0].text).toMatch(/^deleted main\/projects\/cairn-launch/);
  });

  it("refuses writes on a read-only grant", async () => {
    const { cookie } = await makeUser();
    const { accessToken } = await getAccessToken(cookie, "memory:read");
    const w = await callTool(accessToken, "write_note", { title: "x", content: "y" });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toMatch(/^FORBIDDEN/);
    const s = await callTool(accessToken, "search_notes", { query: "x" });
    expect(s.isError).toBeFalsy();
  });
});
