// Search-query parsing for SQLite FTS5, shared by the vault and scripts/jev-eval.mjs.

/** Turn free text into a safe FTS5 MATCH expression. Returns null when nothing is searchable. */
export function ftsQuery(query: string, joiner: "AND" | "OR" = "AND"): { expr: string | null; tags: string[]; terms: string[] } {
  const tags: string[] = [];
  const parts: string[] = [];
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let pendingOp: string | null = null;
  for (const m of query.matchAll(re)) {
    if (m[1]) {
      const words = m[1].match(/[\p{L}\p{N}_]+/gu);
      if (words?.length) {
        if (pendingOp && parts.length) parts.push(pendingOp);
        pendingOp = null;
        parts.push(`"${words.join(" ")}"`);
        terms.push(...words);
      }
      continue;
    }
    const tok = m[2];
    if (tok === "AND" || tok === "OR" || tok === "NOT") {
      pendingOp = tok;
      continue;
    }
    if (/^tag:/i.test(tok)) {
      const t = tok.slice(4).replace(/^#/, "");
      if (t) tags.push(t);
      continue;
    }
    const words = tok.match(/[\p{L}\p{N}_]+/gu);
    if (!words) continue;
    for (const w of words) {
      if (parts.length) parts.push(pendingOp ?? joiner);
      pendingOp = null;
      parts.push(`"${w}"*`);
      terms.push(w);
    }
  }
  // An expression can't start with NOT or end with an operator.
  while (parts.length && ["AND", "OR", "NOT"].includes(parts[parts.length - 1])) parts.pop();
  return { expr: parts.length ? parts.join(" ") : null, tags, terms };
}
