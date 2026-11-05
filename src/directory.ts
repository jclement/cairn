// D1 directory: users, vaults, sessions, recovery codes, invites, PATs, audit log.
// Every vault lookup is scoped by owner: this is the single choke point for vault access.

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { LIMITS } from "./env";
import { slugify } from "./markdown/parse";
import type { VaultRef } from "./vault/do";
import { sha256Hex } from "./vault/embed";

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  is_admin: number;
  created_at: string;
  invited_by: string | null;
  disabled_at: string | null;
  /** Set while the account is being deleted (resumable). */
  deleting_at: string | null;
  /** Credentials (OAuth grants, PATs) issued at or before this instant are void. Set when disabled. */
  tokens_valid_after: string | null;
  last_active_at: string | null;
  bytes_used: number;
}

export interface Vault {
  id: string;
  owner_id: string;
  /**
   * From getVault/listVaults: the name the CALLER uses for the project (its label): the plain
   * name for its owner, "<owner>/<name>" for a member. From a raw `SELECT * FROM vaults`: the
   * plain name. Never use it as the Durable Object's name: vaultRef() takes `slug` for that.
   */
  name: string;
  is_default: number;
  bytes_used: number;
  note_count: number;
  created_at: string;
  /** Set by getVault/listVaults: the caller's role on this project. */
  role?: Role;
  /** Set by getVault/listVaults: the plain name in the owner's namespace. */
  slug?: string;
  /** Set by getVault/listVaults: the owner's username. */
  owner_username?: string;
  /** Set by getVault/listVaults: who is acting (charged for AI and search limits). */
  actor_id?: string;
  /** The project's guide for assistants (markdown, <= GUIDE_MAX_BYTES), and who last changed it. */
  guide?: string | null;
  guide_updated_by?: string | null;
  guide_updated_at?: string | null;
  /** Set by getVault/listVaults: the username of who last changed the guide. */
  guide_editor?: string | null;
}

/** A project's member roles. The owner is vaults.owner_id; editors write; readers only read. */
export type Role = "owner" | "editor" | "reader";
export type MemberRole = Exclude<Role, "owner">;
export const MEMBER_ROLES: readonly MemberRole[] = ["editor", "reader"];
const RANK: Record<Role, number> = { reader: 1, editor: 2, owner: 3 };

/** True if `v` (from getVault/listVaults) lets its caller change notes and files. */
export function canWriteVault(v: Vault): boolean {
  return v.role === "owner" || v.role === "editor";
}
export function isOwner(v: Vault): boolean {
  return v.role === "owner";
}
export function roleAtLeast(role: Role | undefined, min: Role): boolean {
  return !!role && RANK[role] >= RANK[min];
}

export const now = () => new Date().toISOString();

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{1,31}$/;

export function normaliseUsername(u: string): string {
  return u.trim().toLowerCase();
}

export async function getUser(env: Env, id: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

export async function getUserByName(env: Env, username: string): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(normaliseUsername(username)).first<User>();
}

export type CreateUserResult = { ok: true; user: User } | { ok: false; reason: "taken" | "invite" };

/**
 * Create a user and their default vault in one D1 transaction. With `inviteCode`, the invite is
 * claimed in the same transaction and the user row is only inserted if this call won the claim,
 * so a single-use invite can never admit two accounts.
 */
