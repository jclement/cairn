// Round 3a web: activity feed, note history with diffs and revert, bulk revert by client,
// pin toggle, core-memory panel, memory settings.

import type { Hono } from "hono";
import { canWriteVault, getVault, listVaults, type User, type Vault, vaultRef, vaultStub } from "../directory";
import { type Caller, DEFAULT_CORE_BUDGET, publicOrigin } from "../env";
import { diffLines } from "../memory/diff";
import { admitWrite } from "../stats/limits";
import { INDEX_PERMALINK } from "../vault/do";
import { importEnabled } from "./importer";
import { ago, type H, html, icon, noteHref, when } from "./layout";
import type { AppEnv } from "./types";
import { clientBadge, emptyState, pageHeader, panel, settingsLayout } from "./ui";

type Page = (c: never, title: string, body: H, extra?: { vault?: string; q?: string }) => H;

/** Notes one bulk-undo request may change (each also takes a write-limiter token). */
export const BULK_REVERT_MAX = 50;

const webCaller = (user: User, tool: string): Caller => ({ userId: user.id, username: user.username, client: "web", tool });
const fmtDelta = (d: number | null) =>
  d === null ? "" : `${d >= 0 ? "+" : "−"}${Math.abs(d) >= 1024 ? `${(Math.abs(d) / 1024).toFixed(1)} KB` : `${Math.abs(d)} B`}`;
/**
 * Who made a change: "ada (web)" on the web; the app's name for an assistant, with the person it
 * acted for when that isn't the viewer (a shared project: "Claude Code for ada").
 */
const who = (client: string | null, username: string | null, viewer?: string) =>
  client === "web"
    ? `${username ?? "you"} (web)`
    : `${client ?? "?"}${username && viewer && username !== viewer && username !== "cairn" ? ` for ${username}` : ""}`;
const historyHref = (vault: string, permalink: string, rev?: number) => `${noteHref(vault, permalink)}/history${rev ? `?rev=${rev}` : ""}`;
/** A round icon for a revision's action: create, edit, delete, move, revert… */
const actionDot = (action: string) => {
  const [ic, cls] =
    action === "create"
      ? ["plus", "bg-ok-soft text-ok"]
      : action === "delete"
        ? ["trash", "bg-danger-soft text-danger"]
        : action.includes("revert") || action.includes("restore")
          ? ["history", "bg-info-soft text-info"]
          : ["pencil", "bg-violet-soft text-accent-2"];
  return html`<span class="flex size-8 shrink-0 items-center justify-center rounded-full ${cls}" aria-hidden="true">${icon(ic, "size-4")}</span>`;
};
const deltaChip = (d: number | null) =>
  d === null ? "" : html`<span class="font-mono text-xs tabular-nums ${d >= 0 ? "text-ok" : "text-danger"}">${fmtDelta(d)}</span>`;

async function budgetFor(env: AppEnv["Bindings"], userId: string): Promise<number> {
  return (await env.DB.prepare("SELECT core_budget FROM users WHERE id = ?").bind(userId).first<{ core_budget: number }>())?.core_budget ?? DEFAULT_CORE_BUDGET;
}

/** The "Core memory" panel for /app (default vault). */
export async function corePanel(env: AppEnv["Bindings"], user: User): Promise<H> {
  const v = await getVault(env, user.id);
  if (!v) return html``;
  const c = await vaultStub(env, v).coreMemory(vaultRef(v), await budgetFor(env, user.id));
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  const pct = Math.min(100, Math.round((100 * c.fullBytes) / Math.max(1, c.budget)));
  return html`<section class="card" aria-labelledby="core-h">
    <div class="card-head mb-2"><h2 id="core-h" class="m-0 text-base">Core memory</h2><a class="text-xs font-medium" href="/app/settings/memory">change budget</a></div>
    <p class="mt-0 text-sm text-muted">Loaded by your assistants at the start of a session (<code>core_memory</code>):
      ${c.index ? html`<a href="${noteHref(v.name, INDEX_PERMALINK)}">the index note</a>` : html`the index note (created the first time an assistant asks)`} and
      ${c.pinned.length} pinned note(s).</p>
    <meter class="sr-only" min="0" max="${c.budget}" value="${Math.min(c.fullBytes, c.budget)}" high="${Math.round(c.budget * 0.8)}" optimum="0">${kb(c.fullBytes)}</meter>
    <svg class="block h-2 w-full overflow-hidden rounded-full" viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="2" class="fill-sunken"></rect><rect width="${pct}" height="2" class="${c.truncated ? "fill-danger" : pct > 80 ? "fill-warn" : "fill-accent-2"}"></rect></svg>
    <p class="mt-1.5 mb-0 text-xs text-muted tabular-nums">${kb(c.fullBytes)} of ${kb(c.budget)}</p>
    ${c.truncated ? html`<p class="callout warning text-xs">Over budget: assistants see a cut-down version. Shorten the index, unpin something, or condense a pinned note.</p>` : ""}
    ${c.pinned.length ? html`<ul class="mt-3 mb-0 space-y-1 text-sm">${c.pinned.map((p) => html`<li class="truncate">📌 <a href="${noteHref(v.name, p.permalink)}">${p.title}</a></li>`)}</ul>` : ""}
  </section>`;
}

