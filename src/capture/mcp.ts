// MCP: attach_file (store a file from a URL, base64 or a one-time upload URL; link it into a note or
// a new one; read its text so search finds it).

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { guideSummary, type Vault, vaultRef, vaultStub } from "../directory";
import type { Caller, Env } from "../env";
import type { NoteInfo } from "../vault/do";
import { extractAttachment, outcomeLine } from "./extract";
import { safeFetch } from "./fetch";
import { type AttachmentRow, attachmentMarkdown, fileUrl, MAX_ATTACHMENT_BYTES, putAttachment } from "./files";
import { createUploadTicket, finishUploadTicket } from "./links";

/** Largest file sent inline as base64; bigger ones go through an upload URL (upload=true). */
export const INLINE_MAX_BYTES = 2 * 1024 * 1024;

export interface CaptureToolContext {
  env: Env;
  canWrite: boolean;
  vaultFor(project: string | undefined, need?: "read" | "write"): Promise<Vault | CallToolResult>;
  caller(tool: string): Caller;
  writeLimited(): Promise<CallToolResult | null>;
  readOnly(): CallToolResult;
  refuse(code: string, message: string): CallToolResult;
  receipt(vault: string, note: NoteInfo): string;
}

const isRefusal = (v: unknown): v is CallToolResult => typeof v === "object" && v !== null && "content" in v;

type Args = {
  url?: string;
  data_base64?: string;
  upload?: boolean;
  ref?: string;
  filename?: string;
  mime_type?: string;
  note?: string;
  title?: string;
  project?: string;
};

