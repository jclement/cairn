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
    expect(publicUrlOf(wranglerConfig)).toMatch(/^https:\/\//);
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
    expect(c.vars.INBOUND_EMAIL_ADDRESS).toBe("");
    expect(c.routes).toEqual([{ pattern: "cairn.example.com", custom_domain: true }]);
    // env.local and everything else untouched; comments kept.
    expect(c.env).toEqual(original.env);
    expect(c.durable_objects).toEqual(original.durable_objects);
    expect(c.vectorize).toEqual(original.vectorize);
    expect(c.ratelimits).toEqual(original.ratelimits);
    expect(text.split("\n").filter((l) => l.trim().startsWith("//")).length).toBe(wranglerConfig.split("\n").filter((l) => l.trim().startsWith("//")).length);
    // Idempotent.
    expect(setInstanceValues(text, { publicUrl: "https://cairn.example.com", customDomain: "cairn.example.com" })).toBe(text);
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
  const ids = [original().d1_databases[0].database_id, original().kv_namespaces[0].id].filter((id: string) => id && id !== "local");
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
