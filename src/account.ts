// Account lifecycle: deleting an account everywhere it lives. Idempotent and resumable: every step
// can run again, and the user row (which marks `deleting_at`) goes last.

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { purgeVaultAttachments } from "./capture/files";
import { listOwnedVaults, revokeAllGrants, vaultRef, vaultStub } from "./directory";
import type { Env } from "./env";

export async function deleteAccount(env: Env, oauth: Pick<OAuthHelpers, "listUserGrants" | "revokeGrant">, userId: string): Promise<void> {
  const ts = new Date().toISOString();
  // 1. Stop all access now: mark deleting, void every credential issued so far.
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET deleting_at = COALESCE(deleting_at, ?1), tokens_valid_after = ?1 WHERE id = ?2").bind(ts, userId),
    env.DB.prepare("DELETE FROM pats WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM recent_grants WHERE user_id = ?").bind(userId),
  ]);
  // 2. Leave every project shared with this account, at once.
  await env.DB.prepare("DELETE FROM vault_members WHERE user_id = ?").bind(userId).run();
  // 3. Every vault it owns: vectors, then the Durable Object's storage, attachments (R2), then its
  //    directory row with its members and share links (members of a deleted project lose access).
  for (const v of await listOwnedVaults(env, userId)) {
    await vaultStub(env, v).purge(vaultRef(v));
    await purgeVaultAttachments(env, v.id);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_ledger WHERE vault_id = ?").bind(v.id),
      env.DB.prepare("DELETE FROM vault_members WHERE vault_id = ?").bind(v.id),
      env.DB.prepare("DELETE FROM share_links WHERE vault_id = ?").bind(v.id),
      env.DB.prepare("DELETE FROM vaults WHERE id = ?").bind(v.id),
    ]);
  }
  // 4. OAuth grants (all pages).
  await revokeAllGrants(oauth, userId);
  // 5. Everything else in the directory, then the user row last.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE created_by = ?").bind(userId),
    env.DB.prepare("DELETE FROM share_links WHERE created_by = ?").bind(userId),
    env.DB.prepare("UPDATE vault_members SET added_by = NULL WHERE added_by = ?").bind(userId),
    env.DB.prepare("UPDATE users SET invited_by = NULL WHERE invited_by = ?").bind(userId),
    env.DB.prepare("DELETE FROM stats_daily WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM misses WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM attachments WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM upload_tickets WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM email_seen WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM ai_daily WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM ai_budget WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM import_jobs WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM import_daily WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM usage_ledger WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM challenges WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM audit_log WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM credentials WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}
