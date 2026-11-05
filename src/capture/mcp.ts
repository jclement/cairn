// MCP: attach_file (store a file from a URL or base64 and optionally link it into a note).

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { guideSummary, type Vault, vaultRef, vaultStub } from "../directory";
import type { Caller, Env } from "../env";
import type { NoteInfo } from "../vault/do";
import { safeFetch } from "./fetch";
import { MAX_ATTACHMENT_BYTES, putAttachment } from "./files";

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

export function registerCaptureTools(server: McpServer, ctx: CaptureToolContext): void {
  const { env } = ctx;
  server.registerTool(
    "attach_file",
    {
      description:
        "Attach a file (image, PDF, …; max 10 MB) to the user's memory, from a public URL or base64 data. Returns markdown to embed it (images get an AI caption, used as alt text so search finds them). Pass note to append the embed to that note. Files count toward the storage quota.",
      inputSchema: z.strictObject({
        url: z.string().max(2000).optional().describe("Public http(s) URL to fetch"),
        data_base64: z.string().optional().describe("File bytes, base64 (instead of url)"),
        filename: z.string().max(200).optional(),
        mime_type: z.string().max(100).optional().describe("Declared type; the stored type is sniffed or chosen from a short list"),
        note: z.string().max(500).optional().describe("Identifier of a note to append the embed to"),
        project: z
          .string()
          .optional()
          .describe("Project name: one of the user's own, or owner/name for a project shared with them. Defaults to the user's default project."),
      }),
      annotations: { destructiveHint: false },
    },
    async (args: { url?: string; data_base64?: string; filename?: string; mime_type?: string; note?: string; project?: string }) => {
      if (!ctx.canWrite) return ctx.readOnly();
      const limited = await ctx.writeLimited();
      if (limited) return limited;
      const v = await ctx.vaultFor(args.project, "write");
      if (isRefusal(v)) return v;
      let bytes: Uint8Array;
      let mime = args.mime_type;
      let name = args.filename;
      if (args.data_base64) {
        if (args.data_base64.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8) return ctx.refuse("TOO_LARGE", "The file is larger than 10 MB.");
        try {
          const bin = atob(args.data_base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
          bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
        } catch {
          return ctx.refuse("INVALID", "data_base64 is not valid base64.");
        }
      } else if (args.url) {
        const got = await safeFetch(args.url, { accept: "*/*", maxBytes: MAX_ATTACHMENT_BYTES, fetcher: env.CAPTURE_FETCH });
        if (!got.ok) return ctx.refuse(got.code, got.message);
        if (got.truncated) return ctx.refuse("TOO_LARGE", "The file is larger than 10 MB.");
        bytes = got.bytes;
        mime ||= got.contentType;
        name ||= decodeURIComponent(new URL(got.url).pathname.split("/").pop() || "") || undefined;
      } else {
        return ctx.refuse("INVALID", "Give url or data_base64.");
      }
      const r = await putAttachment(env, v, { bytes, name, mime, source: args.url ? "url" : "mcp" });
      if (!r.ok) return ctx.refuse(r.code, r.message);
      const a = r.attachment;
      const origin = new URL(env.PUBLIC_URL).origin;
      const lines = [
        `${r.created ? "attached" : "already attached"} ${a.name} (${a.mime}, ${Math.ceil(a.bytes / 1024)} KB) — ${origin}${r.url}`,
        `markdown: ${r.markdown}`,
      ];
      if (a.caption) lines.push(`caption: ${a.caption}`);
      if (args.note) {
        const e = await vaultStub(env, v).editNote(vaultRef(v), ctx.caller("attach_file"), {
          identifier: args.note,
          command: "append",
          content: `\n${r.markdown}\n`,
        });
        if (!e.ok) lines.push(`(not linked into ${args.note}: ${e.code} ${e.message})`);
        else lines.push(ctx.receipt(v.name, e.value.note));
      } else {
        lines.push("Embed the markdown in a note (write_note / edit_note) to keep it with your memory.");
      }
      if (v.guide) lines.push(`guide for ${v.name}: ${guideSummary(v.guide)} (all of it: projects command=guide project="${v.name}")`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
