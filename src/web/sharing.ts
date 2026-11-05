// Shared projects in the browser: the share-link landing page (/share/:code, which signs in or
// signs up and then asks to confirm), and each project's Sharing page (members and links for its
// owner; your role and "Leave" for a member). Mounted inside createApp(), so the session, CSRF
// (Origin) and recovery-session middleware apply. Membership is checked on every request
// (getVault); owner-only actions check the role too, and anyone else gets what a missing project
// gets.

import type { Context, Hono } from "hono";
import {
  audit,
  canWriteVault,
  createShareLink,
  GUIDE_MAX_BYTES,
  GUIDE_TEMPLATES,
  getVault,
  isOwner,
  listMembers,
  listShareLinks,
  lookupShareLink,
  MEMBER_ROLES,
  type MemberRole,
  redeemShareLink,
  removeMember,
  revokeShareLink,
  SHARE_LIMITS,
  setMemberRole,
  setVaultGuide,
  shareLinkStatus,
  type User,
  type Vault,
} from "../directory";
import { publicOrigin } from "../env";
import { folderHref, type H, html, icon, layout, raw, when } from "./layout";
import { renderMarkdown } from "./render";
import type { AppEnv } from "./types";
import { copyLine, emptyState, pageHeader, panel, shellOpts } from "./ui";

type C = Context<AppEnv>;

const sharingHref = (vault: string) => `/app/v/${encodeURIComponent(vault)}/sharing`;
const roleWord = (r: string) => (r === "editor" ? "an editor (read and write)" : r === "reader" ? "a reader (read only)" : r);

