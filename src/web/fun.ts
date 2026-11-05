// Parody features in the signed-in app: Memory Score™ on /app, Recall Wrapped at /app/wrapped, and
// the Serious mode switch that turns all of it (and the easter eggs in /app/cairn/fun.js) off.
// Every number shown comes from gatherStats; only the copy is over the top.

import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { User } from "../directory";
import { type H, html, icon } from "./layout";
import { gatherStats, type Range } from "./round2";
import type { AppEnv } from "./types";
import { emptyState, pageHeader } from "./ui";

type Page = (c: never, title: string, body: H, extra?: { vault?: string; q?: string; auth?: boolean | string }) => H;

export const SERIOUS_COOKIE = "cairn_serious";

/** Serious mode is a per-browser preference kept in a cookie (no account data involved). */
export function isSerious(c: Context<AppEnv>): boolean {
  return getCookie(c, SERIOUS_COOKIE) === "1";
}

// ---- Memory Score™ ----

export interface ScoreInput {
  notes: number;
  observations: number;
  relations: number;
  /** Consecutive days with at least one write, ending today (or yesterday, if today has none yet). */
  streak: number;
}

export const TIERS: { at: number; name: string; blurb: string }[] = [
  { at: 0, name: "Goldfish", blurb: "Three-second memory. Iconic, honestly." },
  { at: 100, name: "Squirrel", blurb: "Buries things. Finds about half of them." },
  { at: 250, name: "Crow", blurb: "Remembers faces. Holds grudges. Respect." },
  { at: 450, name: "Elephant", blurb: "Never forgets. Mildly smug about it." },
  { at: 650, name: "Octopus", blurb: "Nine brains, all of them taking notes." },
  { at: 850, name: "Akashic", blurb: "The cosmic library knows you by name." },
];

/** 0–1000, saturating: each note is worth 10 points, each observation 3, each link 5, each streak day 40. */
export function memoryScore(i: ScoreInput) {
  const points = i.notes * 10 + i.observations * 3 + i.relations * 5 + i.streak * 40;
  const score = Math.min(1000, Math.round(1000 * (1 - Math.exp(-points / 3000))));
  let t = 0;
  while (t + 1 < TIERS.length && score >= TIERS[t + 1].at) t++;
  return { score, points, tier: TIERS[t], next: TIERS[t + 1] ?? null };
}

/** Days with writes, counted back from the last day of a daily series. A quiet today doesn't break it. */
export function streakFrom(daily: { value: number }[]): number {
  let i = daily.length - 1;
  if (i >= 0 && daily[i].value === 0) i--;
  let n = 0;
  for (; i >= 0 && daily[i].value > 0; i--) n++;
  return n;
}

async function scoreFor(env: AppEnv["Bindings"], user: User) {
  const s = await gatherStats(env, user, "mine", "30d");
  const input: ScoreInput = {
    notes: s.memory?.notes ?? 0,
    observations: s.memory?.observations ?? 0,
    relations: s.memory?.relations.total ?? 0,
    streak: streakFrom(s.saved),
  };
  return { input, ...memoryScore(input) };
}

function gauge(score: number, tier: string) {
  // Half circle, pathLength 1000 so the dash length is the score.
  const arc = "M 20 110 A 90 90 0 0 1 200 110";
  const a = Math.PI * (1 - score / 1000);
  const nx = (110 + 72 * Math.cos(a)).toFixed(1);
  const ny = (110 - 72 * Math.sin(a)).toFixed(1);
  return html`<svg class="ms-gauge" viewBox="0 0 220 130" role="img" aria-labelledby="ms-t ms-d">
    <title id="ms-t">Memory Score</title>
    <desc id="ms-d">${score} out of 1000: ${tier}.</desc>
    <path class="ms-track" d="${arc}" pathLength="1000"></path>
    <path class="ms-value" d="${arc}" pathLength="1000" stroke-dasharray="${score} 1000"></path>
    <line class="ms-needle" x1="110" y1="110" x2="${nx}" y2="${ny}"></line>
    <circle class="ms-hub" cx="110" cy="110" r="6"></circle>
  </svg>`;
}