export function registerCaptureTools(server: McpServer, ctx: CaptureToolContext): void {
  const { env } = ctx;
  server.registerTool(
    "attach_file",
    {
      description:
        "Attach a file (PDF, image, text; max 10 MB) from a public URL, base64 (up to 2 MB), or a one-time upload URL: upload=true returns upload_url and ref; PUT the raw bytes there, then call again with ref. Link it into a note (note) or a new one (title). Cairn reads its text (PDF pages, text in images) so search finds it; the receipt says how that went. Counts toward storage.",
      inputSchema: z.strictObject({
        url: z.string().max(2000).optional().describe("Public http(s) URL to fetch"),
        data_base64: z.string().optional().describe("File bytes, base64 (up to 2 MB)"),
        upload: z.boolean().optional().describe("true: get a one-time upload URL (15 minutes) for a larger file"),
        ref: z.string().max(40).optional().describe("Finish an upload: the ref upload=true returned"),
        filename: z.string().max(200).optional(),
        mime_type: z.string().max(100).optional().describe("Declared type; the stored type is sniffed or chosen from a short list"),
        note: z.string().max(500).optional().describe("Identifier of a note to append the file to"),
        title: z.string().max(200).optional().describe("Create a new note with this title holding the file (instead of note)"),
        project: z
          .string()
          .optional()
          .describe("Project name: one of the user's own, or owner/name for a project shared with them. Defaults to the user's default project."),
      }),
      annotations: { destructiveHint: false },
    },
    async (args: Args) => {
      if (!ctx.canWrite) return ctx.readOnly();
      const limited = await ctx.writeLimited();
      if (limited) return limited;
      const v = await ctx.vaultFor(args.project, "write");
      if (isRefusal(v)) return v;
      if (args.note && args.title) return ctx.refuse("INVALID", "Give note (an existing note) or title (a new note), not both.");
      const ways = [args.url, args.data_base64, args.upload, args.ref].filter((x) => x !== undefined && x !== false).length;
      if (ways !== 1) return ctx.refuse("INVALID", "Give exactly one of url, data_base64, upload=true or ref.");
      const origin = new URL(env.PUBLIC_URL).origin;
      const actor = ctx.caller("attach_file").userId;

      if (args.upload) {
        const t = await createUploadTicket(env, actor, v, {
          filename: args.filename,
          mime: args.mime_type,
          note: args.note ?? (args.title ? `title:${args.title}` : undefined),
        });
        if (!t.ok) return ctx.refuse(t.code, t.message);
        return {
          content: [
            {
              type: "text",
              text: [
                `upload_url: ${t.upload_url}`,
                `ref: ${t.ref}`,
                `expires: ${t.expires} (single use, up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`,
                `Next: PUT the file's raw bytes to upload_url (e.g. curl -T <file> '<upload_url>'), then call attach_file ref="${t.ref}" (with note or title to link it).`,
              ].join("\n"),
            },
          ],
        };
      }

      let a: AttachmentRow;
      let created: boolean;
      let note = args.note;
      let title = args.title;
      if (args.ref) {
        const f = await finishUploadTicket(env, actor, v, args.ref);
        if (!f.ok) return ctx.refuse(f.code, f.message);
        a = f.attachment;
        created = true;
        // Where to link it: this call's note/title, else what the upload asked for.
        if (!note && !title && f.ticket.note) {
          if (f.ticket.note.startsWith("title:")) title = f.ticket.note.slice(6);
          else note = f.ticket.note;
        }
      } else {
        let bytes: Uint8Array;
        let mime = args.mime_type;
        let name = args.filename;
        if (args.data_base64) {
          if (args.data_base64.length > Math.ceil((INLINE_MAX_BYTES * 4) / 3) + 64)
            return ctx.refuse("TOO_LARGE", "Inline files are at most 2 MB: call attach_file upload=true for an upload URL (up to 10 MB).");
          try {
            const bin = atob(args.data_base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
            bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
          } catch {
            return ctx.refuse("INVALID", "data_base64 is not valid base64.");
          }
        } else {
          const got = await safeFetch(args.url as string, { accept: "*/*", maxBytes: MAX_ATTACHMENT_BYTES, fetcher: env.CAPTURE_FETCH });
          if (!got.ok) return ctx.refuse(got.code, got.message);
          if (got.truncated) return ctx.refuse("TOO_LARGE", "The file is larger than 10 MB.");
          bytes = got.bytes;
          mime ||= got.contentType;
          name ||= decodeURIComponent(new URL(got.url).pathname.split("/").pop() || "") || undefined;
        }
        const r = await putAttachment(env, v, { bytes, name, mime, source: args.url ? "url" : "mcp" });
        if (!r.ok) return ctx.refuse(r.code, r.message);
        a = r.attachment;
        created = r.created;
      }
      const url = fileUrl(v.name, a.id);
      const markdown = attachmentMarkdown(v.name, a);
      const lines = [
        `${created ? "attached" : "already attached"} ${a.name} (${a.mime}, ${Math.ceil(a.bytes / 1024)} KB) — ${origin}${url}`,
        `markdown: ${markdown}`,
      ];
      if (a.caption) lines.push(`caption: ${a.caption}`);
      // Link first, then read: reading copies the text into every note that links the file.
      if (note) {
        const e = await vaultStub(env, v).editNote(vaultRef(v), ctx.caller("attach_file"), { identifier: note, command: "append", content: `\n${markdown}\n` });
        if (!e.ok) lines.push(`(not linked into ${note}: ${e.code} ${e.message})`);
        else lines.push(ctx.receipt(v.name, e.value.note));
      } else if (title) {
        const w = await vaultStub(env, v).writeNote(vaultRef(v), ctx.caller("attach_file"), { title, content: `${markdown}\n` });
        if (!w.ok) lines.push(`(no note created: ${w.code} ${w.message})`);
        else lines.push(ctx.receipt(v.name, w.value.note));
      } else {
        lines.push("Embed the markdown in a note (write_note / edit_note) to keep it with your memory; its text joins that note.");
      }
      const state = a.extract_state;
      if (state === "pending") lines.push(outcomeLine(await extractAttachment(env, v, a.id)));
      else if (state === "done") lines.push(`text: already read${a.extract_pages ? ` (${a.extract_pages} pages)` : ""}, searchable`);
      else if (state) lines.push(outcomeLine({ state, error: a.extract_error ?? undefined }));
      lines.push(`The user can have the original: read_note file=${a.id} gives a download link that needs no sign-in.`);
      if (v.guide) lines.push(`guide for ${v.name}: ${guideSummary(v.guide)} (all of it: projects command=guide project="${v.name}")`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
