// /app/misses: what the user expected Cairn to know and it didn't (src/misses.ts). Newest first,
// filterable by project, each dismissable; "Clear" deletes them. Only the signed-in user's own
// misses: a shared project's owner never sees a member's questions.

import type { Hono } from "hono";
import { listVaults } from "../directory";
import { clearMisses, dismissMiss, listMisses, MISS_RETENTION_DAYS, missKindText } from "../misses";
import { admitWrite } from "../stats/limits";
import { ago, type H, html, when } from "./layout";
import type { AppEnv } from "./types";
import { clientBadge, emptyState, pageHeader } from "./ui";

type Page = (c: never, title: string, body: H, extra?: { vault?: string; q?: string }) => H;

const MULTI = "__several";

export function registerMisses(app: Hono<AppEnv>, page: Page, loginRedirect: (url: string) => string) {
  app.get("/app/misses", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(loginRedirect(c.req.url));
    const vaults = await listVaults(c.env, user.id);
    const want = c.req.query("project") || "";
    const v = want && want !== MULTI ? vaults.find((x) => x.name === want) : undefined;
    if (want && want !== MULTI && !v) return c.html(page(c as never, "Not found", html`<h1>Not found</h1><p>No project named ${want}.</p>`), 404);
    const vaultId = want === MULTI ? null : v ? v.id : undefined;
    const rows = await listMisses(c.env, user.id, { vaultId, limit: 200 });
    const done = c.req.query("done");
    const scopeField = want ? html`<input type="hidden" name="project" value="${want}">` : "";
    return c.html(
      page(
        c as never,
        "Misses",
        html`${pageHeader(
          "Misses",
          `Questions your notes didn't answer: searches that found nothing, results that didn't answer, and the times an assistant said "the notes don't say". Only yours, kept ${MISS_RETENTION_DAYS} days. Assistants can list them too: recent_activity with items=["miss"].`,
          rows.length
            ? html`<form method="post" action="/app/misses/clear" class="m-0">${scopeField}<button class="btn btn-secondary btn-sm" type="submit">Clear ${want ? "these" : "all"}</button></form>`
            : "",
        )}
        ${done === "cleared" ? html`<p class="callout tip">Cleared.</p>` : done === "dismissed" ? html`<p class="callout tip">Dismissed.</p>` : ""}
        <form method="get" action="/app/misses" class="mb-4 flex flex-wrap items-end gap-2">
          <div class="min-w-0 flex-1 sm:max-w-xs"><label for="project">Project</label>
          <select id="project" name="project"><option value="">every project</option>${vaults.map(
            (x) => html`<option value="${x.name}" ${x.name === want ? "selected" : ""}>${x.name}</option>`,
          )}<option value="${MULTI}" ${want === MULTI ? "selected" : ""}>searches across projects</option></select></div>
          <button class="btn btn-secondary" type="submit">Filter</button>
        </form>
        ${
          rows.length
            ? html`<ul class="m-0 list-none divide-y divide-line overflow-hidden rounded-2xl bg-surface p-0 shadow-card ring-1 ring-line">${rows.map(
                (m) => html`<li class="m-0 flex items-start gap-3 px-4 py-3 sm:px-5">
                <div class="min-w-0 flex-1">
                  <p class="m-0 text-sm break-words"><span class="font-medium text-fg">${m.query}</span>${m.count > 1 ? html` <span class="chip">×${m.count}</span>` : ""}</p>
                  <p class="m-0 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <span class="font-mono text-faint">${m.vault_name}</span>
                    <span class="chip font-mono">${m.tool}</span>
                    <span>${missKindText(m.kind)}</span>
                    ${m.client ? clientBadge(m.client) : ""}
                  </p>
                  ${m.expected ? html`<p class="m-0 mt-1 text-xs text-muted break-words">Expected: ${m.expected}</p>` : ""}
                  ${m.filters ? html`<p class="m-0 mt-1 font-mono text-xs text-faint break-all">${m.filters}</p>` : ""}
                </div>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <time class="block text-xs whitespace-nowrap text-muted" datetime="${m.last_at}" title="${when(m.last_at)}">${ago(m.last_at)}</time>
                  <form method="post" action="/app/misses/dismiss" class="m-0"><input type="hidden" name="id" value="${String(m.id)}">${scopeField}<button class="btn btn-ghost btn-sm" type="submit" title="Resolved, or not worth keeping">Dismiss</button></form>
                </div></li>`,
              )}</ul>`
            : html`<div class="card">${emptyState("search", "No misses.", "When a search finds nothing, or an assistant says your notes don't say, the question shows up here.")}</div>`
        }`,
      ),
    );
  });

  const back = (project: string, done: string) => `/app/misses?${new URLSearchParams({ ...(project ? { project } : {}), done })}`;

  app.post("/app/misses/dismiss", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    if (!(await admitWrite(c.env, user.id))) return c.text("Too many changes in the last minute. Try again shortly.", 429);
    const f = await c.req.formData();
    const id = Number(String(f.get("id") ?? ""));
    if (!Number.isInteger(id) || id <= 0) return c.text("Not found", 404);
    if (!(await dismissMiss(c.env, user.id, id))) return c.text("Not found", 404);
    return c.redirect(back(String(f.get("project") ?? ""), "dismissed"), 303);
  });

  app.post("/app/misses/clear", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    if (!(await admitWrite(c.env, user.id))) return c.text("Too many changes in the last minute. Try again shortly.", 429);
    const f = await c.req.formData();
    const project = String(f.get("project") ?? "");
    let vaultId: string | null | undefined;
    if (project === MULTI) vaultId = null;
    else if (project) {
      const v = (await listVaults(c.env, user.id)).find((x) => x.name === project);
      if (!v) return c.text("Not found", 404);
      vaultId = v.id;
    }
    await clearMisses(c.env, user.id, vaultId);
    return c.redirect(back(project, "cleared"), 303);
  });
}