/** The Memory Score™ card for /app (the caller skips it in Serious mode). */
export async function memoryScoreSection(env: AppEnv["Bindings"], user: User): Promise<H> {
  const s = await scoreFor(env, user);
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  const pct = Math.round(s.score / 10);
  return html`<section class="card relative overflow-hidden" aria-labelledby="ms-h">
    <div class="pointer-events-none absolute -top-16 -right-16 size-44 rounded-full bg-brand-pink/15 blur-2xl" aria-hidden="true"></div>
    <div class="relative flex items-center gap-4">
      <div class="w-28 shrink-0 text-center">${gauge(s.score, s.tier.name)}<p class="-mt-1 mb-0 text-xs text-muted tabular-nums"><strong class="text-lg font-semibold text-fg">${s.score}</strong> / 1000</p></div>
      <div class="min-w-0">
        <p class="m-0 text-xs font-semibold tracking-wider text-muted uppercase">Memory Score<sup>™</sup></p>
        <h2 id="ms-h" class="mt-0.5 mb-1 text-lg"><span class="sr-only">Memory Score<sup>™</sup>: </span><span class="brand-text">${s.tier.name}</span></h2>
        <p class="m-0 text-sm text-fg-2">${s.tier.blurb}</p>
        ${s.next ? html`<p class="mt-1 mb-0 text-xs text-muted">${s.next.at - s.score} points to ${s.next.name}.</p>` : html`<p class="mt-1 mb-0 text-xs text-muted">There is no higher tier. We checked.</p>`}
      </div>
    </div>
    <svg class="relative mt-4 block h-1.5 w-full overflow-hidden rounded-full" viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="2" class="fill-sunken"></rect><rect width="${pct}" height="2" fill="url(#g-brand)"></rect></svg>
    <details class="relative mt-3 text-sm"><summary class="text-xs text-muted">How it's computed</summary>
      <p class="mb-0 text-xs text-muted">From your real numbers: ${plural(s.input.notes, "note")} × 10, ${plural(s.input.observations, "observation")} × 3,
      ${plural(s.input.relations, "link")} × 5, and a ${plural(s.input.streak, "day")} writing streak × 40 = ${s.points.toLocaleString("en-US")} points,
      squashed onto 0–1000. It means nothing. It is also extremely important.</p>
    </details>
    <p class="relative mt-3 mb-0 flex gap-4 text-xs font-medium"><a href="/app/wrapped">See your Recall Wrapped</a><a href="/app/settings#serious">Serious mode</a></p>
  </section>`;
}

// ---- Recall Wrapped ----

type Period = "week" | "all";

/** Greedy word wrap for SVG text. */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${w}`.length > max) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

interface Card {
  eyebrow: string;
  big: string;
  lines: string[];
  foot: string;
}

export async function wrappedCards(env: AppEnv["Bindings"], user: User, period: Period): Promise<Card[]> {
  const range: Range = period === "week" ? "7d" : "all";
  const s = await gatherStats(env, user, "mine", range);
  const sc = await scoreFor(env, user);
  const n = (x: number) => x.toLocaleString("en-US");
  const when = period === "week" ? "This week" : "Since the beginning of time (this server)";
  const agents = s.clients.filter(([name]) => name !== "web");
  const searches = s.searches;
  const topTag = s.memory?.topTags[0];
  const total = s.byYou + s.byAi;
  return [
    {
      eyebrow: "CAIRN™ RECALL WRAPPED",
      big: period === "week" ? "Your week in memory." : "Your whole memory.",
      lines: [`${when}, ${user.username} happened.`, "Dim the lights. Silence your phone.", "This is your story."],
      foot: "A Cairn™ original",
    },
    {
      eyebrow: "THE REMEMBERING",
      big: `You remembered ${n(s.byYou)} ${s.byYou === 1 ? "thing" : "things"}.`,
      lines: [
        `Your agents remembered ${n(s.byAi)}.`,
        total === 0
          ? "Together you remembered nothing. Bold. Minimalist."
          : s.byAi > s.byYou
            ? "Together you are unstoppable. (Mostly them.)"
            : "Together you are unstoppable.",
      ],
      foot: `${n(s.created)} created · ${n(s.updated)} updated · ${n(s.deleted)} deleted`,
    },
    {
      eyebrow: "YOUR MOST DEVOTED AGENT",
      big: agents[0] ? agents[0][0] : "Nobody (yet).",
      lines: agents[0]
        ? [`It wrote to your memory ${n(agents[0][1])} ${agents[0][1] === 1 ? "time" : "times"}.`, "It thinks about you constantly.", "Possibly too much."]
        : ["No agent wrote anything. They're out there.", "Waiting. Connect one in Settings."],
      foot:
        agents.length > 1
          ? `Also starring: ${agents
              .slice(1, 4)
              .map(([a]) => a)
              .join(", ")}`
          : "A one-agent show",
    },
    {
      eyebrow: "YOUR PERSONALITY, BY TAG",
      big: topTag ? `#${topTag.tag}` : "#untagged",
      lines: topTag
        ? [`${n(topTag.n)} ${topTag.n === 1 ? "note" : "notes"}. That's not a tag.`, "That's a lifestyle."]
        : ["Zero tags. Unfiled. Untamed.", "A free spirit of the knowledge graph."],
      foot: "Top tag across all your notes",
    },
    {
      eyebrow: "THE SEARCH FOR MEANING",
      big: `${n(searches)} ${searches === 1 ? "search" : "searches"}.`,
      lines: [
        `${n(s.reads)} ${s.reads === 1 ? "read" : "reads"}. A ${n(sc.input.streak)}-day writing streak.`,
        searches > 0 ? "You looked for things. Sometimes you found them." : "You never once looked back. Iconic.",
      ],
      foot: "Searches and reads by you and your agents",
    },
    {
      eyebrow: "MEMORY SCORE™",
      big: `${sc.score} / 1000`,
      lines: [`You are ${/^[AEIOU]/.test(sc.tier.name) ? "an" : "a"} ${sc.tier.name}.`, sc.tier.blurb],
      foot: "Rated M for Memory",
    },
  ];
}

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

