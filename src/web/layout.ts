import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { User } from "../directory";

export type H = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface ProjectSummary {
  name: string;
  is_default: number | boolean;
  note_count: number;
}

export interface LayoutOpts {
  title: string;
  appName: string;
  user?: User | null;
  body: H;
  vault?: string;
  q?: string;
  restricted?: boolean;
  /** Extra page bundles (ES modules under /app/dist/). */
  scripts?: string[];
  fun?: boolean;
  /** The request path: picks the active navigation item. */
  path?: string;
  /** The signed-in user's projects, for the sidebar's project switcher. */
  projects?: ProjectSummary[] | Promise<ProjectSummary[]>;
  /** Render in the centred auth layout (sign-up, sign-in, re-auth, consent) even when signed in;
   * a string names the icon in the card's badge (default: fingerprint). */
  auth?: boolean | string;
}

/** Inline SVG symbols used across the app (stroke icons, 24×24). */
const ICONS = raw(`<svg width="0" height="0" class="absolute" aria-hidden="true" focusable="false"><defs>
<linearGradient id="g-brand" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ff8a3d"/><stop offset=".5" stop-color="#ff3d8b"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient>
<symbol id="i-cairn" viewBox="0 0 64 64"><g fill="url(#g-brand)"><ellipse cx="32" cy="52" rx="22" ry="8"/><ellipse cx="31" cy="38.5" rx="16" ry="6.5"/><ellipse cx="33" cy="27" rx="11.5" ry="5.2"/><ellipse cx="32" cy="17.5" rx="7.5" ry="4"/></g><circle cx="32" cy="8.5" r="2.8" fill="currentColor"/></symbol>
<symbol id="i-home" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10.2 12 3.5l8.5 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19z"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></symbol>
<symbol id="i-graph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.4 7.6 15.5 6.4M7.3 9.2l3.5 6.6M16.8 8.3l-3.6 7.5"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-chart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/></symbol>
<symbol id="i-sparkle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><path d="M11 3.5 12.7 8l4.5 1.7-4.5 1.8L11 16l-1.8-4.5L4.8 9.7 9.2 8z"/><path d="m18 14 .8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></symbol>
<symbol id="i-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3.4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3.4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><path d="M12 3 19 6v5.2c0 4.3-2.9 8.1-7 9.8-4.1-1.7-7-5.5-7-9.8V6z"/><path d="m9 12 2 2 4-4" stroke-linecap="round"/></symbol>
<symbol id="i-logout" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10"/></symbol>
<symbol id="i-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/></symbol>
<symbol id="i-updown" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m8 9 4-4 4 4M8 15l4 4 4-4"/></symbol>
<symbol id="i-panel" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/></symbol>
<symbol id="i-user" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></symbol>
<symbol id="i-key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4.5"/><path d="m11.3 11.7 8.7-8.7M16.5 6.5l3 3M14 9l2 2"/></symbol>
<symbol id="i-note" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><path d="M6.5 3.5h7.5l4.5 4.5v12.5h-12z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4" stroke-linecap="round"/></symbol>
<symbol id="i-bolt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/></symbol>
<symbol id="i-plug" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5V7M15 2.5V7M6 7h12v4a6 6 0 0 1-12 0zM12 17v4.5"/></symbol>
<symbol id="i-download" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/></symbol>
<symbol id="i-pencil" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></symbol>
<symbol id="i-history" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 4v4.5H8M12 7.5V12l3 2"/></symbol>
<symbol id="i-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3.5h6l-1 5 3.5 3.5v1.5h-11V12L10 8.5z"/><path d="M12 13.5V21"/></symbol>
<symbol id="i-code" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m8 7-5 5 5 5M16 7l5 5-5 5"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16M9.5 6.5V4h5v2.5M6 6.5l1 14h10l1-14M10 10.5v6M14 10.5v6"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5"/></symbol>
<symbol id="i-clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m20 11.5-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4"/></symbol>
<symbol id="i-fingerprint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.8 5.2A8 8 0 0 1 20 11.5c0 1.3-.1 2.6-.4 3.8M4.2 9.3A8 8 0 0 0 4 11.5c0 2.4-.6 4.3-1 5.5"/><path d="M8 11.5a4 4 0 0 1 8 0c0 3-.5 5.8-1.6 8.3M12 11.5c0 3.4-.8 6.6-2.4 9.3M7.9 15.5c-.3 1.6-.9 3-1.7 4.3"/></symbol>
</defs></svg>`);

/** An icon from the sprite above. */
export const icon = (name: string, cls = "size-5") => raw(`<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`);