export async function createUser(
  env: Env,
  username: string,
  isAdmin: boolean,
  opts: { inviteCode?: string; shareCode?: string } = {},
): Promise<CreateUserResult> {
  const id = newId();
  const ts = now();
  const vaultId = newId();
  const name = normaliseUsername(username);
  const stmts: D1PreparedStatement[] = [];
  let inviteHash: string | null = null;
  if (opts.inviteCode) {
    inviteHash = await sha256Hex(`invite:${opts.inviteCode}`);
    stmts.push(
      env.DB.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(
        id,
        ts,
        inviteHash,
        ts,
      ),
      env.DB.prepare(
        `INSERT INTO users (id, username, is_admin, created_at, invited_by)
         SELECT ?, ?, ?, ?, created_by FROM invites WHERE code_hash = ? AND used_by = ?`,
      ).bind(id, name, isAdmin ? 1 : 0, ts, inviteHash, id),
    );
  } else if (opts.shareCode) {
    // A share link acts as an invite: the link's sign-up slot (at most SHARE_LIMITS.signupsPerLink
    // accounts per link), the account and its membership are one transaction.
    const shareH = await sha256Hex(`share:${opts.shareCode}`);
    stmts.push(
      env.DB.prepare(
        `UPDATE share_links SET uses = uses + 1, signups = signups + 1, last_token = ?1
         WHERE code_hash = ?2 AND revoked_at IS NULL AND expires_at > ?3 AND (single_use = 0 OR uses = 0) AND signups < ?4
           AND (SELECT COUNT(*) FROM vault_members WHERE vault_id = share_links.vault_id) < ?5
           AND EXISTS (SELECT 1 FROM vaults v JOIN users u ON u.id = v.owner_id
                       WHERE v.id = share_links.vault_id AND u.disabled_at IS NULL AND u.deleting_at IS NULL)`,
      ).bind(id, shareH, ts, SHARE_LIMITS.signupsPerLink, SHARE_LIMITS.membersPerVault),
      env.DB.prepare(
        `INSERT INTO users (id, username, is_admin, created_at, invited_by)
         SELECT ?, ?, ?, ?, created_by FROM share_links WHERE code_hash = ? AND last_token = ?`,
      ).bind(id, name, isAdmin ? 1 : 0, ts, shareH, id),
      env.DB.prepare(
        `INSERT INTO vault_members (vault_id, user_id, role, added_by, added_at)
         SELECT vault_id, ?1, role, created_by, ?2 FROM share_links WHERE code_hash = ?3 AND last_token = ?1`,
      ).bind(id, ts, shareH),
    );
  } else {
    stmts.push(env.DB.prepare("INSERT INTO users (id, username, is_admin, created_at) VALUES (?, ?, ?, ?)").bind(id, name, isAdmin ? 1 : 0, ts));
  }
  stmts.push(
    env.DB.prepare(
      "INSERT INTO vaults (id, owner_id, name, is_default, created_at) SELECT ?, ?, 'main', 1, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)",
    ).bind(vaultId, id, ts, id),
  );
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) return { ok: false, reason: "taken" };
    throw e;
  }
  const user = await getUser(env, id);
  return user ? { ok: true, user } : { ok: false, reason: "invite" };
}

// ---------- vaults ----------

/** Columns every access query selects: the vault row, its owner's username and the caller's role. */
const ACCESS_COLUMNS = `v.*, u.username AS owner_username,
  (SELECT username FROM users WHERE id = v.guide_updated_by) AS guide_editor,
  CASE WHEN v.owner_id = ?1 THEN 'owner' ELSE m.role END AS role`;
const ACCESS_FROM = `FROM vaults v JOIN users u ON u.id = v.owner_id
  LEFT JOIN vault_members m ON m.vault_id = v.id AND m.user_id = ?1`;
/** A member sees a project only while its owner's account is live (not disabled, not being deleted). */
const ACCESS_WHERE = `(v.owner_id = ?1 OR (m.user_id IS NOT NULL AND u.disabled_at IS NULL AND u.deleting_at IS NULL))`;

function labelled(userId: string, row: Vault & { owner_username: string; role: Role }): Vault {
  const slug = row.name;
  return {
    ...row,
    slug,
    actor_id: userId,
    // Members address a shared project as owner/name, so it never collides with their own.
    name: row.owner_id === userId ? slug : `${row.owner_username}/${slug}`,
    // A shared project is never the member's default.
    is_default: row.owner_id === userId ? row.is_default : 0,
  };
}

/** Every project the user can open: their own (default first), then those shared with them. */
export async function listVaults(env: Env, userId: string): Promise<Vault[]> {
  const r = await env.DB.prepare(
    `SELECT ${ACCESS_COLUMNS} ${ACCESS_FROM} WHERE ${ACCESS_WHERE}
     ORDER BY (v.owner_id = ?1) DESC, v.is_default DESC, u.username, v.name`,
  )
    .bind(userId)
    .all<Vault & { owner_username: string; role: Role }>();
  return r.results.map((row) => labelled(userId, row));
}

/** Only the projects the user owns (account deletion, "download everything", counts). */
export async function listOwnedVaults(env: Env, userId: string): Promise<Vault[]> {
  const r = await env.DB.prepare("SELECT * FROM vaults WHERE owner_id = ? ORDER BY is_default DESC, name").bind(userId).all<Vault>();
  return r.results;
}

/**
 * The access check, and the only way a user-facing path gets a vault. `name` omitted = the user's
 * default project. A plain name is one of the user's own projects; "owner/name" is a project of
 * that owner the user owns or is a member of. Anything else is null, exactly as a project that
 * doesn't exist (no existence leak). Membership is read on every call: never cached.
 */