export function registerSharing(app: Hono<AppEnv>) {
  const page = (c: C, title: string, body: H, extra: { vault?: string; auth?: boolean | string } = {}) => layout({ title, body, ...shellOpts(c), ...extra });
  const notFound = (c: C) => c.html(page(c, "Not found", html`<h1>Not found</h1>`), 404);
  const ip = (c: C) => c.req.header("cf-connecting-ip") ?? "unknown";

  /** Share-link guessing and redemption share one per-IP limiter (and per user once signed in). */
  async function linkLimited(c: C, user?: User): Promise<boolean> {
    if (!c.env.RL_INVITE) return false;
    if (!(await c.env.RL_INVITE.limit({ key: `share:${ip(c)}` })).success) return true;
    return !!user && !(await c.env.RL_INVITE.limit({ key: `share-user:${user.id}` })).success;
  }

  const deadLink = (c: C, status: 404 | 429 = 404) =>
    c.html(
      page(
        c,
        "Share link",
        html`<h1 class="text-center text-2xl">This link doesn’t work</h1>
        <p class="mt-2 text-center text-sm text-muted">${status === 429 ? "Too many tries. Wait a minute and open the link again." : "It has expired, been revoked or already been used. Ask the person who shared it for a new one."}</p>
        <p class="mt-6 text-center"><a class="btn btn-secondary" href="/app">Go to ${c.env.APP_NAME || "Cairn"}</a></p>`,
        { auth: "user" },
      ),
      status,
    );

  // ---------------------------------------------------------------- landing + confirm

  app.get("/share/:code", async (c) => {
    const user = c.get("user");
    if (await linkLimited(c, user)) return deadLink(c, 429);
    const code = c.req.param("code");
    const link = await lookupShareLink(c.env, code);
    if (!link) return deadLink(c);
    const here = `/share/${encodeURIComponent(code)}`;
    if (!user) {
      const next = encodeURIComponent(here);
      return c.html(
        page(
          c,
          "Join a project",
          html`<h1 class="text-center text-2xl">Join ${link.label}</h1>
          <p class="mt-2 text-center text-sm text-muted">You’ve been invited to ${link.label} as ${roleWord(link.role)}. Sign in, or create an account with a passkey, to join.</p>
          <div class="mt-6 space-y-3">
            <a class="btn btn-primary btn-lg w-full" href="/login?next=${next}">${icon("fingerprint")} Sign in to join</a>
            ${link.signupOpen ? html`<a class="btn btn-secondary btn-lg w-full" href="/signup?share=${encodeURIComponent(code)}&next=${next}">Create an account</a>` : ""}
          </div>`,
          { auth: "user" },
        ),
      );
    }
    const v = await getVault(c.env, user.id, link.label);
    const current = v?.role;
    const body =
      current === "owner"
        ? html`<p class="mt-2 text-center text-sm text-muted">You own ${link.label}: this is one of your share links.</p>
          <p class="mt-6 text-center"><a class="btn btn-primary" href="${folderHref(v?.name ?? link.label, "")}">Open the project</a></p>`
        : current === "editor" || (current === "reader" && link.role === "reader")
          ? html`<p class="mt-2 text-center text-sm text-muted">You’re already ${roleWord(current)} of ${link.label}. Nothing to change.</p>
            <p class="mt-6 text-center"><a class="btn btn-primary" href="${folderHref(link.label, "")}">Open the project</a></p>`
          : html`<p class="mt-2 text-center text-sm text-muted">${
              current === "reader"
                ? html`You’re a reader of <strong>${link.label}</strong> now. This link makes you <strong>an editor</strong>: you’ll be able to change its notes and files.`
                : html`Join <strong>${link.label}</strong> as ${roleWord(link.role)}? It will appear in your projects as <code>${link.label}</code>, and your assistants can use it with <code>project="${link.label}"</code>.`
            }</p>
            <form method="post" action="/share/accept" class="mt-6 flex flex-wrap justify-center gap-2">
              <input type="hidden" name="code" value="${code}">
              <button class="btn btn-primary" type="submit">${current === "reader" ? "Become an editor" : `Join as ${link.role}`}</button>
              <a class="btn btn-ghost" href="/app">Not now</a>
            </form>`;
    return c.html(page(c, "Join a project", html`<h1 class="text-center text-2xl">${link.label}</h1>${body}`, { auth: "user" }));
  });

  app.post("/share/accept", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    if (await linkLimited(c, user)) return deadLink(c, 429);
    const code = String((await c.req.formData()).get("code") ?? "");
    const r = await redeemShareLink(c.env, code, user.id);
    if (!r.ok) {
      if (r.reason === "invalid") return deadLink(c);
      const link = await lookupShareLink(c.env, code);
      if (r.reason === "full")
        return c.html(
          page(
            c,
            "Project full",
            html`<p class="callout warning">${link?.label ?? "This project"} already has ${SHARE_LIMITS.membersPerVault} members, the limit. Ask its owner to make room.</p>`,
          ),
          409,
        );
      return c.redirect(link ? folderHref(link.label, "") : "/app", 303);
    }
    await audit(c.env, user.id, "share.join", { vault: r.vaultId, role: r.role }, ip(c));
    return c.redirect(folderHref(r.label, ""), 303);
  });

  // ---------------------------------------------------------------- the project's Sharing page

  async function vaultOf(c: C, user: User): Promise<Vault | null> {
    return getVault(c.env, user.id, decodeURIComponent(c.req.param("vault") ?? ""));
  }

  /** The project's guide: an editor for the owner and editors, the text for readers. */
  const guidePanel = (v: Vault) =>
    panel(
      "Guide for assistants",
      html`What belongs in ${v.name}, what doesn’t, and its conventions (folders, tags, naming). Every member’s assistants see its first line in <code>projects</code>, all of it in <code>projects command=guide</code> and at the top of <code>build_context</code> and <code>recent_activity</code>, and a pointer to it with every write here.${
        v.guide_updated_at ? ` Updated ${when(v.guide_updated_at)}${v.guide_editor ? ` by ${v.guide_editor}` : ""}.` : ""
      }`,
      canWriteVault(v)
        ? html`<form method="post" action="${sharingHref(v.name)}/guide" class="m-0 space-y-3" id="guide">
            <label for="guide-text" class="sr-only">Guide</label>
            <textarea id="guide-text" name="guide" rows="8" maxlength="${GUIDE_MAX_BYTES}" placeholder="${GUIDE_TEMPLATES.team.text}">${v.guide ?? ""}</textarea>
            <p class="m-0 flex flex-wrap items-center gap-3"><button class="btn btn-secondary" type="submit">Save guide</button><span class="text-xs text-muted">Markdown, at most ${GUIDE_MAX_BYTES / 1024} KB. Empty removes it.</span></p></form>`
        : html`<div id="guide">${v.guide ? html`<div class="note-body prose">${raw(renderMarkdown(v.guide, { vault: v.name, links: {} }))}</div>` : html`<p class="m-0 text-sm text-muted">No guide yet.</p>`}</div>`,
    );

  async function sharingPage(c: C, user: User, v: Vault, opts: { created?: { url: string; role: string; expires: string }; msg?: string } = {}) {
    if (!isOwner(v)) {
      return c.html(
        page(
          c,
          `Sharing · ${v.name}`,
          html`${pageHeader(`Sharing ${v.name}`, html`${v.owner_username} shared this project with you. You are ${roleWord(v.role ?? "")}.`)}
          ${opts.msg ? html`<p class="callout tip">${opts.msg}</p>` : ""}
          ${guidePanel(v)}
          ${panel(
            "Leave this project",
            "You’ll lose access at once. The owner can share it with you again.",
            html`<form method="post" action="${sharingHref(v.name)}/leave" class="m-0"><button class="btn btn-danger" type="submit">Leave ${v.name}</button></form>`,
          )}`,
          { vault: v.name },
        ),
      );
    }
    const [members, links] = await Promise.all([listMembers(c.env, v.id), listShareLinks(c.env, v.id)]);
    const origin = publicOrigin(c.env);
    const roleSelect = (name: string, sel: string) =>
      html`<select name="${name}">${MEMBER_ROLES.map((r) => html`<option value="${r}" ${r === sel ? "selected" : ""}>${r}</option>`)}</select>`;
    return c.html(
      page(
        c,
        `Sharing · ${v.name}`,
        html`<div class="crumbs"><a href="${folderHref(v.name, "")}">${v.name}</a><span aria-hidden="true">/</span><span>sharing</span></div>
        ${pageHeader(
          `Share ${v.name}`,
          html`Members see it as <code>${user.username}/${v.name}</code>, in the app and for their assistants. Editors can change notes and files; readers only read. Storage counts against you.`,
        )}
        ${opts.msg ? html`<p class="callout tip">${opts.msg}</p>` : ""}
        ${
          opts.created
            ? html`<section class="card mb-6 border-l-4 border-l-ok"><p class="mt-0 text-sm font-semibold">New ${opts.created.role} link, valid until ${when(opts.created.expires)}. Copy it now: it isn’t shown again.</p>${copyLine("share-link", opts.created.url)}</section>`
            : ""
        }
        ${guidePanel(v)}
        ${panel(
          "Members",
          `${members.length} of at most ${SHARE_LIMITS.membersPerVault}. A change takes effect on their next request.`,
          members.length
            ? html`<ul class="-mx-5 -my-5 divide-y divide-line sm:-mx-6">${members.map(
                (m) => html`<li class="flex flex-wrap items-center gap-3 px-5 py-3 sm:px-6">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-info-soft text-info">${icon("user", "size-4")}</span>
                <div class="min-w-0 flex-1"><p class="m-0 truncate text-sm font-medium">${m.username}</p><p class="m-0 text-xs text-muted">${m.role} · joined ${when(m.added_at)}</p></div>
                <form method="post" action="${sharingHref(v.name)}/members" class="m-0 flex items-center gap-2"><input type="hidden" name="user" value="${m.user_id}">${roleSelect("role", m.role)}<button class="btn btn-secondary btn-sm" type="submit">Change</button></form>
                <form method="post" action="${sharingHref(v.name)}/members/remove" class="m-0"><input type="hidden" name="user" value="${m.user_id}"><button class="btn btn-ghost btn-sm text-danger" type="submit" aria-label="Remove ${m.username}">${icon("trash", "size-4")}<span class="max-sm:sr-only">Remove</span></button></form>
              </li>`,
              )}</ul>`
            : emptyState("user", "Only you", "Create a link below and send it to the people you want to share this project with."),
        )}
        ${panel(
          "Share links",
          html`Anyone with an open link can join as its role (and create an account with it, even when sign-up is by invitation; up to ${SHARE_LIMITS.signupsPerLink} accounts per link). Links last 1–${SHARE_LIMITS.maxDays} days.`,
          html`<form method="post" action="${sharingHref(v.name)}/links" class="grid gap-4 sm:grid-cols-[10rem_10rem_1fr_auto] sm:items-end">
            <div><label for="lrole">Role</label>${roleSelect("role", "reader")}</div>
            <div><label for="ldays">Expires in (days)</label><input id="ldays" name="days" type="text" inputmode="numeric" value="${SHARE_LIMITS.defaultDays}"></div>
            <label class="sm:self-center"><input type="checkbox" name="single" value="1"> single use</label>
            <button class="btn btn-primary" type="submit">Create link</button>
          </form>
          ${
            links.length
              ? html`<table class="mt-5"><thead><tr><th>Role</th><th>Status</th><th>Used</th><th>Created</th><th>Expires</th><th></th></tr></thead><tbody>${links.map(
                  (l) => {
                    const st = shareLinkStatus(l);
                    return html`<tr><td>${l.role}${l.single_use ? " · single use" : ""}</td><td>${st}</td><td class="tabular-nums">${l.uses}${l.signups ? ` (${l.signups} new)` : ""}</td><td class="small">${when(l.created_at)}</td><td class="small">${when(l.expires_at)}</td>
                    <td>${st === "open" ? html`<form method="post" action="${sharingHref(v.name)}/links/revoke" class="m-0"><input type="hidden" name="id" value="${l.id}"><button class="btn btn-ghost btn-sm text-danger" type="submit">Revoke</button></form>` : ""}</td></tr>`;
                  },
                )}</tbody></table>`
              : ""
          }
          <p class="mb-0 mt-4 text-xs text-muted">Links look like ${origin}/share/…; only a hash of each is stored.</p>`,
        )}`,
        { vault: v.name },
      ),
    );
  }

  app.get("/app/v/:vault/sharing", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`);
    const v = await vaultOf(c, user);
    if (!v) return notFound(c);
    return sharingPage(c, user, v, { msg: c.req.query("msg") });
  });

  /** An owner-only POST: the project if the caller owns it; a member gets 403, anyone else 404. */
  async function ownerPost(c: C): Promise<{ user: User; v: Vault; f: FormData } | Response> {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const v = await vaultOf(c, user);
    if (!v) return notFound(c);
    if (!isOwner(v)) return c.html(page(c, "Not allowed", html`<p class="error">Only the project’s owner can change who it’s shared with.</p>`), 403);
    return { user, v, f: await c.req.formData() };
  }
  const back = (c: C, v: Vault, msg: string) => c.redirect(`${sharingHref(v.name)}?msg=${encodeURIComponent(msg)}`, 303);

  app.post("/app/v/:vault/sharing/links", async (c) => {
    const o = await ownerPost(c);
    if (o instanceof Response) return o;
    if (c.env.RL_INVITE && !(await c.env.RL_INVITE.limit({ key: `invite:${o.user.id}` })).success)
      return c.html(page(c, "Slow down", html`<p class="error">Too many links at once. Wait a minute.</p>`), 429);
    const role = String(o.f.get("role") ?? "reader") as MemberRole;
    const r = await createShareLink(c.env, o.v, o.user.id, {
      role,
      days: Number(String(o.f.get("days") ?? "").trim() || SHARE_LIMITS.defaultDays),
      singleUse: o.f.get("single") === "1",
    });
    if (!r.ok) return back(c, o.v, r.message);
    await audit(c.env, o.user.id, "share.link", { vault: o.v.id, role }, ip(c));
    return sharingPage(c, o.user, o.v, { created: { url: `${publicOrigin(c.env)}/share/${r.code}`, role, expires: r.expires_at } });
  });

  app.post("/app/v/:vault/sharing/links/revoke", async (c) => {
    const o = await ownerPost(c);
    if (o instanceof Response) return o;
    const ok = await revokeShareLink(c.env, o.v.id, String(o.f.get("id") ?? ""));
    return back(c, o.v, ok ? "Link revoked." : "No such open link.");
  });

  app.post("/app/v/:vault/sharing/members", async (c) => {
    const o = await ownerPost(c);
    if (o instanceof Response) return o;
    const role = String(o.f.get("role") ?? "") as MemberRole;
    const ok = await setMemberRole(c.env, o.v.id, String(o.f.get("user") ?? ""), role);
    if (ok) await audit(c.env, o.user.id, "share.role", { vault: o.v.id, role }, ip(c));
    return back(c, o.v, ok ? `Role changed to ${role}.` : "No such member.");
  });

  app.post("/app/v/:vault/sharing/members/remove", async (c) => {
    const o = await ownerPost(c);
    if (o instanceof Response) return o;
    const ok = await removeMember(c.env, o.v.id, String(o.f.get("user") ?? ""));
    if (ok) await audit(c.env, o.user.id, "share.remove", { vault: o.v.id }, ip(c));
    return back(c, o.v, ok ? "Member removed." : "No such member.");
  });

  app.post("/app/v/:vault/sharing/guide", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const v = await vaultOf(c, user);
    if (!v) return notFound(c);
    if (!canWriteVault(v)) return c.html(page(c, "Not allowed", html`<p class="error">Only the project’s owner and editors can change its guide.</p>`), 403);
    const r = await setVaultGuide(c.env, v, user.id, String((await c.req.formData()).get("guide") ?? ""));
    return c.redirect(`${sharingHref(v.name)}?msg=${encodeURIComponent(r.ok ? "Guide saved." : r.message)}#guide`, 303);
  });

  app.post("/app/v/:vault/sharing/leave", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/login", 303);
    const v = await vaultOf(c, user);
    if (!v) return notFound(c);
    if (isOwner(v)) return back(c, v, "You own this project, so you can’t leave it.");
    await removeMember(c.env, v.id, user.id);
    await audit(c.env, user.id, "share.leave", { vault: v.id }, ip(c));
    return c.redirect("/app", 303);
  });
}
