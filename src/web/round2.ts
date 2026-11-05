// Invites (every user), admin (accounts: counts only), and stats pages.

import type { Hono } from "hono";
import {
  audit,
  createInvite,
  getUser,
  inviteQuota,
  inviteStatus,
  listInvites,
  listOwnedVaults,
  listUsersForAdmin,
  revokeAllGrants,
  revokeInvite,
  setUserDisabled,
  type User,
  vaultRef,
  vaultStub,
} from "../directory";
import { LIMITS, openSignup, publicOrigin } from "../env";
import { DEFAULT_JEV_MODEL, jevModel } from "../jev/client";
import { collectHealth, type Health } from "../stats/health";
import { estimateCost, PRICING_SOURCES } from "../stats/pricing";
import { barChart, type Point, rankList } from "./charts";
import { importEnabled } from "./importer";
import { type H, html, icon, when } from "./layout";
import { sitePanel } from "./site";
import type { AppEnv } from "./types";
import { pageHeader, panel, settingsLayout } from "./ui";

type Page = (c: never, title: string, body: H, extra?: { vault?: string; q?: string; auth?: boolean | string }) => H;

const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
const fmtUsd = (n: number | null) => (n === null ? "—" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(2)}`);

export type Range = "7d" | "30d" | "90d" | "all";
export type Scope = "mine" | "everyone";

const dayStr = (d: Date) => d.toISOString().slice(0, 10);

/** Bucket start days for a range: daily up to 30 days, weekly up to ~26 weeks, else monthly. */
export function buckets(range: Range, firstDay: string, today = new Date()): { start: string; label: string }[] {
  const end = new Date(`${dayStr(today)}T00:00:00Z`);
  const days =
    range === "7d"
      ? 7
      : range === "30d"
        ? 30
        : range === "90d"
          ? 90
          : Math.max(1, Math.round((end.getTime() - Date.parse(`${firstDay}T00:00:00Z`)) / 86400e3) + 1);
  const start = new Date(end.getTime() - (days - 1) * 86400e3);
  const step = days <= 31 ? 1 : days <= 182 ? 7 : 30;
  const out: { start: string; label: string }[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += step * 86400e3) out.push({ start: dayStr(new Date(t)), label: dayStr(new Date(t)) });
  return out;
}

function series(daily: { day: string; metric: string; v: number }[], bks: { start: string; label: string }[], match: (m: string) => boolean): Point[] {
  return bks.map((b, i) => {
    const next = bks[i + 1]?.start ?? "9999-12-31";
    const v = daily.filter((r) => r.day >= b.start && r.day < next && match(r.metric)).reduce((s, r) => s + r.v, 0);
    return { label: b.label, value: v };
  });
}

export async function gatherStats(env: AppEnv["Bindings"], user: User, scope: Scope, range: Range) {
  const since = (await env.DB.prepare("SELECT value FROM instance_meta WHERE key = 'stats_since'").first<{ value: string }>())?.value ?? dayStr(new Date());
  const bks = buckets(range, since);
  const from = bks[0]?.start ?? since;
  const userFilter = scope === "mine" ? "AND user_id = ?" : "";
  const bind = (sql: string, ...extra: unknown[]) => {
    const st = env.DB.prepare(sql);
    return scope === "mine" ? st.bind(from, user.id, ...extra) : st.bind(from, ...extra);
  };
  const daily = (
    await bind(`SELECT day, metric, SUM(value) AS v FROM stats_daily WHERE day >= ? ${userFilter} GROUP BY day, metric`).all<{
      day: string;
      metric: string;
      v: number;
    }>()
  ).results;
  const ai = (
    await bind(
      `SELECT model, purpose, SUM(calls) AS calls, SUM(failed) AS failed, SUM(latency_ms) AS latency_ms, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(estimated_calls) AS estimated_calls, SUM(unknown_calls) AS unknown_calls
       FROM ai_daily WHERE day >= ? ${userFilter} GROUP BY model, purpose ORDER BY model, purpose`,
    ).all<{
      model: string;
      purpose: string;
      calls: number;
      failed: number;
      latency_ms: number;
      input_tokens: number;
      output_tokens: number;
      estimated_calls: number;
      unknown_calls: number;
    }>()
  ).results;
  const sum = (match: (m: string) => boolean) => daily.filter((r) => match(r.metric)).reduce((s, r) => s + r.v, 0);
  const byPrefix = (prefix: string) => {
    const m = new Map<string, number>();
    for (const r of daily) if (r.metric.startsWith(prefix)) m.set(r.metric.slice(prefix.length), (m.get(r.metric.slice(prefix.length)) ?? 0) + r.v);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  let memory: Awaited<ReturnType<ReturnType<typeof vaultStub>["statsSnapshot"]>> | null = null;
  let storage = { used: 0, limit: LIMITS.userBytes };
  let apps: number | null = null;
  let everyone: { users: number; notes: number; bytes: number; invitesSent: number; invitesAccepted: number } | null = null;
  if (scope === "mine") {
    const vaults = await listOwnedVaults(env, user.id);
    const snaps = await Promise.all(vaults.map((v) => vaultStub(env, v).statsSnapshot(vaultRef(v))));
    memory = snaps.reduce(
      (acc, s) => {
        acc.notes += s.notes;
        acc.liveBytes += s.liveBytes;
        acc.revisionBytes += s.revisionBytes;
        acc.revisionsRetained += s.revisionsRetained;
        acc.observations += s.observations;
        acc.relations.total += s.relations.total;
        acc.relations.resolved += s.relations.resolved;
        acc.relations.unresolved += s.relations.unresolved;
        acc.chunks.indexed += s.chunks.indexed;
        acc.chunks.pending += s.chunks.pending;
        const merge = <K extends string>(into: ({ n: number } & Record<K, string>)[], from: ({ n: number } & Record<K, string>)[], key: K) => {
          for (const f of from) {
            const hit = into.find((x) => x[key] === f[key]);
            if (hit) hit.n += f.n;
            else into.push({ ...f });
          }
          into.sort((a, b) => b.n - a.n);
        };
        merge(acc.byType, s.byType, "type");
        merge(acc.topTags, s.topTags, "tag");
        merge(acc.topCategories, s.topCategories, "category");
        return acc;
      },
      {
        notes: 0,
        liveBytes: 0,
        revisionBytes: 0,
        revisionsRetained: 0,
        observations: 0,
        relations: { total: 0, resolved: 0, unresolved: 0 },
        byType: [] as { type: string; n: number }[],
        topTags: [] as { tag: string; n: number }[],
        topCategories: [] as { category: string; n: number }[],
        chunks: { indexed: 0, pending: 0 },
      },
    );
    storage = { used: (await getUser(env, user.id))?.bytes_used ?? 0, limit: LIMITS.userBytes };
    try {
      apps = (await env.OAUTH_PROVIDER.listUserGrants(user.id)).items.length;
    } catch {
      apps = null;
    }
  } else {
    const u = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes_used),0) AS b FROM users").first<{ n: number; b: number }>();
    const n = await env.DB.prepare("SELECT COALESCE(SUM(note_count),0) AS n FROM vaults").first<{ n: number }>();
    const inv = await env.DB.prepare("SELECT SUM(created_at >= ?) AS sent, SUM(used_at >= ?) AS accepted FROM invites")
      .bind(from, from)
      .first<{ sent: number | null; accepted: number | null }>();
    everyone = { users: u?.n ?? 0, bytes: u?.b ?? 0, notes: n?.n ?? 0, invitesSent: inv?.sent ?? 0, invitesAccepted: inv?.accepted ?? 0 };
  }

  return {
    scope,
    range,
    since,
    from,
    saved: series(daily, bks, (m) => m === "note_create" || m === "note_update"),
    created: sum((m) => m === "note_create"),
    updated: sum((m) => m === "note_update"),
    deleted: sum((m) => m === "note_delete"),
    searches: sum((m) => m === "op_search"),
    reads: sum((m) => m === "op_read"),
    byYou: sum((m) => m === "write_you"),
    byAi: sum((m) => m === "write_ai"),
    clients: byPrefix("client:"),
    tools: byPrefix("mcp:"),
    typesCreated: byPrefix("type:"),
    activity: series(daily, bks, (m) => m.startsWith("op_") || m.startsWith("note_")),
    ai,
    memory,
    storage,
    apps,
    everyone,
  };
}

export function registerRound2(app: Hono<AppEnv>, page: Page, loginRedirect: (url: string) => string) {
  // ---- invites (every user) ----
  app.get("/app/settings/invites", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const invites = await listInvites(c.env, user.id);
    const base = publicOrigin(c.env);
    const created = c.req.query("created");
    const quota = user.is_admin ? "unlimited (admin)" : `${inviteQuota(c.env)} unused at a time`;
    return c.html(
      page(
        c as never,
        "Invites",
        settingsLayout(
          "invites",
          { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) },
          html`${created ? html`<p class="callout tip">Invite created. Copy the link below and send it.</p>` : ""}
        ${panel(
          "Invites",
          html`Invite someone by sending them a link. Each link works once${openSignup(c.env) ? "; sign-up here is also open to anyone, but an invite records who brought them in" : "; sign-up here needs an invite"}. You can have ${quota}.`,
          html`<form method="post" action="/app/settings/invites" class="m-0 grid gap-4 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
          <div><label for="note">Who is it for? (only you see this)</label><input id="note" name="note" type="text" maxlength="80" placeholder="for Mum"></div>
          <div><label for="days">Expires after (days)</label><input id="days" name="days" type="text" inputmode="numeric" value="14"></div>
          <button class="btn btn-primary" type="submit">${icon("plus", "size-4")}Create invite link</button>
        </form>`,
        )}
        ${
          invites.length
            ? html`<table><tr><th>For</th><th>Link</th><th>Status</th><th>Created</th><th></th></tr>${invites.map((i) => {
                const st = inviteStatus(i);
                return html`<tr><td>${i.note ?? ""}</td>
                <td>${st === "open" && i.code ? html`<code>${base}/signup?invite=${i.code}</code>` : html`<span class="muted">—</span>`}</td>
                <td>${st === "joined" ? html`joined as <strong>${i.joined_username ?? "?"}</strong> ${when(i.used_at)}` : st === "open" ? html`unused, expires ${when(i.expires_at)}` : st}</td>
                <td>${when(i.created_at)}</td>
                <td>${st === "open" ? html`<form class="inline" method="post" action="/app/settings/invites/revoke"><input type="hidden" name="id" value="${i.id}"><button class="btn btn-secondary btn-sm text-danger" type="submit">Revoke</button></form>` : ""}</td></tr>`;
              })}</table>`
            : html`<p class="muted text-sm">No invites yet.</p>`
        }`,
        ),
      ),
    );
  });

  app.post("/app/settings/invites", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    if (c.env.RL_INVITE && !(await c.env.RL_INVITE.limit({ key: `invite:${user.id}` })).success) {
      return c.html(
        page(c as never, "Invites", html`<p class="error">Too many invite changes; wait a minute.</p><p><a href="/app/settings/invites">Back</a></p>`),
        429,
      );
    }
    const f = await c.req.formData();
    const days = Number(String(f.get("days") ?? "14").trim() || 14);
    const r = await createInvite(c.env, user, { note: String(f.get("note") ?? ""), days: Number.isFinite(days) ? days : 14 });
    if (!r.ok) return c.html(page(c as never, "Invites", html`<p class="error">${r.message}</p><p><a href="/app/settings/invites">Back</a></p>`), 400);
    return c.redirect("/app/settings/invites?created=1", 303);
  });

  app.post("/app/settings/invites/revoke", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    if (c.env.RL_INVITE && !(await c.env.RL_INVITE.limit({ key: `invite:${user.id}` })).success) {
      return c.html(
        page(c as never, "Invites", html`<p class="error">Too many invite changes; wait a minute.</p><p><a href="/app/settings/invites">Back</a></p>`),
        429,
      );
    }
    await revokeInvite(c.env, user.id, String((await c.req.formData()).get("id") ?? ""));
    return c.redirect("/app/settings/invites", 303);
  });

  // ---- admin: accounts (counts only, never note content) ----
  app.get("/app/admin", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    if (!user.is_admin) return c.html(page(c as never, "Admin", html`<h1>Admin</h1><p>Only admins can see this page.</p>`), 403);
    const users = await listUsersForAdmin(c.env);
    const instance = await sitePanel(c as never);
    return c.html(
      page(
        c as never,
        "Admin",
        settingsLayout(
          "admin",
          { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) },
          html`${instance}<h2 class="mt-0 mb-1 text-xl">Accounts</h2>
        <p class="mt-0 muted small"><a href="/app/admin/health">Production health</a> · Counts only: admins cannot read anyone's notes. Disabling an account signs it out everywhere, revokes its connected apps and tokens, and refuses sign-in.</p>
        <table><tr><th>User</th><th>Invited by</th><th>Joined</th><th>Last active</th><th>Notes</th><th>Storage</th><th></th></tr>
        ${users.map(
          (
            u,
          ) => html`<tr><td>${u.username}${u.is_admin ? html` <span class="badge">admin</span>` : ""}${u.disabled_at ? html` <span class="badge red">disabled</span>` : ""}</td>
          <td>${u.invited_by_username ?? html`<span class="muted">—</span>`}</td><td>${when(u.created_at)}</td><td>${when(u.last_active_at) || html`<span class="muted">—</span>`}</td>
          <td>${u.notes}</td><td>${fmtBytes(u.bytes_used)}</td>
          <td>${
            u.id === user.id
              ? ""
              : html`<form class="inline" method="post" action="/app/admin/users/${u.disabled_at ? "enable" : "disable"}"><input type="hidden" name="id" value="${u.id}"><button class="btn btn-sm ${u.disabled_at ? "btn-secondary" : "btn-danger"}" type="submit">${u.disabled_at ? "Enable" : "Disable"}</button></form>`
          }</td></tr>`,
        )}</table>`,
        ),
      ),
    );
  });

  // ---- admin: production health (counts and metadata only; same checks as `mise run prod:status`) ----
  app.get("/app/admin/health", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    if (!user.is_admin) return c.html(page(c as never, "Health", html`<h1>Health</h1><p>Only admins can see this page.</p>`), 403);
    const db = c.env.DB;
    const h = await collectHealth(
      async (sql, params = []) =>
        (
          await db
            .prepare(sql)
            .bind(...params)
            .all<Record<string, unknown>>()
        ).results,
    );
    let vectors: string;
    try {
      const d = c.env.VECTORIZE ? await c.env.VECTORIZE.describe() : null;
      vectors = d ? `${d.vectorCount} vectors, ${d.dimensions} dimensions` : "not bound here";
    } catch (e) {
      vectors = `unavailable (${String((e as Error)?.message ?? e).slice(0, 120)})`;
      h.flags.push(`Vectorize: ${vectors}`);
    }
    return c.html(page(c as never, "Health", settingsLayout("admin", { isAdmin: true, importOn: importEnabled(c.env) }, healthBody(h, vectors))));
  });

  for (const action of ["disable", "enable"] as const) {
    app.post(`/app/admin/users/${action}`, async (c) => {
      const user = c.get("user");
      if (!user?.is_admin) return c.text("Forbidden", 403);
      const id = String((await c.req.formData()).get("id") ?? "");
      if (!id || id === user.id) return c.text("You can't disable yourself.", 400);
      await setUserDisabled(c.env, id, action === "disable");
      await audit(c.env, user.id, `admin.${action}`, { user: id }, c.req.header("cf-connecting-ip"));
      if (action === "disable") {
        // The account is already refused and its token cutoff set; this sweep removes the grants themselves.
        try {
          await revokeAllGrants(c.env.OAUTH_PROVIDER, id);
        } catch (e) {
          return c.html(
            page(
              c as never,
              "Admin",
              html`<h1>Account disabled</h1><p class="error">Revoking its connected apps did not finish (${(e as Error).message}). Its credentials are already void; press Disable again to finish the sweep.</p><p><a href="/app/admin">Back</a></p>`,
            ),
            500,
          );
        }
      }
      return c.redirect("/app/admin", 303);
    });
  }

  // ---- stats ----
  app.get("/app/stats", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const range = (["7d", "30d", "90d", "all"].includes(c.req.query("range") ?? "") ? c.req.query("range") : "30d") as Range;
    let scope = (c.req.query("scope") === "everyone" ? "everyone" : "mine") as Scope;
    if (scope === "everyone" && !user.is_admin) scope = "mine";
    const s = await gatherStats(c.env, user, scope, range);
    const link = (sc: Scope, r: Range, label: string, current: boolean) =>
      html`<a href="/app/stats?scope=${sc}&range=${r}" ${current ? html`aria-current="page"` : ""}>${label}</a>`;
    const anyEstimated = s.ai.some((r) => r.estimated_calls > 0);
    const jev = jevModel(c.env);
    const pct = s.storage.limit ? Math.round((100 * s.storage.used) / s.storage.limit) : 0;
    const section = (title: string, sub: string | H, body: H, ic = "chart") =>
      html`<section class="card mb-6 p-0"><div class="flex items-center gap-3 border-b border-line px-5 py-4 sm:px-6">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-accent-2">${icon(ic, "size-5")}</span>
        <div class="min-w-0"><h2 class="m-0 text-base">${title}</h2><p class="m-0 text-xs text-muted">${sub}</p></div></div>
        <div class="px-5 py-5 sm:px-6">${body}</div></section>`;
    const body = html`${pageHeader(
      "Stats",
      html`Tracking started ${s.since}; there is no history before that. Period starts ${s.from}.`,
      html`${user.is_admin ? html`<nav class="seg" aria-label="Whose stats">${link("mine", range, "Mine", scope === "mine")}${link("everyone", range, "Everyone", scope === "everyone")}</nav>` : ""}
        <nav class="seg" aria-label="Period">${(["7d", "30d", "90d", "all"] as Range[]).map((r) => link(scope, r, r === "all" ? "All" : r, r === range))}</nav>`,
    )}

      ${section(
        "Memory",
        "What was saved in this period, and what your memory holds now.",
        html`${barChart("saved", "Notes saved (created or updated) per period", s.saved, "notes")}
      <div class="stat-row">
        <div class="stat"><strong>${s.created}</strong> created</div>
        <div class="stat"><strong>${s.updated}</strong> updated</div>
        <div class="stat"><strong>${s.deleted}</strong> deleted</div>
        <div class="stat"><strong>${s.byYou}</strong> by you (web)</div>
        <div class="stat"><strong>${s.byAi}</strong> by AI</div>
      </div>
      ${s.clients.length ? html`<p class="m-0 flex flex-wrap items-center gap-2 text-sm text-muted">AI writes by client: ${s.clients.map(([k, v]) => html`<span class="rounded-full bg-sunken px-2.5 py-0.5 text-xs font-medium text-fg-2 ring-1 ring-line">${k} ${v}</span>`)}</p>` : ""}`,
      )}
      ${
        s.memory
          ? html`<h2 class="sr-only">Your memory now</h2>
            <div class="stat-row">
              <div class="stat"><strong>${s.memory.notes}</strong> notes now</div>
              <div class="stat"><strong>${s.memory.observations}</strong> observations</div>
              <div class="stat"><strong>${s.memory.relations.resolved}</strong> resolved links</div>
              <div class="stat"><strong>${s.memory.relations.unresolved}</strong> unresolved links</div>
              <div class="stat"><strong>${s.memory.revisionsRetained}</strong> revisions retained (${fmtBytes(s.memory.revisionBytes)})</div>
              <div class="stat"><strong>${fmtBytes(s.storage.used)}</strong> of ${fmtBytes(s.storage.limit)} used (${pct}%)
                <svg class="mt-2 block h-1 w-full overflow-hidden rounded-full" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="4" class="rank-track"></rect><rect width="${Math.max(1, Math.min(100, pct))}" height="4" class="${pct >= 90 ? "fill-danger" : pct >= 75 ? "fill-warn" : "rank-fill"}"></rect></svg></div>
            </div>
            <div class="mb-6 grid gap-4 md:grid-cols-3">
              <div class="card"><p class="label">By kind</p>${rankList(s.memory.byType.map((t) => ({ label: t.type, value: t.n })))}</div>
              <div class="card"><p class="label">Top tags</p>${rankList(
                s.memory.topTags.map((t) => ({ label: html`#${t.tag}`, value: t.n })),
                "No tags yet.",
              )}</div>
              <div class="card"><p class="label">Top categories</p>${rankList(
                s.memory.topCategories.map((t) => ({ label: html`[${t.category}]`, value: t.n })),
                "No observations yet.",
              )}</div>
            </div>`
          : s.everyone
            ? html`<div class="stat-row">
                <div class="stat"><strong>${s.everyone.users}</strong> accounts</div>
                <div class="stat"><strong>${s.everyone.notes}</strong> notes</div>
                <div class="stat"><strong>${fmtBytes(s.everyone.bytes)}</strong> stored</div>
              </div>
              ${s.typesCreated.length ? html`<p class="mb-6 flex flex-wrap items-center gap-2 text-sm text-muted">Notes created by kind: ${s.typesCreated.map(([k, v]) => html`<span class="rounded-full bg-sunken px-2.5 py-0.5 text-xs font-medium text-fg-2 ring-1 ring-line">${k} ${v}</span>`)}</p>` : ""}`
            : ""
      }

      ${section(
        "Activity",
        "Searches, reads and writes by you and your assistants.",
        html`${barChart("activity", "Searches, reads, writes, edits and deletes per period", s.activity, "operations")}
      <div class="stat-row">
        <div class="stat"><strong>${s.searches}</strong> searches</div>
        <div class="stat"><strong>${s.reads}</strong> reads</div>
        <div class="stat"><strong>${s.created}</strong> writes</div>
        <div class="stat"><strong>${s.updated}</strong> edits</div>
        <div class="stat"><strong>${s.deleted}</strong> deletes</div>
        ${s.apps !== null ? html`<div class="stat"><strong>${s.apps}</strong> connected apps</div>` : ""}
      </div>
      ${s.tools.length ? html`<p class="label mt-5">MCP calls by tool</p><table class="mb-0"><tr><th>Tool</th><th class="w-24 text-right">Calls</th></tr>${s.tools.map(([k, v]) => html`<tr><td><code>${k}</code></td><td>${v}</td></tr>`)}</table>` : ""}`,
        "bolt",
      )}

      ${section(
        "AI usage",
        "Calls to Jev and the embedding model, with list-price estimates.",
        html`${
          s.ai.length
            ? html`<table class="mt-0"><tr><th>Model</th><th>Purpose</th><th>Calls</th><th>Failed</th><th>Timed out</th><th>Avg latency</th><th>Input tokens</th><th>Output tokens</th><th>Est. cost</th></tr>
          ${s.ai.map(
            (
              r,
            ) => html`<tr><td><code>${r.model}</code></td><td>${r.purpose}</td><td>${r.calls}</td><td>${r.failed}</td><td>${r.unknown_calls}</td><td>${r.calls ? Math.round(r.latency_ms / r.calls) : 0} ms</td>
            <td>${r.input_tokens}${r.estimated_calls ? "*" : ""}</td><td>${r.output_tokens}</td><td>${fmtUsd(estimateCost(r.model, r.input_tokens, r.output_tokens))}</td></tr>`,
          )}
          <tr><td colspan="8"><strong>Total</strong></td><td><strong>${fmtUsd(s.ai.reduce((t, r) => t + (estimateCost(r.model, r.input_tokens, r.output_tokens) ?? 0), 0))}</strong></td></tr></table>`
            : html`<p class="m-0 text-sm text-muted">No AI calls in this period.</p>`
        }
      ${s.memory ? html`<p class="mt-3 mb-0 text-sm text-muted">Semantic index: ${s.memory.chunks.indexed} chunks indexed, ${s.memory.chunks.pending} pending.</p>` : ""}
      <details class="mt-4 text-sm"><summary>About these numbers</summary>
        <p>Jev (${jev ?? `${DEFAULT_JEV_MODEL}, currently off`}) re-ranks search results and checks new notes for duplicates and contradictions. Costs are list prices: Jev $0.042 per million input tokens, output free
        (<a href="${PRICING_SOURCES.jev}">model page</a>); qwen3-embedding-0.6b $0.012 per million input tokens (<a href="${PRICING_SOURCES.workersAi}">Workers AI pricing</a>).
        Workers AI includes 10,000 free neurons a day, which these estimates ignore.</p>
        ${anyEstimated ? html`<p>* Some token counts are estimated (about 4 characters per token): embedding models don't report usage.</p>` : ""}
      </details>`,
        "sparkle",
      )}

      ${
        s.everyone
          ? html`<h2>Invites</h2><div class="stat-row"><div class="stat"><strong>${s.everyone.invitesSent}</strong> sent</div><div class="stat"><strong>${s.everyone.invitesAccepted}</strong> accepted</div></div>`
          : ""
      }`;
    return c.html(page(c as never, "Stats", body));
  });
}

