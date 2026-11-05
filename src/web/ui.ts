// Shared pieces of the app's UI: the shell options every page helper passes to layout(), and
// small markup helpers (page headers, settings tabs, empty states) so pages look the same.

import type { Context } from "hono";
import { listVaults, type User } from "../directory";
import { isSerious } from "./fun";
import { type H, html, icon, type LayoutOpts } from "./layout";
import type { AppEnv } from "./types";

/** Everything layout() needs from the request: user, nav state, project list, Serious mode. */
export function shellOpts(c: Context<AppEnv>): Omit<LayoutOpts, "title" | "body"> {
  const user = c.get("user") as User | undefined;
  return {
    appName: c.env.APP_NAME || "Cairn",
    user,
    restricted: !!c.get("session")?.restricted,
    fun: !!user && !isSerious(c),
    path: c.req.path,
    projects: user ? listVaults(c.env, user.id).catch(() => []) : undefined,
  };
}

/** A page title with an optional line under it and actions on the right. */
export function pageHeader(title: string | H, sub?: string | H, actions?: H | string): H {
  return html`<div class="mb-6 flex flex-wrap items-end justify-between gap-4 lg:mb-8">
    <div class="min-w-0">
      <h1 class="m-0 break-words text-balance">${title}</h1>
      ${sub ? html`<p class="mt-1 mb-0 text-sm text-muted">${sub}</p>` : ""}
    </div>
    ${actions ? html`<div class="flex flex-wrap items-center gap-2">${actions}</div>` : ""}
  </div>`;
}

export type SettingsTab = "connect" | "tokens" | "security" | "apps" | "capture" | "memory" | "import" | "invites" | "preferences" | "admin";

/**
 * Every settings page: a section nav (vertical on desktop, a scrolling strip on phones) and the
 * page body. Connect, Access tokens and Preferences are panels of /app/settings (ui.js switches
 * them in place); the rest are their own pages.
 */
export function settingsLayout(active: SettingsTab | null, o: { isAdmin: boolean; importOn?: boolean }, body: H): H {
  const t = (key: SettingsTab, href: string, label: string, ic: string, inPage = false) =>
    html`<a href="${href}" ${inPage ? html`data-tab="${key}"` : ""} ${key === active ? html`aria-current="page"` : ""}
      class="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap text-muted no-underline hover:bg-sunken hover:text-fg hover:no-underline aria-[current=page]:bg-surface aria-[current=page]:text-fg aria-[current=page]:shadow-card aria-[current=page]:ring-1 aria-[current=page]:ring-line">${icon(ic, "size-[18px] shrink-0 opacity-70")}${label}</a>`;
  return html`<h1 class="mb-1">Settings</h1>
  <p class="mt-0 mb-6 text-sm text-muted">Connections, sign-in and how Cairn behaves for you.</p>
  <div class="grid gap-6 lg:grid-cols-[13.5rem_1fr] lg:gap-10">
    <nav class="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:sticky lg:top-24 lg:mx-0 lg:flex-col lg:self-start lg:overflow-visible lg:px-0" aria-label="Settings sections">
      ${t("connect", "/app/settings#connect", "Connect", "plug", true)}
      ${t("tokens", "/app/settings#tokens", "Access tokens", "key", true)}
      ${t("security", "/app/settings/account", "Passkeys & security", "shield")}
      ${t("apps", "/app/settings/apps", "Connected apps", "bolt")}
      ${t("capture", "/app/settings/capture", "Capture", "download")}
      ${t("memory", "/app/settings/memory", "Core memory", "note")}
      ${o.importOn ? t("import", "/app/settings/import", "Import", "folder") : ""}
      ${t("invites", "/app/settings/invites", "Invites", "user")}
      ${t("preferences", "/app/settings#preferences", "Preferences", "gear", true)}
      ${o.isAdmin ? t("admin", "/app/admin", "Admin", "shield") : ""}
    </nav>
    <div class="min-w-0">${body}</div>
  </div>`;
}

/** A settings panel: a card with a title, a line of description and its content. */
export function panel(title: string, desc: string | H, body: H, opts: { id?: string; tab?: string } = {}): H {
  return html`<section class="card mb-6 p-0" ${opts.id ? html`id="${opts.id}"` : ""} ${opts.tab ? html`data-panel="${opts.tab}"` : ""}>
    <div class="border-b border-line px-5 py-4 sm:px-6"><h2 class="m-0 text-base">${title}</h2><p class="mt-1 mb-0 text-sm text-muted">${desc}</p></div>
    <div class="px-5 py-5 sm:px-6">${body}</div>
  </section>`;
}

/** A copyable one-line command or URL. */
export function copyLine(id: string, text: string): H {
  return html`<div class="flex items-stretch gap-2"><code id="${id}" class="block min-w-0 flex-1 overflow-x-auto rounded-lg bg-sunken px-3 py-2.5 text-[13px] whitespace-nowrap ring-1 ring-line">${text}</code>
    <button type="button" class="btn btn-secondary shrink-0" data-copy-from="${id}" hidden>${icon("copy", "size-4")}<span class="sr-only sm:not-sr-only">Copy</span></button></div>`;
}

/** A section inside a settings page: title + description on the left, content on the right. */
export function settingsSection(title: string, desc: string | H, body: H, id?: string): H {
  return html`<section class="grid gap-x-10 gap-y-4 border-b border-line py-8 first:pt-2 last:border-b-0 lg:grid-cols-[18rem_1fr]" ${id ? html`id="${id}"` : ""}>
    <div><h2 class="mt-0 mb-1 text-base">${title}</h2><p class="m-0 text-sm text-muted">${desc}</p></div>
    <div class="min-w-0">${body}</div>
  </section>`;
}

/** A focused, centred card for a confirmation or a one-off result (delete account, new codes…). */
export function focusCard(ic: string, title: string | H, body: H, tone: "brand" | "danger" = "brand"): H {
  const badge = tone === "danger" ? "bg-danger-soft text-danger" : "brand-grad text-white shadow-lg shadow-brand-pink/25";
  return html`<div class="mx-auto mt-2 max-w-xl sm:mt-6">
    <div class="card p-6 sm:p-8">
      <div class="mb-5 flex size-12 items-center justify-center rounded-2xl ${badge}">${icon(ic, "size-6")}</div>
      <h1 class="mt-0 mb-3 text-2xl text-balance">${title}</h1>
      ${body}
    </div>
  </div>`;
}

/** A friendly empty state with an icon, a line, and an optional action. */
export function emptyState(ic: string, title: string, line: string | H, action?: H): H {
  return html`<div class="empty">
    <span class="mb-3 flex size-12 items-center justify-center rounded-2xl bg-violet-soft text-accent-2">${icon(ic, "size-6")}</span>
    <p class="m-0 font-semibold text-fg">${title}</p>
    <p class="mt-1 mb-0 max-w-sm">${line}</p>
    ${action ? html`<div class="mt-4">${action}</div>` : ""}
  </div>`;
}

/** A coloured dot + client name for activity lists ("claude-code", "web", a token…). */
export function clientBadge(client: string | null | undefined, label?: string): H {
  const name = client ?? "unknown";
  const kind = name === "web" ? "web" : name.startsWith("token:") ? "token" : "agent";
  const ic = kind === "web" ? "user" : kind === "token" ? "key" : "bolt";
  const cls = kind === "web" ? "bg-info-soft text-info" : kind === "token" ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent";
  return html`<span class="inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${cls}">${icon(ic, "size-3.5 shrink-0")}<span class="truncate">${label ?? name}</span></span>`;
}
