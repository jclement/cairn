// Landing quote pool and the parody features in the app (Memory Score, Recall Wrapped, Serious mode).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { memoryScore, SERIOUS_COOKIE, streakFrom, TIERS, wrap } from "../src/web/fun";
import { caller, defaultVault, makeUser, ORIGIN } from "./helpers";
import { fetchWorker } from "./oauth";

const serious = (cookie: string) => `${cookie}; ${SERIOUS_COOKIE}=1`;

describe("landing quote pool", () => {
  it("ships a static subset in the page and ~200 well-formed quotes in quotes.json", async () => {
    const page = await (await fetchWorker("/")).text();
    expect(page).toContain("Real<sup>*</sup> users. Real<sup>*</sup> feelings.");
    expect(page.match(/class="ru-item"/g)?.length).toBe(6);
    expect(page).toContain("*Fictional. Obviously.");
    // Static files are served by the asset worker in front of ours, so read them from ASSETS.
    const res = await env.ASSETS!.fetch(new Request("http://localhost:8787/landing/quotes.json"));
    expect(res.status).toBe(200);
    const quotes = (await res.json()) as { quote: string; who: string; role: string }[];
    expect(quotes.length).toBeGreaterThanOrEqual(200);
    for (const q of quotes) {
      expect(typeof q.quote).toBe("string");
      expect(q.quote.length).toBeGreaterThan(10);
      expect(q.quote.length).toBeLessThanOrEqual(180); // the rotator's min-height is sized for this
      expect(q.who.length).toBeGreaterThan(0);
      expect(q.role.length).toBeGreaterThan(0);
    }
    expect(new Set(quotes.map((q) => q.quote)).size).toBe(quotes.length);
  });
});

describe("Memory Score", () => {
  it("is 0 for nothing, saturates at 1000, and climbs through the tiers in order", () => {
    expect(memoryScore({ notes: 0, observations: 0, relations: 0, streak: 0 })).toMatchObject({ score: 0, tier: { name: "Goldfish" } });
    expect(memoryScore({ notes: 1e6, observations: 0, relations: 0, streak: 0 })).toMatchObject({ score: 1000, tier: { name: "Akashic" }, next: null });
    let last = -1;
    for (let notes = 0; notes < 2000; notes += 10) {
      const s = memoryScore({ notes, observations: notes, relations: notes, streak: 0 });
      expect(s.score).toBeGreaterThanOrEqual(last);
      expect(s.score).toBeGreaterThanOrEqual(s.tier.at);
      if (s.next) expect(s.score).toBeLessThan(s.next.at);
      last = s.score;
    }
    expect(TIERS.map((t) => t.at)).toEqual([...TIERS.map((t) => t.at)].sort((a, b) => a - b));
  });

  it("counts a streak back from today, forgiving a quiet today", () => {
    const d = (...v: number[]) => v.map((value) => ({ value }));
    expect(streakFrom(d(1, 0, 1, 1, 1))).toBe(3);
    expect(streakFrom(d(1, 1, 1, 0))).toBe(3);
    expect(streakFrom(d(1, 0, 0))).toBe(0);
    expect(streakFrom([])).toBe(0);
  });

  it("wraps text on word boundaries", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("shows on /app from real stats, and Serious mode removes it and the easter eggs", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Coffee", content: "- [ratio] 1:16\n- relates_to [[Mornings]]" });
    const home = await (await fetchWorker("/app", { headers: { cookie } })).text();
    expect(home).toContain("Memory Score<sup>™</sup>");
    expect(home).toMatch(/1 note × 10, 1 observation × 3,\s+1 link × 5/);
    expect(home).toContain('src="/app/cairn/fun.js"');
    expect(home).toContain('href="/app/wrapped"');
    const plain = await (await fetchWorker("/app", { headers: { cookie: serious(cookie) } })).text();
    expect(plain).not.toContain("Memory Score");
    expect(plain).not.toContain("fun.js");
    expect(plain).not.toContain('href="/app/wrapped"');
    expect(plain).toContain("Your memory");
  });
});

describe("Serious mode switch", () => {
  it("sets and clears a per-browser cookie from Settings", async () => {
    const { cookie } = await makeUser();
    const settings = await (await fetchWorker("/app/settings", { headers: { cookie } })).text();
    expect(settings).toContain('id="serious"');
    expect(settings).toContain("Turn Serious mode on");
    const form = (on: string) => {
      const f = new FormData();
      f.set("serious", on);
      return f;
    };
    const on = await fetchWorker("/app/settings/serious", { method: "POST", headers: { cookie, origin: ORIGIN }, body: form("1") });
    expect(on.status).toBe(303);
    expect(on.headers.get("set-cookie")).toMatch(new RegExp(`^${SERIOUS_COOKIE}=1;.*HttpOnly`));
    const s2 = await (await fetchWorker("/app/settings", { headers: { cookie: serious(cookie) } })).text();
    expect(s2).toContain("Turn Serious mode off");
    const off = await fetchWorker("/app/settings/serious", { method: "POST", headers: { cookie: serious(cookie), origin: ORIGIN }, body: form("0") });
    expect(off.headers.get("set-cookie")).toMatch(new RegExp(`^${SERIOUS_COOKIE}=;.*Max-Age=0`));
    expect((await fetchWorker("/app/settings/serious", { method: "POST", headers: { cookie }, body: form("1") })).status).toBe(403);
  });
});

describe("Recall Wrapped", () => {
  it("renders six accessible SVG cards with real counts, and each downloads as standalone SVG", async () => {
    const { user, cookie } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user, "claude-code"), { title: "One", content: "first", tags: ["espresso"] });
    await v.stub.writeNote(v.ref, caller(user, "claude-code"), { title: "Two", content: "second", tags: ["espresso"] });
    await v.stub.writeNote(v.ref, caller(user, "web"), { title: "Three", content: "mine" });
    const res = await fetchWorker("/app/wrapped", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("style-src 'self';");
    const body = await res.text();
    expect(body.match(/<svg class="wrapped-card"/g)?.length).toBe(6);
    expect(body.match(/role="img"/g)?.length).toBeGreaterThanOrEqual(6);
    expect(body).toContain("You remembered 1 thing.");
    expect(body).toContain("Your agents remembered 2.");
    expect(body).toContain("claude-code");
    expect(body).toContain("#espresso");
    expect(body).not.toMatch(/\sstyle="/);
    const all = await fetchWorker("/app/wrapped?period=all", { headers: { cookie } });
    expect(await all.text()).toContain("Your whole memory.");
    const card = await fetchWorker("/app/wrapped/card.svg?period=week&n=2", { headers: { cookie } });
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toContain("image/svg+xml");
    expect(card.headers.get("content-disposition")).toContain("attachment");
    const svg = await card.text();
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("You remembered 1 thing.");
    expect((await fetchWorker("/app/wrapped/card.svg?n=9", { headers: { cookie } })).status).toBe(404);
    expect((await fetchWorker("/app/wrapped", { headers: { cookie: serious(cookie) } })).status).toBe(200);
    expect(await (await fetchWorker("/app/wrapped", { headers: { cookie: serious(cookie) } })).text()).toContain("Serious mode is on");
    expect((await fetchWorker("/app/wrapped")).status).toBe(302);
  });
});
