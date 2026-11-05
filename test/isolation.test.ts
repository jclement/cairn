import { env } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createVault } from "../src/directory";
import { caller, defaultVault, freshReauth, makeUser } from "./helpers";
import { callTool, fetchWorker, getAccessToken } from "./oauth";

describe("user isolation: B can never see A's notes", () => {
  it("through every MCP tool and every web route", async () => {
    const a = await makeUser("alice");
    const b = await makeUser("bob");
    const av = await defaultVault(a.user.id);
    await av.stub.writeNote(av.ref, caller(a.user), { title: "Alice Secret", content: "zebra-password-hint" });
    const priv = await createVault(env, a.user.id, "private");
    if (!priv.ok) throw new Error(priv.message);
    await env.VAULT.getByName(priv.vault.id).writeNote({ id: priv.vault.id, name: "private", ownerId: a.user.id }, caller(a.user), {
      title: "Diary",
      content: "zebra diary",
    });

    const { accessToken } = await getAccessToken(b.cookie);
    for (const [tool, args] of [
      ["read_note", { identifier: "alice-secret" }],
      ["read_note", { identifier: "Alice Secret" }],
      ["read_note", { identifier: "diary", project: "private" }],
      ["build_context", { identifier: "alice-secret" }],
      ["edit_note", { identifier: "alice-secret", command: "append", content: "pwned" }],
      ["delete_note", { identifier: "alice-secret" }],
      ["list_notes", { project: "private" }],
      ["search_notes", { query: "zebra", project: "private" }],
    ] as const) {
      const r = await callTool(accessToken, tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(r.content[0].text).toMatch(/^NOT_FOUND/);
    }
    const s = await callTool(accessToken, "search_notes", { query: "zebra" });
    expect(s.content[0].text).toMatch(/^No matches/);
    const p = await callTool(accessToken, "projects", { command: "list" });
    expect(p.content[0].text).not.toContain("private");
    // B writing a same-named note lands in B's vault and leaves A's untouched
    await callTool(accessToken, "write_note", { title: "Alice Secret", content: "bob's own" });
    const still = await av.stub.readNote(av.ref, { identifier: "alice-secret" });
    expect(still.ok && still.value.content).toContain("zebra-password-hint");

    await freshReauth(b.user.id);
    const h = { cookie: b.cookie };
    expect((await fetchWorker("/app/v/main/n/alice-secret", { headers: h })).status).toBe(200); // B's own copy
    expect(await (await fetchWorker("/app/v/main/n/alice-secret", { headers: h })).text()).not.toContain("zebra");
    expect((await fetchWorker("/app/v/private", { headers: h })).status).toBe(404);
    expect((await fetchWorker("/app/v/private/n/diary", { headers: h })).status).toBe(404);
    expect((await fetchWorker("/app/v/private/raw/diary", { headers: h })).status).toBe(404);
    expect((await fetchWorker("/export/private", { headers: h })).status).toBe(404);
    expect(await (await fetchWorker("/app/search?q=zebra", { headers: h })).text()).toContain("No matches");
    // Naming someone else's project is a 404, not a silent fallback to your own.
    expect((await fetchWorker("/app/search?q=zebra&v=private", { headers: h })).status).toBe(404);
    expect((await fetchWorker("/app/search?q=zebra&project=private", { headers: h })).status).toBe(404);
    const zip = unzipSync(new Uint8Array(await (await fetchWorker("/export", { headers: h })).arrayBuffer()));
    for (const [path, bytes] of Object.entries(zip)) {
      expect(path).not.toContain("private");
      expect(strFromU8(bytes)).not.toContain("zebra");
    }
  });
});
