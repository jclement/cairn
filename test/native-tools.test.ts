import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createPat } from "../src/directory";
import { BM_NAMES } from "../src/mcp/names";
import { makeUser } from "./helpers";
import { mcp, setWorkerEnv } from "./oauth";

const CAIRN = Object.values(BM_NAMES);
/** Cairn tools with no Basic Memory counterpart (so no bm_* alias). */
const NATIVE_ONLY = ["recent_activity", "log_miss"];

async function pat() {
  const { user } = await makeUser("native");
  return createPat(env, user.id, "native-tools", ["memory:read", "memory:write"], null);
}

async function toolNames(token: string): Promise<string[]> {
  const r = await mcp(token, "tools/list");
  return (r.result.tools as { name: string }[]).map((t) => t.name).sort();
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  return { text: r.error ? String(r.error.message) : String(r.result.content?.[0]?.text ?? ""), isError: !!r.error || !!r.result.isError };
}

describe("Cairn-native tool names; bm_* aliases only with BM_COMPAT", () => {
  afterEach(() => setWorkerEnv(null));

  it("default (BM_COMPAT unset or false): Cairn names only, and the bm_* names are unknown", async () => {
    for (const over of [null, { BM_COMPAT: "false" }]) {
      setWorkerEnv(over);
      const token = await pat();
      const names = await toolNames(token);
      expect(names).toEqual([...CAIRN, ...NATIVE_ONLY].sort());
      expect(names.some((n) => n.startsWith("bm_"))).toBe(false);
      expect((await call(token, "bm_search", { query: "x" })).isError).toBe(true);
    }
    // The checked-in config ships it off, at the top level and for local runs.
    expect(env.BM_COMPAT).toBe("false");
  });

  it("BM_COMPAT=true: every bm_* name is an alias with the same schema and handler", async () => {
    setWorkerEnv({ BM_COMPAT: "true" });
    const token = await pat();
    const r = await mcp(token, "tools/list");
    const tools = r.result.tools as { name: string; description: string; inputSchema: unknown }[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(tools.length).toBe(CAIRN.length + NATIVE_ONLY.length + Object.keys(BM_NAMES).length);
    for (const [bm, cairn] of Object.entries(BM_NAMES)) {
      const a = byName.get(bm);
      const c = byName.get(cairn);
      expect(a, bm).toBeDefined();
      expect(a?.inputSchema).toEqual(c?.inputSchema);
      expect(a?.description.startsWith(`Basic Memory name for ${cairn}.`)).toBe(true);
    }

    // The alias writes; the Cairn name reads it back (one handler, one vault).
    const w = await call(token, "bm_write", { title: "Alias Note", directory: "t", content: "alias body" });
    expect(w.isError).toBe(false);
    expect(w.text).toMatch(/^saved main\/t\/alias-note rev /);
    const rd = await call(token, "read_note", { identifier: "t/alias-note" });
    expect(rd.text).toContain("alias body");
    // Strict schemas hold for aliases too.
    expect((await call(token, "bm_read", { identifier: "t/alias-note", bogus: 1 })).text).toMatch(/INVALID/);

    // The manual documents Cairn's names only, and resolves the old ones.
    const index = (await call(token, "help", {})).text;
    expect(index).toContain("search-notes(3)");
    expect(index).toContain("recent-activity(3)");
    expect(index).not.toMatch(/bm-[a-z]+\(3\)/);
    expect((await call(token, "bm_man", { page: "bm_search" })).text).toContain("# search-notes(3)");
  });

  it("recent_activity is projects(command=recent) as its own tool", async () => {
    const token = await pat();
    expect((await call(token, "write_note", { title: "Fresh", directory: "r", content: "x" })).isError).toBe(false);
    const a = await call(token, "recent_activity", { since: "7d", output_format: "json" });
    const b = await call(token, "projects", { command: "recent", since: "7d", output_format: "json" });
    expect(a.isError).toBe(false);
    expect(JSON.parse(a.text)).toEqual(JSON.parse(b.text));
    expect(a.text).toContain("r/fresh");
    expect((await call(token, "recent_activity", { command: "recent" })).text).toMatch(/INVALID/);
    // Read-only grants may use it.
    const { user } = await makeUser("native-ro");
    const ro = await createPat(env, user.id, "ro", ["memory:read"], null);
    expect((await call(ro, "recent_activity", {})).isError).toBe(false);
  });
});
