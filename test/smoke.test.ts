import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://localhost:8787";

describe("worker", () => {
  it("serves /health", async () => {
    const res = await exports.default.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "0.1.0" });
  });
});