export async function getVault(env: Env, userId: string, name?: string | null): Promise<Vault | null> {
  let row: (Vault & { owner_username: string; role: Role }) | null;
  if (!name) {
    row = await env.DB.prepare(`SELECT ${ACCESS_COLUMNS} ${ACCESS_FROM} WHERE v.owner_id = ?1 AND v.is_default = 1`)
      .bind(userId)
      .first<Vault & { owner_username: string; role: Role }>();
  } else {
    const raw = name.trim();
    const slash = raw.indexOf("/");
    if (slash < 0) {
      row = await env.DB.prepare(`SELECT ${ACCESS_COLUMNS} ${ACCESS_FROM} WHERE v.owner_id = ?1 AND v.name = ?2`)
        .bind(userId, slugify(raw) || raw)
        .first<Vault & { owner_username: string; role: Role }>();
    } else {
      const owner = normaliseUsername(raw.slice(0, slash));
      const vname = raw.slice(slash + 1);
      if (!owner || !vname || vname.includes("/")) return null;
      row = await env.DB.prepare(`SELECT ${ACCESS_COLUMNS} ${ACCESS_FROM} WHERE u.username = ?2 AND v.name = ?3 AND ${ACCESS_WHERE}`)
        .bind(userId, owner, slugify(vname) || vname)
        .first<Vault & { owner_username: string; role: Role }>();
    }
  }
  return row?.role ? labelled(userId, row) : null;
}

export async function createVault(env: Env, userId: string, name: string): Promise<{ ok: true; vault: Vault } | { ok: false; message: string }> {
  const slug = slugify(name);
  if (!slug || slug.length > 48) return { ok: false, message: "Project names are 1-48 letters, digits or dashes." };
  // Admission and insert in one statement, so concurrent creations can't each see room under the
  // cap; a disabled or deleting account can't create projects; the (owner, name) unique index
  // decides duplicates.
  const res = await env.DB.prepare(
    `INSERT INTO vaults (id, owner_id, name, is_default, created_at)
     SELECT ?1, ?2, ?3, 0, ?4
     WHERE (SELECT COUNT(*) FROM vaults WHERE owner_id = ?2) < ?5
       AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND disabled_at IS NULL AND deleting_at IS NULL)
     ON CONFLICT DO NOTHING`,
  )
    .bind(newId(), userId, slug, now(), LIMITS.vaultsPerUser)
    .run();
  if (!res.meta.changes) {
    if (await getVault(env, userId, slug)) return { ok: false, message: `Project ${slug} already exists.` };
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults WHERE owner_id = ?").bind(userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.vaultsPerUser) return { ok: false, message: `You already have ${LIMITS.vaultsPerUser} projects, the limit.` };
    return { ok: false, message: "This account can't create projects." };
  }
  return { ok: true, vault: (await getVault(env, userId, slug)) as Vault };
}

export function vaultStub(env: Env, vault: Vault) {
  return env.VAULT.getByName(vault.id);
}

export function vaultRef(vault: Vault): VaultRef {
  // The Durable Object knows a project by its owner's plain name, whoever is asking.
  return { id: vault.id, name: vault.slug ?? vault.name, ownerId: vault.owner_id, ...(vault.actor_id ? { actorId: vault.actor_id } : {}) };
}

/** Bytes charged to a user: live notes plus retained revisions, across all their vaults. */
export async function userBytes(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT bytes_used FROM users WHERE id = ?").bind(userId).first<{ bytes_used: number }>();
  return r?.bytes_used ?? 0;
}

// ---------- sharing: members and share links ----------

/** Most members per project, and most open share links per project. */
export const SHARE_LIMITS = { membersPerVault: 50, openLinksPerVault: 20, signupsPerLink: 10, maxDays: 30, defaultDays: 7 };

export interface MemberRow {
  user_id: string;
  username: string;
  role: MemberRole;
  added_at: string;
  added_by_username: string | null;
}

export async function listMembers(env: Env, vaultId: string): Promise<MemberRow[]> {
  const r = await env.DB.prepare(
    `SELECT m.user_id, u.username, m.role, m.added_at, a.username AS added_by_username
     FROM vault_members m JOIN users u ON u.id = m.user_id LEFT JOIN users a ON a.id = m.added_by
     WHERE m.vault_id = ? ORDER BY u.username`,
  )
    .bind(vaultId)
    .all<MemberRow>();
  return r.results;
}

