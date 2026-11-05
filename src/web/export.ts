// Export: a zip of `<project>/<folder>/<Title>.md` exactly as stored (links stay [[...]]),
// plus a README.md index with relative links. Attachments are included under <project>/attachments/
// and links to them (/app/files/...) are rewritten to relative paths.

import { strToU8, zipSync } from "fflate";
import { exportAttachments } from "../capture/files";
import { listVaults, type Vault, vaultRef, vaultStub } from "../directory";
import type { Env } from "../env";

/** Account metadata for "download everything": no secrets (no keys, hashes or tokens). */
export async function accountJson(env: Env, user: { id: string; username: string; created_at: string }): Promise<Record<string, unknown>> {
  const creds = await env.DB.prepare("SELECT name, created_at, last_used_at, device_type, backed_up FROM credentials WHERE user_id = ? ORDER BY created_at")
    .bind(user.id)
    .all<{ name: string | null; created_at: string; last_used_at: string | null; device_type: string | null; backed_up: number }>();
  const vaults = await listVaults(env, user.id);
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
    projects: vaults.map((v) => ({ name: v.name, default: !!v.is_default, notes: v.note_count })),
    attachments: "included under <project>/attachments/; links to them in notes are relative paths",
  };
}

export async function buildExportZip(env: Env, userId: string, only?: Vault, account?: Record<string, unknown>): Promise<Uint8Array> {
  const vaults = only ? [only] : await listVaults(env, userId);
  const files: Record<string, Uint8Array> = {};
  const index: string[] = [
    "# Cairn export",
    "",
    `Exported ${new Date().toISOString()}.`,
    "",
    "Each note is the markdown exactly as stored. Links use [[Wiki Link]] syntax (Basic Memory / Obsidian compatible).",
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
      index.push(`- [${n.title.replace(/[[\]]/g, "")}](${path.split("/").map(encodeURIComponent).join("/")}) — \`${n.permalink}\``);
    }
    if (!notes.length) index.push("_(empty)_");
    index.push("");
  }
  if (account) files["account.json"] = strToU8(JSON.stringify(account, null, 2));
  files["README.md"] = strToU8(index.join("\n"));
  return zipSync(files, { level: 6 });
}
