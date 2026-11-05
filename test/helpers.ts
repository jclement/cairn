import { env } from "cloudflare:test";
import { createSession, createUser, getVault, type User } from "../src/directory";
import type { Caller } from "../src/env";

export const BASE = "http://localhost:8787";
export const ORIGIN = BASE;

let n = 0;
export async function makeUser(prefix = "user"): Promise<{ user: User; cookie: string }> {
  const created = await createUser(env, `${prefix}${++n}${Math.floor(Math.random() * 1e6)}`, false);
  if (!created.ok) throw new Error(created.reason);
  const user = created.user;
  const token = await createSession(env, user.id);
  return { user, cookie: `__Host-cairn_session=${token}` };
}

export async function defaultVault(userId: string) {
  const v = await getVault(env, userId);
  if (!v) throw new Error("no default vault");
  return { vault: v, stub: env.VAULT.getByName(v.id), ref: { id: v.id, name: v.name, ownerId: v.owner_id } };
}

export function caller(user: User, client = "test-client", tool = "test"): Caller {
  return { userId: user.id, username: user.username, client, tool };
}

/** Mark all of a user's sessions as freshly re-authenticated (what a passkey assertion at /app/reauth does). */
export async function freshReauth(userId: string) {
  await env.DB.prepare("UPDATE sessions SET reauth_at = ? WHERE user_id = ?").bind(new Date().toISOString(), userId).run();
}