/** Change a member's role (owner action). False if they aren't a member. */
export async function setMemberRole(env: Env, vaultId: string, userId: string, role: MemberRole): Promise<boolean> {
  if (!MEMBER_ROLES.includes(role)) return false;
  const r = await env.DB.prepare("UPDATE vault_members SET role = ? WHERE vault_id = ? AND user_id = ?").bind(role, vaultId, userId).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Remove a member (owner action, or the member leaving). Takes effect on their next request. */
export async function removeMember(env: Env, vaultId: string, userId: string): Promise<boolean> {
  const r = await env.DB.prepare("DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?").bind(vaultId, userId).run();
  return (r.meta.changes ?? 0) > 0;
}

export interface ShareLinkRow {
  id: string;
  role: MemberRole;
  created_at: string;
  expires_at: string;
  single_use: number;
  uses: number;
  signups: number;
  revoked_at: string | null;
}

export function shareLinkStatus(l: Pick<ShareLinkRow, "revoked_at" | "expires_at" | "single_use" | "uses">): "open" | "revoked" | "expired" | "used" {
  if (l.revoked_at) return "revoked";
  if (Date.parse(l.expires_at) <= Date.now()) return "expired";
  if (l.single_use && l.uses > 0) return "used";
  return "open";
}

const shareHash = (code: string) => sha256Hex(`share:${code}`);

/**
 * Create a share link for a project the caller owns. Only the hash of the code is stored: the
 * returned code is shown once. At most SHARE_LIMITS.openLinksPerVault open links per project.
 */
export async function createShareLink(
  env: Env,
  vault: Vault,
  creatorId: string,
  opts: { role: MemberRole; days?: number; singleUse?: boolean },
): Promise<{ ok: true; code: string; id: string; expires_at: string } | { ok: false; message: string }> {
  if (vault.owner_id !== creatorId) return { ok: false, message: "Only the project's owner can share it." };
  if (!MEMBER_ROLES.includes(opts.role)) return { ok: false, message: "A link gives editor or reader access." };
  const days = Math.min(Math.max(Math.round(Number.isFinite(opts.days) ? (opts.days as number) : SHARE_LIMITS.defaultDays), 1), SHARE_LIMITS.maxDays);
  const code = randomToken(18);
  const id = newId();
  const ts = now();
  const expires = new Date(Date.now() + days * 86400e3).toISOString();
  const r = await env.DB.prepare(
    `INSERT INTO share_links (id, vault_id, code_hash, role, created_by, created_at, expires_at, single_use)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
     WHERE (SELECT COUNT(*) FROM share_links WHERE vault_id = ?2 AND revoked_at IS NULL AND expires_at > ?6 AND (single_use = 0 OR uses = 0)) < ?9
       AND EXISTS (SELECT 1 FROM vaults WHERE id = ?2 AND owner_id = ?5)`,
  )
    .bind(id, vault.id, await shareHash(code), opts.role, creatorId, ts, expires, opts.singleUse ? 1 : 0, SHARE_LIMITS.openLinksPerVault)
    .run();
  if (!(r.meta.changes ?? 0)) return { ok: false, message: `This project already has ${SHARE_LIMITS.openLinksPerVault} open links. Revoke one first.` };
  // Keep the newest 50 closed links per project for the list; older ones are only noise.
  await env.DB.prepare(
    `DELETE FROM share_links WHERE vault_id = ?1 AND id NOT IN (SELECT id FROM share_links WHERE vault_id = ?1 ORDER BY created_at DESC LIMIT 70)
       AND NOT (revoked_at IS NULL AND expires_at > ?2 AND (single_use = 0 OR uses = 0))`,
  )
    .bind(vault.id, ts)
    .run();
  return { ok: true, code, id, expires_at: expires };
}

export async function listShareLinks(env: Env, vaultId: string): Promise<ShareLinkRow[]> {
  const r = await env.DB.prepare(
    "SELECT id, role, created_at, expires_at, single_use, uses, signups, revoked_at FROM share_links WHERE vault_id = ? ORDER BY created_at DESC LIMIT 70",
  )
    .bind(vaultId)
    .all<ShareLinkRow>();
  return r.results;
}

export async function revokeShareLink(env: Env, vaultId: string, id: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE share_links SET revoked_at = ? WHERE id = ? AND vault_id = ? AND revoked_at IS NULL").bind(now(), id, vaultId).run();
  return (r.meta.changes ?? 0) > 0;
}

export interface ShareInvite {
  linkId: string;
  vaultId: string;
  ownerId: string;
  /** owner/name: how a member addresses the project. */
  label: string;
  role: MemberRole;
  /** New accounts may still be created through this link. */
  signupOpen: boolean;
}

/**
 * A live share link by its code: not revoked, not expired, not a used single-use link, and its
 * project's owner still active. Everything else is null, all alike.
 */
export async function lookupShareLink(env: Env, code: string | undefined | null): Promise<ShareInvite | null> {
  if (!code || code.length > 64) return null;
  const r = await env.DB.prepare(
    `SELECT l.id, l.vault_id, l.role, l.signups, v.owner_id, v.name, u.username
     FROM share_links l JOIN vaults v ON v.id = l.vault_id JOIN users u ON u.id = v.owner_id
     WHERE l.code_hash = ?1 AND l.revoked_at IS NULL AND l.expires_at > ?2 AND (l.single_use = 0 OR l.uses = 0)
       AND u.disabled_at IS NULL AND u.deleting_at IS NULL`,
  )
    .bind(await shareHash(code), now())
    .first<{ id: string; vault_id: string; role: MemberRole; signups: number; owner_id: string; name: string; username: string }>();
  if (!r) return null;
  return {
    linkId: r.id,
    vaultId: r.vault_id,
    ownerId: r.owner_id,
    label: `${r.username}/${r.name}`,
    role: r.role,
    signupOpen: r.signups < SHARE_LIMITS.signupsPerLink,
  };
}

export type RedeemResult = { ok: true; role: MemberRole; vaultId: string; label: string } | { ok: false; reason: "invalid" | "owner" | "full" | "lower" };

/**
 * Join a project through a share link (or raise one's role to the link's). One D1 transaction:
 * the link's use is counted only if it was still live (single use: once), and the membership is
 * written only if that use was this call's. A link never lowers an existing role ("lower").
 */
export async function redeemShareLink(env: Env, code: string, userId: string): Promise<RedeemResult> {
  const link = await lookupShareLink(env, code);
  if (!link) return { ok: false, reason: "invalid" };
  if (link.ownerId === userId) return { ok: false, reason: "owner" };
  const current = await env.DB.prepare("SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?")
    .bind(link.vaultId, userId)
    .first<{ role: MemberRole }>();
  if (current && RANK[current.role] >= RANK[link.role]) return { ok: false, reason: "lower" };
  const token = crypto.randomUUID();
  const ts = now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE share_links SET uses = uses + 1, last_token = ?1
       WHERE id = ?2 AND revoked_at IS NULL AND expires_at > ?3 AND (single_use = 0 OR uses = 0)
         AND (EXISTS (SELECT 1 FROM vault_members WHERE vault_id = ?4 AND user_id = ?5)
              OR (SELECT COUNT(*) FROM vault_members WHERE vault_id = ?4) < ?6)`,
    ).bind(token, link.linkId, ts, link.vaultId, userId, SHARE_LIMITS.membersPerVault),
    env.DB.prepare(
      `INSERT INTO vault_members (vault_id, user_id, role, added_by, added_at)
       SELECT vault_id, ?1, role, created_by, ?2 FROM share_links WHERE id = ?3 AND last_token = ?4
       ON CONFLICT (vault_id, user_id) DO UPDATE SET role = CASE WHEN excluded.role = 'editor' THEN 'editor' ELSE vault_members.role END`,
    ).bind(userId, ts, link.linkId, token),
    env.DB.prepare("SELECT last_token FROM share_links WHERE id = ?").bind(link.linkId),
  ]);
  if ((res[2].results as { last_token: string | null }[])[0]?.last_token !== token) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM vault_members WHERE vault_id = ?").bind(link.vaultId).first<{ n: number }>();
    return { ok: false, reason: (count?.n ?? 0) >= SHARE_LIMITS.membersPerVault ? "full" : "invalid" };
  }
  return { ok: true, role: link.role, vaultId: link.vaultId, label: link.label };
}

// ---------- guidance: project guides and personal guidance ----------

/** Most bytes in a project's guide or a user's personal guidance. */
export const GUIDE_MAX_BYTES = 4096;

const guideBytes = (t: string) => new TextEncoder().encode(t).length;

/** Starter guides offered when a project is created. */
export const GUIDE_TEMPLATES: Record<string, { label: string; text: string }> = {
  blank: { label: "No guide", text: "" },
  personal: {
    label: "Personal",
    text: `Personal notes: people, places, plans, health, home and family.

- Belongs here: anything about my own life.
- Not here: work, customers or colleagues' information.
- Folders: people/, places/, plans/, journal/. One note per person or place.
- Tags: lower-case, singular (#trip, #health).`,
  },
  team: {
    label: "Team / work",
    text: `Shared work notes for the team.

- Belongs here: customers, projects, decisions, meetings, how-tos for this team's work.
- Not here: anything personal, credentials or secrets of any kind.
- Folders: customers/, projects/, decisions/, meetings/YYYY/. Title meetings "YYYY-MM-DD Topic".
- Record decisions as \`- [decision] …\` observations with the reason, and link the people involved.`,
  },
};

/** The first meaningful line of a guide (for listings), at most 140 characters. */
export function guideSummary(guide: string | null | undefined): string | null {
  const line = (guide ?? "")
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** Set a project's guide. Owner or editor only; empty clears it. */
export async function setVaultGuide(env: Env, vault: Vault, userId: string, text: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!canWriteVault(vault)) return { ok: false, message: "Only the project's owner and editors can change its guide." };
  const t = text.replace(/\r\n/g, "\n").trim();
  if (guideBytes(t) > GUIDE_MAX_BYTES) return { ok: false, message: `A guide is at most ${GUIDE_MAX_BYTES / 1024} KB.` };
  await env.DB.prepare("UPDATE vaults SET guide = ?, guide_updated_by = ?, guide_updated_at = ? WHERE id = ?")
    .bind(t || null, userId, now(), vault.id)
    .run();
  return { ok: true };
}

/** A user's private guidance (cross-project routing rules). Only ever read for that user. */
export async function getGuidance(env: Env, userId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT guidance FROM users WHERE id = ?").bind(userId).first<{ guidance: string | null }>();
  return r?.guidance || null;
}

export async function setGuidance(env: Env, userId: string, text: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (guideBytes(t) > GUIDE_MAX_BYTES) return { ok: false, message: `Personal guidance is at most ${GUIDE_MAX_BYTES / 1024} KB.` };
  await env.DB.prepare("UPDATE users SET guidance = ? WHERE id = ?")
    .bind(t || null, userId)
    .run();
  return { ok: true };
}

// ---------- sessions ----------

export const SESSION_COOKIE = "__Host-cairn_session";
const SESSION_IDLE_MS = 30 * 86400e3;
const SESSION_ABSOLUTE_MS = 90 * 86400e3;
const RECOVERY_SESSION_MS = 3600e3;

export interface Session {
  id_hash: string;
  user_id: string;
  restricted: number;
  /** Last fresh passkey assertion on this session (re-authentication for sensitive actions). */
  reauth_at: string | null;
  expires_at: string;
  absolute_expires_at: string;
}

export async function createSession(env: Env, userId: string, opts: { restricted?: boolean; userAgent?: string } = {}): Promise<string> {
  const token = randomToken();
  const t = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, user_id, restricted, created_at, expires_at, absolute_expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      await sha256Hex(token),
      userId,
      opts.restricted ? 1 : 0,
      new Date(t).toISOString(),
      new Date(t + (opts.restricted ? RECOVERY_SESSION_MS : SESSION_IDLE_MS)).toISOString(),
      new Date(t + (opts.restricted ? RECOVERY_SESSION_MS : SESSION_ABSOLUTE_MS)).toISOString(),
      (opts.userAgent ?? "").slice(0, 200),
    )
    .run();
  return token;
}