const HEAD = (title: string, appName: string, extra: H | string = "") => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0e0b17">
<title>${title} · ${appName}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/app/viewer/manifest.webmanifest">
<link rel="preload" href="/app/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/app/owg/css/owg-fonts.min.css">
<link rel="stylesheet" href="/app/ui/app.css">
<script src="/app/ui/ui.js"></script>
<script type="module" src="/app/cairn/passkey.js"></script>
${extra}
</head>`;

/** Which sidebar item a path belongs to. */
export function navKey(path: string): string {
  if (path === "/app" || path === "/app/") return "home";
  if (path.startsWith("/app/search")) return "search";
  if (path.startsWith("/app/graph")) return "graph";
  if (path.startsWith("/app/activity")) return "activity";
  if (path.startsWith("/app/new")) return "new";
  if (path.startsWith("/app/stats")) return "stats";
  if (path.startsWith("/app/wrapped")) return "wrapped";
  if (path.startsWith("/app/admin")) return "admin";
  if (path.startsWith("/app/settings")) return "settings";
  return "";
}

function authLayout(opts: LayoutOpts): H {
  const { title, appName, body } = opts;
  return html`${HEAD(title, appName)}
<body class="min-h-dvh">
${ICONS}
<div class="relative flex min-h-dvh flex-col lg:flex-row">
  <aside class="relative hidden overflow-hidden bg-night text-white lg:flex lg:w-[44%] lg:max-w-2xl lg:flex-col lg:justify-between lg:p-12">
    <div class="pointer-events-none absolute inset-0" aria-hidden="true">
      <div class="absolute -top-40 -left-24 size-[34rem] rounded-full bg-brand-violet/30 blur-3xl"></div>
      <div class="absolute top-1/3 -right-40 size-[30rem] rounded-full bg-brand-pink/25 blur-3xl"></div>
      <div class="absolute -bottom-40 left-10 size-[26rem] rounded-full bg-brand-orange/20 blur-3xl"></div>
    </div>
    <a href="/" class="relative flex items-center gap-2.5 text-lg font-semibold text-white no-underline hover:no-underline">${icon("cairn", "size-9 text-white")}${appName}</a>
    <div class="relative">
      <p class="text-4xl leading-tight font-semibold tracking-tight text-balance">Your AI forgets everything.<br><span class="brand-text">${appName} doesn’t.</span></p>
      <p class="mt-5 max-w-md text-base text-white/70">Markdown notes your assistants read and write for you, with a receipt for every save. Signed in with a passkey: no passwords, no email.</p>
    </div>
    <ul class="relative grid gap-3 text-sm text-white/70">
      <li class="flex items-center gap-3">${icon("key", "size-5 text-brand-pink")} Passkeys only, with recovery codes</li>
      <li class="flex items-center gap-3">${icon("note", "size-5 text-brand-orange")} Plain markdown you can export any time</li>
      <li class="flex items-center gap-3">${icon("plug", "size-5 text-brand-violet")} Works with claude.ai and Claude Code</li>
    </ul>
  </aside>
  <main id="main" class="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
    <div class="w-full max-w-md">
      <a href="/" class="mb-8 flex items-center justify-center gap-2 text-lg font-semibold text-fg no-underline hover:no-underline lg:hidden">${icon("cairn", "size-8 text-fg")}${appName}</a>
      <div class="auth-card rounded-3xl bg-surface p-6 shadow-pop ring-1 ring-line sm:p-8">
        <div class="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl brand-grad text-white shadow-lg shadow-brand-pink/25">${icon(typeof opts.auth === "string" ? opts.auth : "fingerprint", "size-8")}</div>
        ${body}
      </div>
      ${
        opts.user
          ? html`<form method="post" action="/auth/logout" class="mt-6 text-center"><button class="btn btn-ghost btn-sm" type="submit">${icon("logout", "size-4")} Sign out ${opts.user.username}</button></form>`
          : ""
      }
    </div>
  </main>