/** Pin/unpin + history buttons for the note page (pin only for those who can write). */
export function noteTools(vault: string, permalink: string, pinned: boolean, canWrite = true): H {
  if (!canWrite) return html`<a class="btn btn-ghost btn-sm" href="${historyHref(vault, permalink)}">${icon("history", "size-4")}History</a>`;
  return html`<form class="m-0" method="post" action="/app/v/${encodeURIComponent(vault)}/pin">
      <input type="hidden" name="permalink" value="${permalink}"><input type="hidden" name="pin" value="${pinned ? "0" : "1"}">
      <button class="btn btn-secondary btn-sm${pinned ? " text-accent" : ""}" type="submit" title="${pinned ? "Remove from the core memory your assistants load first" : "Add to the core memory your assistants load first"}">${icon("pin", "size-4")}<span class="sm:hidden">${pinned ? "Unpin" : "Pin"}</span><span class="max-sm:sr-only">${pinned ? "Unpin from core memory" : "Pin to core memory"}</span></button>
    </form>
    <a class="btn btn-ghost btn-sm" href="${historyHref(vault, permalink)}">${icon("history", "size-4")}History</a>`;
}

function renderDiff(before: string, after: string): H {
  const ops = diffLines(before, after);
  const changed = ops.some((o) => o.op !== "eq");
  // context: keep 3 lines around changes
  const keep = new Set<number>();
  ops.forEach((o, i) => {
    if (o.op !== "eq") for (let k = Math.max(0, i - 3); k <= Math.min(ops.length - 1, i + 3); k++) keep.add(k);
  });
  const rows: H[] = [];
  const unified: H[] = [];
  let skipped = false;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (!keep.has(i)) {
      if (!skipped) {
        rows.push(html`<tr class="gap"><td colspan="4">…</td></tr>`);
        unified.push(html`<div class="gap">…</div>`);
      }
      skipped = true;
      continue;
    }
    skipped = false;
    if (o.op === "eq") rows.push(html`<tr><td class="ln">${o.a}</td><td>${o.text}</td><td class="ln">${o.b}</td><td>${o.text}</td></tr>`);
    else if (o.op === "del") rows.push(html`<tr><td class="ln">${o.a}</td><td class="del">${o.text}</td><td class="ln"></td><td></td></tr>`);
    else rows.push(html`<tr><td class="ln"></td><td></td><td class="ln">${o.b}</td><td class="add">${o.text}</td></tr>`);
    unified.push(html`<div class="${o.op}">${o.op === "add" ? "+ " : o.op === "del" ? "- " : "  "}${o.text}</div>`);
  }
  if (!changed) return html`<p class="muted">No textual change.</p>`;
  return html`<div class="diff-split"><table class="diff"><colgroup><col class="w-12"><col><col class="w-12"><col></colgroup><tr><th colspan="2">Before</th><th colspan="2">After</th></tr>${rows}</table></div>
    <pre class="diff-unified rounded-xl ring-1 ring-line">${unified}</pre>`;
}