const pct = (x: number) => `${(x * 100).toFixed(x && x < 0.01 ? 1 : 0)}%`;

function aiTable(rows: Health["ai"]["last24h"]): H {
  if (!rows.length) return html`<p class="muted small">No AI calls.</p>`;
  return html`<table><tr><th>Model</th><th>Purpose</th><th>Calls</th><th>Failed</th><th>of which timed out</th><th>Failure rate</th></tr>
    ${rows.map(
      (r) =>
        html`<tr><td>${r.model}</td><td>${r.purpose}</td><td>${r.calls}</td><td>${r.failed}</td><td>${r.unknown}</td><td>${r.flagged ? html`<span class="badge red">${pct(r.failure_rate)}</span>` : pct(r.failure_rate)}</td></tr>`,
    )}</table>`;
}

/** The health page body: what `mise run prod:status` prints, minus what only the Cloudflare API knows (deployed version). */
export function healthBody(h: Health, vectors: string): H {
  const run = h.cron.last_finished;
  return html`<h2 class="mt-0 mb-1 text-xl">Production health</h2>
    <p class="mt-0 muted small">Counts and metadata only. Generated ${when(h.generated_at)}. The same checks run from a terminal with <code>mise run prod:status</code>, which also shows the deployed version.</p>
    ${
      h.flags.length
        ? html`<div class="callout"><strong>Red flags</strong><ul>${h.flags.map((f) => html`<li>${f}</li>`)}</ul></div>`
        : html`<p><span class="badge">OK</span> No red flags.</p>`
    }
    ${h.warnings.length ? html`<ul class="small muted">${h.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ""}
    <h3>Counts</h3>
    <table><tr><th>Users</th><th>Active</th><th>Projects</th><th>Notes</th><th>Storage</th><th>Attachments</th><th>Vectors</th></tr>
    <tr><td>${h.counts.users}</td><td>${h.counts.active_users}</td><td>${h.counts.vaults}</td><td>${h.counts.notes}</td><td>${fmtBytes(h.counts.bytes)}</td><td>${h.counts.attachments}</td><td>${vectors}</td></tr></table>
    <h3>AI, last 24 hours</h3>${aiTable(h.ai.last24h)}
    <h3>AI, last 7 days (context; not flagged)</h3>${aiTable(h.ai.day7)}
    <h3>Nightly cron</h3>
    ${
      run
        ? html`<p>Last finished run: started ${when(run.started_at)}, finished ${when(run.finished_at ?? "")}, <strong>${run.status}</strong>; ${run.vaults} vault task(s) done, ${run.errors} failed, ${run.deferred} deferred${run.error ? html`; error: <code>${run.error}</code>` : ""}.</p>`
        : html`<p class="muted">No finished run recorded.</p>`
    }
    <p class="small muted">Last 7 days: ${h.cron.runs_7d} run(s), ${h.cron.failed_7d} with failures.</p>
    <h3>Imports and email</h3>
    <p>Stuck import jobs: ${h.imports.staging_stuck} staging, ${h.imports.running_stuck} running.
    Email in: ${h.email.day1.messages} message(s) since yesterday (${h.email.day1.attachments} attachments), ${h.email.day7.messages} in 7 days.</p>
    <h3>Migrations applied</h3>
    <p class="small">${h.migrations.applied.length ? h.migrations.applied.join(", ") : html`<span class="muted">unknown</span>`}</p>`;
}
