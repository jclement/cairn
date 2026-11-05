// Connected apps shows a grant the moment it is approved (KV list() lags ~30 s live; see
// scripts/oauth-live.mjs), and the code format the D1 record relies on is pinned here.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { grantIdFromRedirect } from "../src/web/app";
import { makeUser, ORIGIN } from "./helpers";
import { fetchWorker, getAccessToken, mcp } from "./oauth";

describe("recently approved grants", () => {
  it("are recorded at approval, listed with a Revoke button, and revoking clears them", async () => {
    const { user, cookie } = await makeUser("grants");
    const { accessToken } = await getAccessToken(cookie);
    const rows = await env.DB.prepare("SELECT grant_id, client_id, scope FROM recent_grants WHERE user_id = ?")
      .bind(user.id)
      .all<{ grant_id: string; client_id: string; scope: string }>();
    // A missing row here means the provider's code format changed: grantIdFromRedirect needs updating.
    expect(rows.results.length).toBe(1);
    const grant = rows.results[0].grant_id;
    expect(JSON.parse(rows.results[0].scope)).toContain("memory:read");
    const apps = await (await fetchWorker("/app/settings/apps", { headers: { cookie } })).text();
    expect(apps).toContain(`name="grant" value="${grant}"`);
    expect(apps.split(`value="${grant}"`).length - 1).toBe(1); // listed once, not twice (KV and D1 merged)
    const revoke = await fetchWorker("/app/settings/apps/revoke", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant }),
    });
    expect(revoke.status).toBe(303);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM recent_grants WHERE grant_id = ?").bind(grant).first<{ n: number }>())?.n).toBe(0);
    await expect(mcp(accessToken, "tools/list")).rejects.toThrow(/401/);
  });

  it("parses only codes of the provider's shape, for this user", () => {
    expect(grantIdFromRedirect("http://127.0.0.1:9/cb?code=u1:AbCdEfGh12345678:secret&state=x", "u1")).toBe("AbCdEfGh12345678");
    expect(grantIdFromRedirect("http://127.0.0.1:9/cb?code=u2:AbCdEfGh12345678:secret", "u1")).toBeNull();
    expect(grantIdFromRedirect("http://127.0.0.1:9/cb?code=opaque", "u1")).toBeNull();
    expect(grantIdFromRedirect("not a url", "u1")).toBeNull();
  });
});
