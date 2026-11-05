// The self-hosting path: scripts/setup-cloudflare.mjs rewrites the top-level instance values in
// wrangler.jsonc (as text, keeping comments) and must leave env.local alone; and the public docs
// must not carry the maintainer's own instance values.
import { describe, expect, it } from "vitest";
import selfHosting from "../docs/SELF-HOSTING.md?raw";
import readme from "../README.md?raw";
import { parseJsonc, publicUrlOf, setInstanceValues } from "../scripts/lib/wrangler-config.mjs";
import wranglerConfig from "../wrangler.jsonc?raw";

describe("setup-cloudflare: wrangler.jsonc editing", () => {
  const original = parseJsonc(wranglerConfig);

  it("parses the shipped config", () => {
    expect(original.name).toBe("cairn");
    expect(original.env.local.vars.PUBLIC_URL).toBe("http://localhost:8787");
  });

  it("the top level is a clean template for the Deploy button", () => {
    expect(original.d1_databases).toEqual([{ binding: "DB", database_name: "cairn", migrations_dir: "migrations" }]);
    expect(original.kv_namespaces).toEqual([{ binding: "OAUTH_KV" }]);
    expect(original.r2_buckets).toEqual([{ binding: "FILES", bucket_name: "cairn-files" }]);
    expect(original.vectorize).toEqual([{ binding: "VECTORIZE", index_name: "cairn-notes" }]);
    expect(original.routes).toEqual([]);
    expect(original.vars.PUBLIC_URL).toBe("");
    expect(original.vars.OPEN_SIGNUP).toBe("false");
    expect(original.vars.INBOUND_EMAIL_ADDRESS).toBeUndefined();
    const top = JSON.stringify({ ...original, env: undefined });
    expect(top).not.toMatch(/onewheelgeek|1f6a766f|0e9cb5d7/);
  });

  it("env.owg is the maintainer's live instance: same Worker name, Durable Object class and every binding", () => {
    const owg = original.env.owg;
    expect(owg.name).toBe("cairn");
    expect(owg.durable_objects).toEqual(original.durable_objects);
    expect(owg.migrations).toEqual(original.migrations);
    expect(owg.d1_databases[0].database_id).toMatch(/^1f6a766f-/);
    expect(owg.kv_namespaces[0].id).toMatch(/^0e9cb5d7/);
    expect(owg.routes).toEqual([{ pattern: "cairn.onewheelgeek.net", custom_domain: true }]);
    expect(owg.triggers).toEqual(original.triggers);
    for (const k of ["r2_buckets", "vectorize", "ai", "ratelimits", "assets"]) expect(owg[k], k).toEqual(original[k]);
    expect(Object.keys(owg.vars).sort()).toEqual([...Object.keys(original.vars), "INBOUND_EMAIL_ADDRESS"].sort());
  });

  it("publicUrlOf reads env.owg for the CI smoke test, and the template's (empty) top level otherwise", () => {
    expect(publicUrlOf(wranglerConfig, "owg")).toBe("https://cairn.onewheelgeek.net");
    expect(publicUrlOf(wranglerConfig, "local")).toBe("http://localhost:8787");
    expect(publicUrlOf(wranglerConfig)).toBe("");
    expect(publicUrlOf(wranglerConfig, "nope")).toBe("");
  });

  it("sets a custom-domain instance at the top level only", () => {
    const text = setInstanceValues(wranglerConfig, {
      d1Id: "11111111-2222-3333-4444-555555555555",
      kvId: "abcdefabcdefabcdefabcdefabcdefab",
      publicUrl: "https://cairn.example.com",
      customDomain: "cairn.example.com",
      email: "",
      openSignup: false,
    });
    const c = parseJsonc(text);
    expect(c.d1_databases[0].database_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(c.kv_namespaces[0].id).toBe("abcdefabcdefabcdefabcdefabcdefab");
    expect(c.vars.PUBLIC_URL).toBe("https://cairn.example.com");
    expect(c.vars.OPEN_SIGNUP).toBe("false");
    expect(c.vars.INBOUND_EMAIL_ADDRESS).toBeUndefined();
    expect(c.routes).toEqual([{ pattern: "cairn.example.com", custom_domain: true }]);
    // env.local and everything else untouched; comments kept.
    expect(c.env).toEqual(original.env);
    expect(c.durable_objects).toEqual(original.durable_objects);
    expect(c.vectorize).toEqual(original.vectorize);
    expect(c.ratelimits).toEqual(original.ratelimits);
    expect(text.split("\n").filter((l) => l.trim().startsWith("//")).length).toBe(wranglerConfig.split("\n").filter((l) => l.trim().startsWith("//")).length);
    // Idempotent.
    expect(
      setInstanceValues(text, { publicUrl: "https://cairn.example.com", customDomain: "cairn.example.com", d1Id: "11111111-2222-3333-4444-555555555555" }),
    ).toBe(text);
    // env.owg keeps its own ids
    expect(c.env.owg.d1_databases[0].database_id).toBe(original.env.owg.d1_databases[0].database_id);
  });

  it("inserts an email address into the template's vars", () => {
    const c = parseJsonc(setInstanceValues(wranglerConfig, { email: "cairn@example.com" }));
    expect(c.vars.INBOUND_EMAIL_ADDRESS).toBe("cairn@example.com");
    expect(c.env).toEqual(original.env);
  });

  it("sets a workers.dev instance: no routes", () => {
    const c = parseJsonc(setInstanceValues(wranglerConfig, { publicUrl: "https://cairn.someone.workers.dev", customDomain: null }));
    expect(c.routes).toEqual([]);
    expect(c.workers_dev).toBe(true);
    expect(c.vars.PUBLIC_URL).toBe("https://cairn.someone.workers.dev");
  });

  it("skips keys quoted in comments", () => {
    const commented = wranglerConfig.replace('"workers_dev"', '// e.g. "routes": [] or "PUBLIC_URL": "x"\n  "workers_dev"');
    const text = setInstanceValues(commented, { publicUrl: "https://cairn.example.com", customDomain: null });
    expect(text).toContain('// e.g. "routes": [] or "PUBLIC_URL": "x"');
    expect(parseJsonc(text).routes).toEqual([]);
  });

  it("escapes values rather than breaking the file", () => {
    const c = parseJsonc(setInstanceValues(wranglerConfig, { email: 'a"b@example.com' }));
    expect(c.vars.INBOUND_EMAIL_ADDRESS).toBe('a"b@example.com');
  });
});

describe("public docs carry no maintainer instance values", () => {
  const ids = [original().env.owg.d1_databases[0].database_id, original().env.owg.kv_namespaces[0].id].filter((id: string) => id && id !== "local");
  for (const [name, text] of [
    ["README.md", readme],
    ["docs/SELF-HOSTING.md", selfHosting],
  ] as const) {
    it(name, () => {
      expect(text).not.toMatch(/onewheelgeek/i);
      for (const id of ids) expect(text).not.toContain(id);
    });
  }
});

function original() {
  return parseJsonc(wranglerConfig);
}