export function registerRound3(app: Hono<AppEnv>, page: Page, loginRedirect: (url: string) => string) {
  // ---- activity feed ----
  app.get("/app/activity", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const client = c.req.query("client") || undefined;
    const vaults = await listVaults(c.env, user.id);
    const feeds = await Promise.all(
      vaults.map(async (v) => ({
        v,
        rows: await vaultStub(c.env, v).activity(vaultRef(v), { client, limit: 100 }),
        clients: await vaultStub(c.env, v).activityClients(vaultRef(v)),
      })),
    );
    const rows = feeds
      .flatMap(({ v, rows }) => rows.map((r) => ({ v, r })))
      .sort((a, b) => b.r.at.localeCompare(a.r.at))
      .slice(0, 150);
    const clients = new Map<string, number>();
    for (const f of feeds) for (const x of f.clients) clients.set(x.client, (clients.get(x.client) ?? 0) + x.n);
    const since = new Date(Date.now() - 86400e3).toISOString().slice(0, 16);
    return c.html(
      page(
        c as never,
        "Activity",
        html`${pageHeader(
          "Activity",
          "Every change to your notes, newest first: who made it (you on the web, or the app an assistant used), with what tool, and how much changed. Open an entry to see the diff or undo it.",
        )}
        <form method="get" action="/app/activity" class="mb-4 flex flex-wrap items-end gap-2">
          <div class="min-w-0 flex-1 sm:max-w-xs"><label for="client">Show changes by</label>
          <select id="client" name="client"><option value="">everyone</option>${[...clients.entries()].map(
            ([k, n]) => html`<option value="${k}" ${k === client ? "selected" : ""}>${k === "web" ? "you (web)" : k} (${n})</option>`,
          )}</select></div>
          <button class="btn btn-secondary" type="submit">Filter</button>
        </form>
        ${
          client && client !== "web"
            ? html`<form method="get" action="/app/activity/revert" class="card mb-4 flex flex-wrap items-end gap-3 border-l-4 border-l-danger">
                <input type="hidden" name="client" value="${client}">
                <div class="min-w-0 flex-1"><label for="since">Undo everything <strong>${client}</strong> changed since</label>
                <input id="since" name="since" type="datetime-local" value="${since}"></div>
                <button class="btn btn-danger" type="submit">Review undo…</button>
              </form>`
            : ""
        }
        ${
          rows.length
            ? html`<ul class="m-0 list-none divide-y divide-line overflow-hidden rounded-2xl bg-surface p-0 shadow-card ring-1 ring-line">${rows.map(
                ({ v, r }) => html`<li class="m-0 flex items-start gap-3 px-4 py-3 sm:items-center sm:px-5">
                ${actionDot(r.action)}
                <div class="min-w-0 flex-1">
                  <p class="m-0 truncate text-sm"><span class="text-muted">${r.action}</span> <a class="font-medium text-fg" href="${historyHref(v.name, r.permalink, r.id)}">${r.title}</a></p>
                  <p class="m-0 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"><span class="truncate font-mono text-faint">${v.name}/${r.permalink}</span>
                    <span class="sm:hidden">${clientBadge(r.client, who(r.client, r.username, user.username))}</span></p>
                </div>
                <div class="hidden shrink-0 items-center gap-2 sm:flex">${clientBadge(r.client, who(r.client, r.username, user.username))}${r.tool ? html`<span class="chip font-mono">${r.tool}</span>` : ""}</div>
                <div class="w-20 shrink-0 text-right"><time class="block text-xs whitespace-nowrap text-muted" datetime="${r.at}" title="${when(r.at)}">${ago(r.at)}</time>${deltaChip(r.delta)}</div></li>`,
              )}</ul>`
            : html`<div class="card">${emptyState("bolt", "No changes yet.", "When you or an assistant saves a note, it shows up here with a diff you can undo.")}</div>`
        }`,
      ),
    );
  });

  // ---- bulk revert by client ----
  const sinceParam = (raw: string | undefined) => {
    const d = raw ? new Date(raw.length === 16 ? `${raw}:00Z` : raw) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  };

  app.get("/app/activity/revert", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const client = c.req.query("client") ?? "";
    const since = sinceParam(c.req.query("since"));
    if (!client || !since)
      return c.html(page(c as never, "Undo", html`<p class="error">Pick an app and a start time.</p><p><a href="/app/activity">Back</a></p>`), 400);
    // Only projects the user may change (a reader of a shared project can't undo anything there).
    const vaults = (await listVaults(c.env, user.id)).filter(canWriteVault);
    const plans = await Promise.all(vaults.map(async (v) => ({ v, plan: await vaultStub(c.env, v).planClientRevert(vaultRef(v), client, since) })));
    const any = plans.some((p) => p.plan.length);
    const label: Record<string, string> = {
      delete: "delete it (it was created)",
      restore: "restore the text before",
      recreate: "recreate it (it was deleted)",
      "move back": "move it back where it was",
      nothing: "nothing to do",
      unavailable: "can't: earlier state not retained, or moved again since",
    };
    return c.html(
      page(
        c as never,
        "Undo changes",
        html`${pageHeader(`Undo everything ${client} changed since ${when(since)}`)}
        ${
          any
            ? html`<p>Each note goes back to how it was before <strong>${client}</strong> first touched it in this period. Every undo is a new revision, so you can undo the undo.</p>
            <form method="post" action="/app/activity/revert">
              <input type="hidden" name="client" value="${client}"><input type="hidden" name="since" value="${since}">
              <table><tr><th>Note</th><th>Undo will</th><th></th></tr>
              ${plans.flatMap(({ v, plan }) =>
                plan.map(
                  (p) => html`<tr><td><a href="${historyHref(v.name, p.permalink, p.revId)}">${p.title}</a> <span class="muted small">${v.name}</span></td>
                  <td>${label[p.plan]}</td>
                  <td>${p.laterOthers ? html`<span class="error small">also changed by others since; their later edits will be lost</span>` : ""}
                    <input type="hidden" name="e:${v.name}:${p.noteId}" value="${p.checksum ?? ""}"></td></tr>`,
                ),
              )}</table>
              <p class="flex flex-wrap gap-2"><button class="btn btn-danger" type="submit">${icon("history", "size-4")}Undo these changes</button> <a class="btn btn-ghost" href="/app/activity">Cancel</a></p>
            </form>`
            : html`<div class="card">${emptyState("history", "Nothing to undo", `${client} hasn't changed anything since then.`, html`<a class="btn btn-secondary" href="/app/activity">Back</a>`)}</div>`
        }`,
      ),
    );
  });

  app.post("/app/activity/revert", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const f = await c.req.formData();
    const client = String(f.get("client") ?? "");
    const since = sinceParam(String(f.get("since") ?? ""));
    if (!client || !since) return c.text("Bad request", 400);
    const expected = new Map<string, Record<string, string | null>>();
    for (const [k, val] of f.entries()) {
      const m = /^e:([^:]+):(\d+)$/.exec(k);
      if (!m) continue;
      const map = expected.get(m[1]) ?? {};
      map[m[2]] = String(val) || null;
      expected.set(m[1], map);
    }
    const out: { vault: string; permalink: string; ok: boolean; message: string }[] = [];
    // One write token per note, at most BULK_REVERT_MAX per request; the rest are reported and a
    // repeat of the same undo resumes (already-undone notes are skipped).
    let budget = 0;
    const wanted = Math.min(
      [...expected.values()].reduce((n, m) => n + Object.keys(m).length, 0),
      BULK_REVERT_MAX,
    );
    while (budget < wanted && (await admitWrite(c.env, user.id))) budget++;
    for (const [name, map] of expected) {
      const v = await getVault(c.env, user.id, name);
      if (!v || !canWriteVault(v)) continue;
      const res = await vaultStub(c.env, v).revertClient(vaultRef(v), webCaller(user, "web:revert-client"), client, since, map, budget);
      budget -= res.filter((r) => r.ok || !/^not done yet|^nothing to undo|^earlier text|^not in the confirmed/.test(r.message)).length;
      budget = Math.max(0, budget);
      for (const r of res) out.push({ vault: v.name, ...r });
    }
    return c.html(
      page(
        c as never,
        "Undo results",
        html`${pageHeader("Undo results")}<table><tr><th>Note</th><th>Result</th></tr>${out.map(
          (r) => html`<tr><td>${r.vault}/${r.permalink}</td><td class="${r.ok ? "" : "error"}">${r.message}</td></tr>`,
        )}</table><p><a class="btn btn-secondary" href="/app/activity">Back to activity</a></p>`,
      ),
    );
  });

  // ---- per-note history, diff, revert ----
  app.get("/app/v/:vault/n/:rest{.+/history}", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const v = await getVault(c.env, user.id, decodeURIComponent(c.req.param("vault")));
    if (!v) return c.html(page(c as never, "Not found", html`<h1>Not found</h1>`), 404);
    const permalink = c.req
      .param("rest")
      .replace(/\/history$/, "")
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const stub = vaultStub(c.env, v);
    const h = await stub.noteHistory(vaultRef(v), permalink);
    if (!h)
      return c.html(
        page(
          c as never,
          "Not found",
          html`<div class="card mt-4">${emptyState("history", `No history for ${permalink}`, "This note has no recorded changes.")}</div>`,
          { vault: v.name },
        ),
        404,
      );
    const revId = Number(c.req.query("rev") ?? h.revisions[0]?.id);
    const d = Number.isFinite(revId) ? await stub.revisionDiff(vaultRef(v), revId) : null;
    const msg = c.req.query("msg");
    const title = h.current?.title ?? d?.rev.title ?? permalink;
    return c.html(
      page(
        c as never,
        `History: ${title}`,
        html`<div class="crumbs"><a href="${noteHref(v.name, permalink)}">${title}</a><span aria-hidden="true">/</span><span>history</span></div>
        ${pageHeader(
          html`History of ${title}`,
          `${h.revisions.length} ${h.revisions.length === 1 ? "change" : "changes"} kept. Pick one to see what it changed, or undo it.`,
          html`<a class="btn btn-secondary" href="${noteHref(v.name, permalink)}">${icon("note", "size-4")}Open note</a>`,
        )}
        ${msg ? html`<p class="callout tip">${msg}</p>` : ""}
        <div class="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <ol class="m-0 list-none self-start overflow-hidden rounded-2xl bg-surface p-1.5 shadow-card ring-1 ring-line lg:sticky lg:top-24">${h.revisions.map(
            (r) => html`<li class="m-0"><a href="${historyHref(v.name, permalink, r.id)}" ${r.id === revId ? html`aria-current="true"` : ""}
              class="flex items-center gap-3 rounded-xl px-2.5 py-2 text-fg no-underline hover:bg-sunken hover:no-underline aria-[current=true]:bg-accent-soft">
              ${actionDot(r.action)}
              <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${r.action} · ${who(r.client, r.username, user.username)}</span>
              <span class="block text-xs text-muted">${when(r.at)}</span></span>${deltaChip(r.delta)}</a></li>`,
          )}</ol>
          <div class="min-w-0">
          ${
            d
              ? html`<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h2 class="m-0 text-base">${d.rev.action} by ${who(d.rev.client, d.rev.username, user.username)} · ${when(d.rev.at)}</h2>
                  ${
                    canWriteVault(v)
                      ? html`<form method="post" action="/app/v/${encodeURIComponent(v.name)}/revert" class="m-0">
                    <input type="hidden" name="rev" value="${d.rev.id}">
                    <input type="hidden" name="permalink" value="${permalink}">
                    <input type="hidden" name="checksum" value="${h.current?.checksum ?? ""}">
                    <button class="btn btn-danger btn-sm" type="submit">${icon("history", "size-4")}${d.rev.action === "create" ? "Undo: delete this note" : d.rev.action === "delete" ? "Undo: restore this note" : "Undo this change"}</button>
                  </form>`
                      : ""
                  }
                </div>
                ${d.available ? renderDiff(d.before ?? "", d.after ?? "") : html`<p class="callout">The text for this change is no longer retained (history keeps the last 20 copies per note).</p>`}
                <p class="mt-3 text-xs text-muted">Undo makes a new revision, so you can undo the undo.</p>`
              : html`<div class="card">${emptyState("history", "Pick a change", "Choose a change on the left to see its diff.")}</div>`
          }</div>
        </div>`,
        { vault: v.name },
      ),
    );
  });

  app.post("/app/v/:vault/revert", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const v = await getVault(c.env, user.id, decodeURIComponent(c.req.param("vault")));
    if (!v) return c.text("Not found", 404);
    if (!canWriteVault(v)) return c.text("You have read-only access to this project.", 403);
    const f = await c.req.formData();
    const permalink = String(f.get("permalink") ?? "");
    if (!(await admitWrite(c.env, user.id))) {
      return c.redirect(
        `${historyHref(v.name, permalink)}?msg=${encodeURIComponent("Not undone: too many writes in the last minute. Try again shortly.")}`,
        303,
      );
    }
    const r = await vaultStub(c.env, v).revertRevision(
      vaultRef(v),
      webCaller(user, "web:revert"),
      Number(f.get("rev")),
      String(f.get("checksum") ?? "") || null,
    );
    const msg = r.ok ? `Undone: note ${r.value.action}.` : `Not undone: ${r.message}`;
    return c.redirect(`${historyHref(v.name, r.ok ? r.value.permalink : permalink)}?msg=${encodeURIComponent(msg)}`, 303);
  });

  // ---- pin / unpin ----
  app.post("/app/v/:vault/pin", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const v: Vault | null = await getVault(c.env, user.id, decodeURIComponent(c.req.param("vault")));
    if (!v) return c.text("Not found", 404);
    if (!canWriteVault(v)) return c.text("You have read-only access to this project.", 403);
    const f = await c.req.formData();
    const permalink = String(f.get("permalink") ?? "");
    const pin = f.get("pin") === "1";
    if (!(await admitWrite(c.env, user.id)))
      return c.html(page(c as never, "Not changed", html`<p class="error">Too many writes in the last minute. Try again shortly.</p>`), 429);
    const r = await vaultStub(c.env, v).editNote(vaultRef(v), webCaller(user, pin ? "web:pin" : "web:unpin"), {
      identifier: permalink,
      command: "set_metadata",
      metadata: { pinned: pin ? true : null },
    });
    if (!r.ok) return c.html(page(c as never, "Error", html`<p class="error">${r.message}</p>`), 400);
    return c.redirect(noteHref(v.name, r.value.note.permalink), 303);
  });

  // ---- memory settings ----
  app.get("/app/settings/memory", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const row = await c.env.DB.prepare("SELECT core_budget, garden_enabled FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ core_budget: number; garden_enabled: number }>();
    return c.html(
      page(
        c as never,
        "Memory settings",
        settingsLayout(
          "memory",
          { isAdmin: !!user.is_admin, importOn: importEnabled(c.env) },
          html`${c.req.query("saved") ? html`<p class="callout tip">Saved.</p>` : ""}
        ${panel(
          "Core memory",
          html`What your assistants load first, with <code>core_memory</code> (MCP URL ${publicOrigin(c.env)}/mcp). Pin notes from a note’s page.`,
          html`<form method="post" action="/app/settings/memory" class="m-0 space-y-5">
          <div class="max-w-xs"><label for="budget">Core memory budget (KB, 1–64)</label>
          <input id="budget" name="budget_kb" type="text" inputmode="numeric" value="${Math.round((row?.core_budget ?? DEFAULT_CORE_BUDGET) / 1024)}"></div>
          <label class="items-start! rounded-xl bg-sunken p-4"><input type="checkbox" name="garden" value="1" ${row?.garden_enabled ? "checked" : ""} class="mt-1"> <span><strong class="block text-fg">Memory gardening</strong>A nightly checklist of things to tidy (orphans, broken links, contradictions…) and a weekly digest of what your assistants learned. Both are written as notes; nothing is changed for you.</span></label>
          <p class="mb-0"><button class="btn btn-primary" type="submit">Save</button></p>
        </form>`,
        )}`,
        ),
      ),
    );
  });

  app.post("/app/settings/memory", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    if (!(await admitWrite(c.env, user.id)))
      return c.html(page(c as never, "Not saved", html`<p class="error">Too many changes in the last minute. Try again shortly.</p>`), 429);
    const f = await c.req.formData();
    const kb = Math.min(Math.max(Math.round(Number(String(f.get("budget_kb") ?? "8")) || 8), 1), 64);
    await c.env.DB.prepare("UPDATE users SET core_budget = ?, garden_enabled = ? WHERE id = ?")
      .bind(kb * 1024, f.get("garden") ? 1 : 0, user.id)
      .run();
    return c.redirect("/app/settings/memory?saved=1", 303);
  });
}