</div>
</body>
</html>`;
}

function projectSwitcher(projects: ProjectSummary[], current: string | undefined) {
  const cur = projects.find((p) => p.name === current) ?? projects.find((p) => p.is_default) ?? projects[0];
  if (!cur) return html``;
  return html`<details class="relative" data-menu>
    <summary class="flex w-full cursor-pointer list-none items-center gap-3 rounded-xl bg-white/[0.05] px-2.5 py-2 text-left ring-1 ring-white/10 hover:bg-white/[0.08] collapsed:justify-center collapsed:px-1 [&::-webkit-details-marker]:hidden">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-lg brand-grad text-sm font-bold text-white uppercase" aria-hidden="true">${cur.name.slice(0, 1)}</span>
      <span class="nav-label min-w-0 flex-1"><span class="block truncate text-sm font-semibold text-white">${cur.name}</span><span class="block text-xs text-white/50">${cur.note_count} ${cur.note_count === 1 ? "note" : "notes"}</span></span>
      <span class="nav-label">${icon("updown", "size-4 text-white/40")}</span>
      <span class="sr-only">Switch project</span>
    </summary>
    <div class="absolute top-full left-0 z-50 mt-2 w-56 overflow-hidden rounded-xl bg-[#1a1525] p-1.5 shadow-2xl ring-1 ring-white/10">
      <p class="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-white/40 uppercase">Projects</p>
      ${projects.map(
        (p) =>
          html`<a class="nav-link py-1.5" href="${folderHref(p.name, "")}" ${p.name === cur.name ? html`aria-current="page"` : ""}>${icon("folder", "size-4")}<span class="flex-1 truncate">${p.name}</span><span class="text-xs text-white/40">${p.note_count}</span></a>`,
      )}
      <div class="my-1 border-t border-white/10"></div>
      <a class="nav-link py-1.5" href="/app#new-project">${icon("plus", "size-4")} New project</a>
    </div>
  </details>`;
}

function appLayout(opts: LayoutOpts): H {
  const { title, appName, body } = opts;
  const user = opts.user as User;
  const key = navKey(opts.path ?? "");
  const pq = opts.vault ? `?project=${encodeURIComponent(opts.vault)}` : "";
  const cur = (k: string) => (k === key ? html`aria-current="page"` : "");
  const item = (k: string, href: string, label: string, ic: string) =>
    html`<a class="nav-link" href="${href}" ${cur(k)} title="${label}">${icon(ic)}<span class="nav-label">${label}</span></a>`;
  const extraHead = html`<link rel="stylesheet" href="/app/viewer/viewer.css">
<link rel="stylesheet" href="/app/viewer/note.css">
<script type="module" src="/app/dist/app.js"></script>
${(opts.scripts ?? []).map((s) => html`<script type="module" src="${s}"></script>`)}
${opts.vault ? html`<meta name="cairn-project" content="${opts.vault}">` : ""}
${opts.fun ? html`<link rel="stylesheet" href="/app/cairn/fun.css"><script src="/app/cairn/fun.js" defer></script>` : ""}`;
  const projects = Promise.resolve(opts.projects ?? []).then((ps) => projectSwitcher(ps, opts.vault));
  return html`${HEAD(title, appName, extraHead)}
<body class="min-h-dvh">
${ICONS}
<a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">Skip to content</a>

<aside id="sidebar" class="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-night text-white transition-[width] duration-200 collapsed:w-[4.5rem] lg:flex" aria-label="Sidebar">
  <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    <div class="absolute -top-32 -left-20 size-72 rounded-full bg-brand-violet/25 blur-3xl"></div>
    <div class="absolute top-1/2 -right-32 size-64 rounded-full bg-brand-pink/10 blur-3xl"></div>
  </div>
  <div class="relative flex h-16 shrink-0 items-center justify-between gap-2 px-4 collapsed:justify-center collapsed:px-2">
    <a href="/app" class="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight text-white no-underline hover:no-underline">${icon("cairn", "size-8 text-white")}<span class="nav-label">${appName}</span></a>
    <button type="button" class="nav-label rounded-md bg-transparent p-1.5 text-white/50 shadow-none hover:bg-white/10 hover:text-white" data-sidebar-toggle aria-label="Collapse sidebar" title="Collapse sidebar">${icon("panel")}</button>
  </div>
  <div class="relative px-3">${projects}</div>
  <nav class="relative mt-5 flex flex-1 flex-col gap-0.5 px-3" aria-label="Main">
    ${item("home", "/app", "Home", "home")}
    ${item("search", `/app/search${pq}`, "Search", "search")}
    ${item("activity", "/app/activity", "Activity", "bolt")}
    ${item("graph", `/app/graph${pq}`, "Graph", "graph")}
    ${item("new", `/app/new${pq}`, "New note", "plus")}
    ${item("stats", "/app/stats", "Stats", "chart")}
    ${opts.fun ? item("wrapped", "/app/wrapped", "Wrapped", "sparkle") : ""}
    <p class="nav-label mt-6 mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-white/40 uppercase">Account</p>
    ${item("settings", "/app/settings", "Settings", "gear")}
    ${user.is_admin ? item("admin", "/app/admin", "Admin", "shield") : ""}
  </nav>
  <div class="relative p-3">
    <a href="/app/settings#connect" class="nav-label block rounded-xl bg-white/[0.05] p-3 text-xs text-white/60 no-underline ring-1 ring-white/10 hover:bg-white/[0.08] hover:no-underline">
      <span class="mb-1 flex items-center gap-2 text-sm font-semibold text-white">${icon("plug", "size-4 text-brand-pink")} Connect Claude</span>
      Give claude.ai or Claude Code your memory.
    </a>
    <button type="button" class="hidden w-full rounded-md bg-transparent p-2 text-white/50 shadow-none hover:bg-white/10 hover:text-white collapsed:lg:flex" data-sidebar-toggle aria-label="Expand sidebar" title="Expand sidebar">${icon("panel")}</button>
  </div>