/** One card as a self-contained SVG (fixed dark palette, presentation attributes only: CSP-safe inline and standalone). */
export function cardSvg(card: Card, i: number, standalone = false) {
  const id = `wc${i}`;
  // ~0.6 em per bold glyph: 14 characters at 50px fit the 504px text column.
  const big = wrap(card.big, 14);
  const bigSize = big.length > 2 ? 42 : 50;
  let y = 250;
  return html`<svg ${standalone ? html`xmlns="http://www.w3.org/2000/svg" ` : ""}class="wrapped-card" viewBox="0 0 600 750" role="img" aria-labelledby="${id}-t ${id}-d">
  <title id="${id}-t">${card.eyebrow}: ${card.big}</title>
  <desc id="${id}-d">${card.lines.join(" ")} ${card.foot}</desc>
  <defs>
    <radialGradient id="${id}-a" cx="85%" cy="10%" r="70%"><stop offset="0" stop-color="#ff4f9a" stop-opacity=".55"/><stop offset="1" stop-color="#ff4f9a" stop-opacity="0"/></radialGradient>
    <radialGradient id="${id}-b" cx="0%" cy="100%" r="80%"><stop offset="0" stop-color="#7b4dff" stop-opacity=".6"/><stop offset="1" stop-color="#7b4dff" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id}-g" x1="0" x2="1"><stop offset="0" stop-color="#ffa24a"/><stop offset=".5" stop-color="#ff5fa2"/><stop offset="1" stop-color="#b08cff"/></linearGradient>
  </defs>
  <rect width="600" height="750" rx="28" fill="#0b0912"/>
  <rect width="600" height="750" rx="28" fill="url(#${id}-a)"/>
  <rect width="600" height="750" rx="28" fill="url(#${id}-b)"/>
  <text x="48" y="92" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="18" font-weight="700" letter-spacing="4" fill="#ff9fcb">${card.eyebrow}</text>
  <text x="48" y="128" font-family="${FONT}" font-size="16" fill="#bdb5d6">${String(i + 1).padStart(2, "0")} / 06</text>
  ${big.map((l, k) => html`<text x="46" y="${y + k * (bigSize + 6)}" font-family="${FONT}" font-size="${bigSize}" font-weight="800" letter-spacing="-1.5" fill="url(#${id}-g)">${l}</text>`)}
  ${(() => {
    y += big.length * (bigSize + 6) + 40;
    return card.lines
      .flatMap((l) => wrap(l, 34))
      .map((l, k) => html`<text x="48" y="${y + k * 38}" font-family="${FONT}" font-size="26" fill="#efeaff">${l}</text>`);
  })()}
  <line x1="48" y1="660" x2="552" y2="660" stroke="#ffffff" stroke-opacity=".18"/>
  <text x="48" y="698" font-family="${FONT}" font-size="17" fill="#bdb5d6">${wrap(card.foot, 52)[0]}</text>
  <g transform="translate(520 690)" aria-hidden="true"><ellipse cx="0" cy="8" rx="22" ry="7" fill="#ff8a3d"/><ellipse cx="-1" cy="-4" rx="15" ry="5.5" fill="#ff3d8b"/><ellipse cx="1" cy="-14" rx="9" ry="4" fill="#8b5cf6"/></g>
</svg>`;
}