/** Look a session up by cookie value; slides the idle expiry (at most once an hour). */
export async function loadSession(env: Env, token: string | undefined | null): Promise<{ session: Session; user: User } | null> {
  if (!token) return null;
  const hash = await sha256Hex(token);
  const session = await env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(hash).first<Session>();
  if (!session) return null;
  const t = Date.now();
  if (Date.parse(session.expires_at) < t || Date.parse(session.absolute_expires_at) < t) {
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(hash).run();
    return null;
  }
  const user = await getUser(env, session.user_id);
  if (!user || user.disabled_at) return null;
  await touchUser(env, user);
  if (Date.parse(session.expires_at) - t < SESSION_IDLE_MS - 3600e3) {
    const next = new Date(Math.min(t + SESSION_IDLE_MS, Date.parse(session.absolute_expires_at))).toISOString();
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").bind(next, hash).run();
  }
  return { session, user };
}

export async function deleteSession(env: Env, token: string) {
  await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?")
    .bind(await sha256Hex(token))
    .run();
}

export async function deleteOtherSessions(env: Env, userId: string, keepToken: string) {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?")
    .bind(userId, await sha256Hex(keepToken))
    .run();
}

export function sessionCookie(token: string, maxAgeSeconds = 30 * 86400): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------- recovery codes ----------

function recoveryCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(10));
  const s = [...b].map((x) => alphabet[x % alphabet.length]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export async function issueRecoveryCodes(env: Env, userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, recoveryCode);
  const hashes = await Promise.all(codes.map((c) => sha256Hex(`recovery:${c}`)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
    ...hashes.map((h) => env.DB.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)").bind(userId, h)),
  ]);
  return codes;
}

export async function consumeRecoveryCode(env: Env, userId: string, code: string): Promise<boolean> {
  const hash = await sha256Hex(`recovery:${code.trim().toLowerCase()}`);
  const r = await env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
    .bind(now(), userId, hash)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function remainingRecoveryCodes(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------- invites ----------

export function inviteQuota(env: Env): number {
  const n = Number(env.INVITES_PER_USER ?? "5");
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

/** Any user may invite: at most INVITES_PER_USER outstanding (unused, unrevoked, unexpired); admins unlimited. */
/** Inactive (revoked or expired, never used) invites kept per user for the history view. */
export const INVITE_HISTORY_KEEP = 20;

/**
 * Any user may invite: at most INVITES_PER_USER outstanding (unused, unrevoked, unexpired);
 * admins unlimited. The quota is enforced by the INSERT itself, so parallel requests can't exceed it.
 */
export async function createInvite(
  env: Env,
  user: Pick<User, "id" | "is_admin">,
  opts: { note?: string; days?: number } = {},
): Promise<{ ok: true; code: string; id: string } | { ok: false; message: string }> {
  const ts = now();
  const quota = inviteQuota(env);
  const days = Math.min(Math.max(Math.round(opts.days ?? 14), 1), 90);
  const code = randomToken(18);
  const id = newId();
  const r = await env.DB.prepare(
    `INSERT INTO invites (id, code_hash, code, note, created_by, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE ?8 = 1 OR (SELECT COUNT(*) FROM invites WHERE created_by = ?5 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?6) < ?9`,
  )
    .bind(
      id,
      await sha256Hex(`invite:${code}`),
      code,
      (opts.note ?? "").trim().slice(0, 80) || null,
      user.id,
      ts,
      new Date(Date.now() + days * 86400e3).toISOString(),
      user.is_admin ? 1 : 0,
      quota,
    )
    .run();
  if (!(r.meta.changes ?? 0)) return { ok: false, message: `You already have ${quota} unused invites. Revoke one or wait for it to be used.` };
  await pruneInviteHistory(env, user.id);
  return { ok: true, code, id };
}

/** Keep only the newest INVITE_HISTORY_KEEP inactive invites per user (used ones stay: they record who joined). */
export async function pruneInviteHistory(env: Env, userId: string) {
  const ts = now();
  await env.DB.prepare(
    `DELETE FROM invites WHERE created_by = ?1 AND used_at IS NULL AND (revoked_at IS NOT NULL OR expires_at <= ?2)
       AND id NOT IN (SELECT id FROM invites WHERE created_by = ?1 AND used_at IS NULL AND (revoked_at IS NOT NULL OR expires_at <= ?2)
                      ORDER BY created_at DESC LIMIT ?3)`,
  )
    .bind(userId, ts, INVITE_HISTORY_KEEP)
    .run();
}

export interface InviteRow {
  id: string;
  code: string | null;
  note: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  joined_username: string | null;
}

export async function listInvites(env: Env, userId: string): Promise<InviteRow[]> {
  const r = await env.DB.prepare(
    `SELECT i.id, i.code, i.note, i.created_at, i.expires_at, i.used_at, i.revoked_at, u.username AS joined_username
     FROM invites i LEFT JOIN users u ON u.id = i.used_by WHERE i.created_by = ? ORDER BY i.created_at DESC LIMIT 200`,
  )
    .bind(userId)
    .all<InviteRow>();
  return r.results;
}

export function inviteStatus(i: InviteRow): "joined" | "revoked" | "expired" | "open" {
  if (i.used_at) return "joined";
  if (i.revoked_at) return "revoked";
  if (Date.parse(i.expires_at) <= Date.now()) return "expired";
  return "open";
}

export async function revokeInvite(env: Env, userId: string, id: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE invites SET revoked_at = ?, code = NULL WHERE id = ? AND created_by = ? AND used_at IS NULL AND revoked_at IS NULL")
    .bind(now(), id, userId)
    .run();
  await pruneInviteHistory(env, userId);
  return (r.meta.changes ?? 0) > 0;
}

export async function inviteValid(env: Env, code: string | undefined | null): Promise<boolean> {
  if (!code) return false;
  const r = await env.DB.prepare("SELECT expires_at, used_at, revoked_at FROM invites WHERE code_hash = ?")
    .bind(await sha256Hex(`invite:${code}`))
    .first<{ expires_at: string; used_at: string | null; revoked_at: string | null }>();
  return !!r && !r.used_at && !r.revoked_at && Date.parse(r.expires_at) > Date.now();
}

/** Who invited the holder of this code (for the sign-up page). */
export async function inviterName(env: Env, code: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT u.username FROM invites i JOIN users u ON u.id = i.created_by WHERE i.code_hash = ?")
    .bind(await sha256Hex(`invite:${code}`))
    .first<{ username: string }>();
  return r?.username ?? null;
}

// ---------- activity and account admin ----------

/** Record activity at most once an hour per user. */
export async function touchUser(env: Env, user: Pick<User, "id" | "last_active_at">) {
  if (user.last_active_at && Date.now() - Date.parse(user.last_active_at) < 3600e3) return;
  await env.DB.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").bind(now(), user.id).run();
}

export interface AdminUserRow {
  id: string;
  username: string;
  is_admin: number;
  created_at: string;
  last_active_at: string | null;
  disabled_at: string | null;
  bytes_used: number;
  invited_by_username: string | null;
  notes: number;
  vaults: number;
}

/** Counts only: never note content. */
export async function listUsersForAdmin(env: Env): Promise<AdminUserRow[]> {
  const r = await env.DB.prepare(
    `SELECT u.id, u.username, u.is_admin, u.created_at, u.last_active_at, u.disabled_at, u.bytes_used,
            inv.username AS invited_by_username,
            COALESCE((SELECT SUM(note_count) FROM vaults v WHERE v.owner_id = u.id), 0) AS notes,
            (SELECT COUNT(*) FROM vaults v WHERE v.owner_id = u.id) AS vaults
     FROM users u LEFT JOIN users inv ON inv.id = u.invited_by ORDER BY u.created_at DESC LIMIT 500`,
  ).all<AdminUserRow>();
  return r.results;
}

/**
 * Disable: refuse sign-in, end sessions, delete PATs, and set a token cutoff so no credential issued
 * before now works again even after re-enabling. OAuth grants are revoked by the caller (needs OAuthHelpers).
 */
export async function setUserDisabled(env: Env, userId: string, disabled: boolean) {
  if (disabled) {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET disabled_at = ?1, tokens_valid_after = ?1 WHERE id = ?2").bind(now(), userId),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM pats WHERE user_id = ?").bind(userId),
    ]);
  } else {
    await env.DB.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").bind(userId).run();
  }
}

