// Supersession as a plain-text edit, written in Basic Memory's authored-time qualifiers so the
// history survives export: the old observation moves under "## Superseded" as
// "- [cat] @effective[<start>,<today>) old text (reason)", and its replacement takes its place as
// "- [cat] @effective:<today> new text". Nothing is deleted; the index reads the qualifiers (and the
// older "(since …)"/"(until …)" context grammar, still accepted) back out of the text.

import { findSection, formatQualifier, type Observation, parseNote, parseQualifier, splitContext, splitFrontmatter, stripQualifier } from "../markdown/parse";

export type EditOutcome = { ok: true; markdown: string; old: string; new: string | null } | { ok: false; code: "NOT_FOUND" | "INVALID"; message: string };

function contextParts(context: string | null, drop: RegExp): string[] {
  return (context ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !drop.test(p));
}

function render(category: string, content: string, parts: string[]): string {
  return `- [${category}] ${content}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

/** Find the single live observation that `match` names ("[category] text", or a fragment of the text). */
export function findObservation(markdown: string, match: string): { obs: Observation } | { error: string; code: "NOT_FOUND" | "INVALID" } {
  const m = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(match.trim());
  const wantCat = m ? m[1].trim().toLowerCase() : null;
  const wantText = (m ? m[2] : match).trim().toLowerCase();
  if (!wantText && !wantCat) return { code: "INVALID", error: "Name the observation to supersede." };
  const live = parseNote(markdown).observations.filter((o) => !o.superseded);
  const hits = live.filter((o) => (!wantCat || o.category.toLowerCase() === wantCat) && o.content.toLowerCase().includes(wantText));
  if (!hits.length) return { code: "NOT_FOUND", error: `No current observation matches "${match}".` };
  if (hits.length > 1) {
    return {
      code: "INVALID",
      error: `"${match}" matches ${hits.length} observations; be more specific:\n${hits.map((h) => `- [${h.category}] ${h.content}`).join("\n")}`,
    };
  }
  return { obs: hits[0] };
}

/** Insert lines at the end of the "Superseded" section, creating it at the end of the note if needed. */
function addToSuperseded(markdown: string, lines: string[]): string {
  const fm = splitFrontmatter(markdown);
  const head = markdown.slice(0, markdown.length - fm.body.length);
  const body = fm.body.split("\n");
  const range = findSection(fm.body, "Superseded");
  if (range) {
    let at = range.end;
    while (at > range.start + 1 && body[at - 1].trim() === "") at--;
    body.splice(at, 0, ...lines);
    return head + body.join("\n");
  }
  const text = fm.body.replace(/\s*$/, "");
  return `${head}${text}\n\n## Superseded\n${lines.join("\n")}\n`;
}

export function supersede(markdown: string, args: { match: string; replacement: string; reason?: string; today: string }): EditOutcome {
  const found = findObservation(markdown, args.match);
  if ("error" in found) return { ok: false, code: found.code, message: found.error };
  const { obs } = found;
  const lines = markdown.split("\n");
  const idx = obs.line - 1;
  const q = parseQualifier(obs.content);
  const start = obs.validFrom ?? q?.start ?? null;
  const oldText = `${formatQualifier("effective", start, args.today)} ${stripQualifier(obs.content)}`;
  const oldLine = render(obs.category, oldText, [
    ...contextParts(obs.context, /^(since|from|until|till|expires)\b/i),
    ...(args.reason?.trim() ? [args.reason.trim().replace(/[()]/g, "")] : []),
  ]);
  const rm = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(args.replacement.trim());
  const newCat = rm ? rm[1].trim() : obs.category;
  const { content: newContent, context: newCtx } = splitContext((rm ? rm[2] : args.replacement).trim());
  if (!stripQualifier(newContent).trim()) return { ok: false, code: "INVALID", message: "The replacement is empty." };
  // A replacement that states its own time keeps it; otherwise it takes effect today.
  const newText = parseQualifier(newContent) ? newContent : `${formatQualifier("effective", args.today, null)} ${newContent}`;
  const newLine = render(newCat, newText, contextParts(newCtx, /^since\b/i));
  const indent = /^\s*/.exec(lines[idx])?.[0] ?? "";
  lines.splice(idx, 1, indent + newLine);
  return { ok: true, markdown: addToSuperseded(lines.join("\n"), [oldLine]), old: oldLine, new: newLine };
}

/** Move every live observation whose `expires` date is on or before `today` to Superseded. */
export function expire(markdown: string, today: string): { markdown: string; moved: string[] } {
  const due = parseNote(markdown)
    .observations.filter((o) => !o.superseded && o.expires && o.expires <= today)
    .sort((a, b) => b.line - a.line);
  if (!due.length) return { markdown, moved: [] };
  const lines = markdown.split("\n");
  const moved: string[] = [];
  for (const o of due) {
    lines.splice(o.line - 1, 1);
    moved.unshift(render(o.category, o.content, [...contextParts(o.context, /^(until|expires)\b/i), `until ${o.expires}`, "expired"]));
  }
  return { markdown: addToSuperseded(lines.join("\n"), moved), moved };
}