export function registerFun(app: Hono<AppEnv>, page: Page, loginRedirect: (url: string) => string) {
  const periodOf = (q: string | undefined): Period => (q === "all" ? "all" : "week");

  app.get("/app/wrapped", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    if (isSerious(c)) {
      return c.html(
        page(
          c as never,
          "Recall Wrapped",
          html`${pageHeader("Recall Wrapped")}<div class="card">${emptyState(
            "sparkle",
            "Serious mode is on, so this is off.",
            "Recall Wrapped is part of the fun bits Serious mode hides.",
            html`<a class="btn btn-secondary" href="/app/settings#serious">Change it in Settings</a>`,
          )}</div>`,
        ),
      );
    }
    const period = periodOf(c.req.query("period"));
    const cards = await wrappedCards(c.env, user, period);
    const tab = (p: Period, label: string) => html`<a href="/app/wrapped?period=${p}" ${p === period ? html`aria-current="page"` : ""}>${label}</a>`;
    return c.html(
      page(
        c as never,
        "Recall Wrapped",
        html`${pageHeader(
          html`Recall Wrapped<sup>™</sup>`,
          "Real numbers from your stats, dramatised. Each card downloads as an SVG you can share.",
          html`<nav class="seg" aria-label="Period">${tab("week", "This week")}${tab("all", "All time")}</nav>`,
        )}
        <ol class="wrapped">
          ${cards.map(
            (card, i) => html`<li class="wrapped-item">${cardSvg(card, i)}
              <p class="mt-3 mb-0"><a class="btn btn-secondary btn-sm" href="/app/wrapped/card.svg?period=${period}&amp;n=${i + 1}" download="cairn-wrapped-${period}-${i + 1}.svg">${icon("download", "size-4")}Download card ${i + 1}</a></p></li>`,
          )}
        </ol>`,
      ),
    );
  });

  app.get("/app/wrapped/card.svg", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    if (isSerious(c)) return c.text("Serious mode is on.", 404);
    const period = periodOf(c.req.query("period"));
    const n = Number(c.req.query("n") ?? "1");
    const cards = await wrappedCards(c.env, user, period);
    const card = cards[n - 1];
    if (!Number.isInteger(n) || !card) return c.text("No such card.", 404);
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n${await cardSvg(card, n - 1, true)}`;
    return c.body(body, 200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "content-disposition": `attachment; filename="cairn-wrapped-${period}-${n}.svg"`,
      "cache-control": "private, no-store",
    });
  });

  // ---- Serious mode: one switch for every joke in the app ----
  app.post("/app/settings/serious", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const on = String((await c.req.formData()).get("serious") ?? "") === "1";
    const cookie = on
      ? `${SERIOUS_COOKIE}=1; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`
      : `${SERIOUS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
    return new Response(null, { status: 303, headers: { Location: "/app/settings#serious", "Set-Cookie": cookie } });
  });
}

/** The Serious mode section of the settings page. */
export function seriousModeSettings(c: Context<AppEnv>): H {
  const on = isSerious(c);
  return html`<div id="serious" class="flex flex-wrap items-center justify-between gap-3 py-4">
    <div class="min-w-0 flex-1"><p class="m-0 text-sm font-semibold">Serious mode ${on ? html`<span class="badge ml-1">on</span>` : ""}</p>
    <p class="m-0 text-sm text-muted">${on ? "On: no Memory Score, no Recall Wrapped, no easter eggs, no jokes in loading messages." : "Off: Memory Score™, Recall Wrapped and a few easter eggs are on."} This setting is kept in this browser only.</p></div>
    <form method="post" action="/app/settings/serious"><input type="hidden" name="serious" value="${on ? "0" : "1"}"><button class="secondary" type="submit">${on ? "Turn Serious mode off" : "Turn Serious mode on"}</button></form>
  </div>`;
}