// ---------- personal access tokens ----------

export const PAT_PREFIX = "cairn_pat_";

export async function createPat(env: Env, userId: string, name: string, scope: string[], days: number | null): Promise<string> {
  const token = `${PAT_PREFIX}${randomToken(24)}`;
  await env.DB.prepare("INSERT INTO pats (id, user_id, token_hash, name, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(
      newId(),
      userId,
      await sha256Hex(token),
      name.slice(0, 64) || "token",
      scope.join(" "),
      now(),
      days ? new Date(Date.now() + days * 86400e3).toISOString() : null,
    )
    .run();
  return token;
}

export async function resolvePat(env: Env, token: string): Promise<{ user: User; name: string; scope: string[]; issuedAt: number } | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const pat = await env.DB.prepare("SELECT * FROM pats WHERE token_hash = ?")
    .bind(hash)
    .first<{ id: string; user_id: string; name: string; scope: string; created_at: string; expires_at: string | null; last_used_at: string | null }>();
  if (!pat || (pat.expires_at && Date.parse(pat.expires_at) < Date.now())) return null;
  const user = await getUser(env, pat.user_id);
  if (!user || user.disabled_at) return null;
  if (user.tokens_valid_after && Date.parse(pat.created_at) <= Date.parse(user.tokens_valid_after)) return null;
  if (!pat.last_used_at || Date.now() - Date.parse(pat.last_used_at) > 3600e3) {
    await env.DB.prepare("UPDATE pats SET last_used_at = ? WHERE id = ?").bind(now(), pat.id).run();
  }
  return { user, name: pat.name, scope: pat.scope.split(" ").filter(Boolean), issuedAt: Date.parse(pat.created_at) };
}

