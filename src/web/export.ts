// Export: a zip of `<project>/<folder>/<Title>.md` exactly as stored (links stay [[...]]),
// plus a README.md index with relative links. Attachments are included under <project>/attachments/
// and links to them (/app/files/...) are rewritten to relative paths.

import { strToU8, zipSync } from "fflate";
import { exportAttachments } from "../capture/files";
import { listOwnedVaults, type Vault, vaultRef, vaultStub } from "../directory";
import type { Env } from "../env";
import { listMisses } from "../misses";

/** Account metadata for "download everything": no secrets (no keys, hashes or tokens). */
export async function accountJson(env: Env, user: { id: string; username: string; created_at: string }): Promise<Record<string, unknown>> {
  const creds = await env.DB.prepare("SELECT name, created_at, last_used_at, device_type, backed_up FROM credentials WHERE user_id = ? ORDER BY created_at")
    .bind(user.id)
    .all<{ name: string | null; created_at: string; last_used_at: string | null; device_type: string | null; backed_up: number }>();
  // Only the projects this account owns: shared projects belong to (and are exported by) their owners.
  const vaults = await listOwnedVaults(env, user.id);
  return {
    username: user.username,
    created_at: user.created_at,
    exported_at: new Date().toISOString(),
    passkeys: creds.results.map((c) => ({
      name: c.name,
      created_at: c.created_at,
      last_used_at: c.last_used_at,
      device_type: c.device_type,
      backed_up: !!c.backed_up,
    })),
    projects: vaults.map((v) => ({ name: v.name, default: !!v.is_default, notes: v.note_count, guide: v.guide ?? null })),
    guidance: (await env.DB.prepare("SELECT guidance FROM users WHERE id = ?").bind(user.id).first<{ guidance: string | null }>())?.guidance ?? null,
    attachments: "included under <project>/attachments/; links to them in notes are relative paths",
    original_text: "a note's kept original text is in <note>.sources.md beside it",
    // Questions the notes didn't answer (yours only, dismissed ones too), newest first.
    misses: (await listMisses(env, user.id, { limit: 500, dismissed: true })).map(({ id: _id, vault_id: _v, ...m }) => m),
  };
}

/** A zip of `only` (one project the caller may export), or of every project `userId` OWNS. */
export async function buildExportZip(env: Env, userId: string, only?: Vault, account?: Record<string, unknown>): Promise<Uint8Array> {
  const vaults = only ? [only] : await listOwnedVaults(env, userId);
  const files: Record<string, Uint8Array> = {};
  const index: string[] = [
    "# Cairn export",
    "",
    `Exported ${new Date().toISOString()}.`,
    "",
    "Each note is the markdown exactly as stored. Links use [[Wiki Link]] syntax (Basic Memory / Obsidian compatible).",
    "A note that keeps the original words it was written from has them in `<note>.sources.md` beside it.",
    "",
  ];
  for (const v of vaults) {
    const notes = await vaultStub(env, v).exportFiles(vaultRef(v));
    // Attachments go to <project>/attachments/; /app/files/... links become relative paths.
    const att = await exportAttachments(env, v);
    for (const [p, bytes] of Object.entries(att.files)) files[`${v.name}/${p}`] = bytes;
    index.push(`## ${v.name}`, "");
    for (const n of notes) {
      const path = `${v.name}/${n.path}`;
      files[path] = strToU8(att.rewrite(n.content, n.path.split("/").length - 1));
      // Its kept original text, verbatim, beside it.
      if (n.sources) files[path.replace(/\.md$/i, "") + ".sources.md"] = strToU8(n.sources);
      index.push(`- [${n.title.replace(/[[\]]/g, "")}](${path.split("/").map(encodeURIComponent).join("/")}) — \`${n.permalink}\``);
    }
    if (!notes.length) index.push("_(empty)_");
    index.push("");
  }
  if (account) files["account.json"] = strToU8(JSON.stringify(account, null, 2));
  files["README.md"] = strToU8(index.join("\n"));
  return zipSync(files, { level: 6 });
}
