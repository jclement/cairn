// Real ceremonies: SimpleWebAuthn verification on workerd, against a software authenticator,
// through the deployed Worker entry (no mocks).
import { describe, expect, it } from "vitest";
import { BASE } from "./helpers";
import { fetchWorker } from "./oauth";
import { SoftAuthenticator } from "./softauthn";

const post = (path: string, body: unknown, cookie = "") =>
  fetchWorker(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe("real passkey ceremonies (software authenticator)", () => {
  it("signs up and signs back in with SimpleWebAuthn verifying on workerd", async () => {
    const auth = new SoftAuthenticator("localhost", BASE);
    const o = await post("/auth/signup/options", { username: "real-passkey" });
    const { challengeId, options } = (await o.json()) as { challengeId: string; options: { challenge: string; user: { id: string } } };
    const v = await post("/auth/signup/verify", { challengeId, response: await auth.create(options) });
    expect(v.status, await v.clone().text()).toBe(200);

    const lo = await post("/auth/login/options", {});
    const l = (await lo.json()) as { challengeId: string; options: { challenge: string } };
    const lv = await post("/auth/login/verify", { challengeId: l.challengeId, response: await auth.get(l.options) });
    expect(lv.status, await lv.clone().text()).toBe(200);
    const cookie = /(__Host-cairn_session=[^;]+)/.exec(lv.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect((await fetchWorker("/app", { headers: { cookie } })).status).toBe(200);

    // a response for the wrong origin is refused
    const evil = new SoftAuthenticator("localhost", "https://evil.example");
    const o2 = await post("/auth/signup/options", { username: "phished" });
    const p2 = (await o2.json()) as { challengeId: string; options: { challenge: string; user: { id: string } } };
    expect((await post("/auth/signup/verify", { challengeId: p2.challengeId, response: await evil.create(p2.options) })).status).toBe(400);
  });
});