export async function listPats(env: Env, userId: string) {
  const r = await env.DB.prepare("SELECT id, name, scope, created_at, expires_at, last_used_at FROM pats WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<{ id: string; name: string; scope: string; created_at: string; expires_at: string | null; last_used_at: string | null }>();
  return r.results;
}

export async function deletePat(env: Env, userId: string, id: string) {
  await env.DB.prepare("DELETE FROM pats WHERE id = ? AND user_id = ?").bind(id, userId).run();
}

// ---------- audit ----------

export async function audit(env: Env, userId: string | null, action: string, detail?: unknown, ip?: string | null) {
  await env.DB.prepare("INSERT INTO audit_log (user_id, action, detail, ip, at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, action, detail === undefined ? null : JSON.stringify(detail), ip ?? null, now())
    .run();
}

/** Constant-time string compare for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

/** Revoke every OAuth grant a user holds, across all pages. Throws if a page or revocation fails (caller retries). */
export async function revokeAllGrants(oauth: Pick<OAuthHelpers, "listUserGrants" | "revokeGrant">, userId: string): Promise<number> {
  let revoked = 0;
  let cursor: string | undefined;
  for (let pages = 0; pages < 1000; pages++) {
    const page = await oauth.listUserGrants(userId, { limit: 100, ...(cursor ? { cursor } : {}) });
    for (const g of page.items) {
      await oauth.revokeGrant(g.id, userId);
      revoked++;
    }
    if (!page.cursor) return revoked;
    cursor = page.cursor;
  }
  throw new Error("too many grant pages");
}