</aside>

<div class="flex min-h-dvh flex-col transition-[padding] duration-200 lg:pl-64 collapsed:lg:pl-[4.5rem]">
  <header class="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur-md sm:gap-4 sm:px-6 lg:px-8">
    <a href="/app" class="flex shrink-0 items-center lg:hidden" aria-label="${appName} home">${icon("cairn", "size-8 text-fg")}</a>
    <form class="search relative max-w-xl min-w-0 flex-1" action="/app/search" method="get" role="search">
      ${opts.vault ? html`<input type="hidden" name="v" value="${opts.vault}">` : ""}
      <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">${icon("search", "size-[18px]")}</span>
      <input type="search" name="q" placeholder="Search or jump to…" value="${opts.q ?? ""}" aria-label="Search notes" aria-keyshortcuts="Control+K Meta+K"
        class="h-10 rounded-xl bg-sunken pr-14 pl-10 shadow-none focus:bg-surface">
      <button type="button" data-palette class="absolute inset-y-0 right-2 my-auto hidden h-6 rounded-md bg-surface px-1.5 font-sans text-[11px] font-medium text-muted shadow-none ring-1 ring-line-strong hover:text-fg sm:inline-flex" aria-label="Open the command palette (Ctrl K)" title="Command palette (Ctrl K)">⌘K</button>
    </form>
    <details class="relative shrink-0" data-menu>
      <summary class="flex cursor-pointer list-none items-center rounded-full p-0.5 ring-1 ring-line hover:ring-line-strong [&::-webkit-details-marker]:hidden" aria-label="Account menu">
        <span class="flex size-8 items-center justify-center rounded-full brand-grad text-sm font-bold text-white uppercase" aria-hidden="true">${user.username.slice(0, 1)}</span>
      </summary>
      <div class="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl bg-surface p-1.5 shadow-pop ring-1 ring-line">
        <div class="px-3 py-2"><p class="text-xs text-muted">Signed in as</p><p class="truncate text-sm font-semibold text-fg">${user.username}</p></div>
        <div class="my-1 border-t border-line"></div>
        <a class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg-2 no-underline hover:bg-sunken hover:no-underline" href="/app/settings">${icon("gear", "size-4 text-muted")} Settings</a>
        <a class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg-2 no-underline hover:bg-sunken hover:no-underline" href="/app/settings/account">${icon("key", "size-4 text-muted")} Passkeys &amp; security</a>
        <a class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg-2 no-underline hover:bg-sunken hover:no-underline" href="/app/stats">${icon("chart", "size-4 text-muted")} Stats</a>
        <div class="my-1 border-t border-line"></div>
        <form method="post" action="/auth/logout"><button class="w-full justify-start gap-2.5 rounded-lg bg-transparent px-3 py-2 text-sm font-normal text-fg-2 shadow-none hover:bg-sunken" type="submit">${icon("logout", "size-4 text-muted")} Sign out</button></form>
      </div>
    </details>
  </header>

  <main id="main" class="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-16">
${body}
  </main>
</div>

<nav class="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden" aria-label="Main (mobile)">
  <a class="tab-link" href="/app" ${cur("home")}>${icon("home")}Home</a>
  <a class="tab-link" href="/app/search${pq}" ${cur("search")}>${icon("search")}Search</a>
  <a class="tab-link" href="/app/new${pq}" ${cur("new")}><span class="-mt-5 flex size-12 items-center justify-center rounded-full brand-grad text-white shadow-lg shadow-brand-pink/30">${icon("plus", "size-6")}</span><span class="sr-only">New note</span></a>
  <a class="tab-link" href="/app/graph${pq}" ${cur("graph")}>${icon("graph")}Graph</a>
  <a class="tab-link" href="/app/settings" ${cur("settings")}>${icon("gear")}Settings</a>
</nav>
</body>
</html>`;
}

export function layout(opts: LayoutOpts): H {
  if (!opts.user || opts.restricted || opts.auth) return authLayout(opts);
  return appLayout(opts);
}

export function noteHref(vault: string, permalink: string): string {
  return `/app/v/${encodeURIComponent(vault)}/n/${permalink.split("/").map(encodeURIComponent).join("/")}`;
}

export function folderHref(vault: string, path: string): string {
  return `/app/v/${encodeURIComponent(vault)}${path ? `/f/${path.split("/").map(encodeURIComponent).join("/")}` : ""}`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.replace("T", " ").slice(0, 16);
}

/** "3 min ago", "yesterday", "12 Oct": for lists; pair it with the exact time in a title. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(t)) return when(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  const d = new Date(t);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(d.getUTCFullYear() === new Date(now).getUTCFullYear() ? {} : { year: "numeric" }),
  });
}

export { html, raw };
