// The state and question sets Cairn sends to Jev, built from plain data so the vault (production)
// and scripts/jev-eval.mjs (tuning against the real model) use exactly the same requests.

import { type JevAnswer, probAtLeast } from "./answers";
import { conflictQuestion, duplicateQuestion, type JevQuestion, LIMITS, MATCH_LEVEL, relevanceQuestion } from "./questions";

/** A state key for a note: its permalink as an identifier, unique within `used`. */
export function stateKey(permalink: string, used: Set<string>): string {
  let k =
    permalink
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "note";
  if (/^\d/.test(k)) k = `n_${k}`;
  let key = k;
  for (let i = 2; used.has(key); i++) key = `${k}_${i}`;
  used.add(key);
  return key;
}

export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}

// ---- search re-ranking ----

/** Up to 3 lines (from `start`, skipping `hidden` 1-based line numbers) containing any of `lowerTerms`. */
export function matchLines(lines: string[], start: number, lowerTerms: string[], hidden: Set<number> = new Set()): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (let i = start; i < lines.length && out.length < 3; i++) {
    if (hidden.has(i + 1)) continue;
    const l = lines[i].toLowerCase();
    if (lowerTerms.some((t) => l.includes(t))) out.push({ line: i + 1, text: lines[i].trim().slice(0, 240) });
  }
  return out;
}

export interface RerankCandidate {
  permalink: string;
  title: string;
  type: string;
  /** Lines of the note that match the query, then matching observations ("[category] content"). */
  matches: string[];
  /** The note body (frontmatter removed), used when nothing matched. */
  body: string;
}

/**
 * The re-rank request for the top of the fused list. Candidates are taken in order until the
 * state budget is spent; `keys` holds the ones included (permalink -> state key), in order.
 */
export function rerankRequest(query: string, cands: RerankCandidate[]): JevRequest & { keys: Map<string, string> } {
  const used = new Set<string>();
  const candidates: Record<string, { title: string; type: string; excerpt: string }> = {};
  const keys = new Map<string, string>();
  // One budget for the whole request: each candidate costs its state entry plus its question, so
  // the serialized request stays under LIMITS.payloadChars (askJev refuses anything larger).
  const q = query.trim().slice(0, LIMITS.queryChars);
  let budget = LIMITS.payloadChars - JSON.stringify(q).length - 200;
  let stateBudget = LIMITS.stateChars;
  for (const c of cands.slice(0, LIMITS.rerankCandidates)) {
    const key = stateKey(c.permalink, used);
    budget -= JSON.stringify({ [`rel_${key}`]: relevanceQuestion(key) }).length + 1;
    if (Math.min(budget, stateBudget) < 100) break; // budget spent: re-rank only the candidates that fit
    keys.set(c.permalink, key);
    // Matching lines first, then the rest of the note: the answer is often on a line that
    // shares no word with the query ("cost" vs "budget").
    const seen = new Set(c.matches.map((m) => m.trim()));
    const rest = c.body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !seen.has(l));
    let excerpt = [...c.matches, ...rest].join("\n");
    excerpt = excerpt.slice(0, Math.max(0, Math.min(LIMITS.excerptChars, budget - 100, stateBudget - 100)));
    const title = c.title.slice(0, LIMITS.titleChars);
    const type = c.type.slice(0, LIMITS.typeChars);
    candidates[key] = { title, type, excerpt };
    const cost = JSON.stringify({ [key]: candidates[key] }).length + 1;
    budget -= cost;
    stateBudget -= cost;
  }
  const questions: Record<string, JevQuestion> = {};
  for (const key of keys.values()) questions[`rel_${key}`] = relevanceQuestion(key);
  return { state: { query: q, candidates }, questions, keys };
}

/** How likely it is that some candidate answers the query: the best P(relevance >= MATCH_LEVEL). */
export function anyMatch(answers: Record<string, JevAnswer>, keys: Iterable<string>): number | null {
  let any: number | null = null;
  for (const key of keys) {
    const p = probAtLeast(answers[`rel_${key}`], MATCH_LEVEL);
    if (p !== null) any = Math.max(any ?? 0, p);
  }
  return any;
}

// ---- write-time hints ----

export interface HintNote {
  permalink: string;
  title: string;
  type: string;
  body: string;
  observations: { category: string; content: string }[];
}

export interface HintPair {
  key: string;
  candidate: HintNote;
  new: string;
  old: string;
}

/**
 * The write-hint request: is the new note a duplicate of an existing one (new notes only), and
 * does each new observation contradict an existing observation of the same category?
 */
export function hintRequest(
  note: { title: string; type: string; body: string },
  newObs: { category: string; content: string }[],
  cands: HintNote[],
  isNew: boolean,
): (JevRequest & { keys: Map<string, string>; pairs: HintPair[] }) | null {
  const used = new Set<string>();
  const existing: Record<string, { title: string; type: string; excerpt: string }> = {};
  const keys = new Map<string, string>();
  for (const c of cands.slice(0, LIMITS.hintCandidates)) {
    const key = stateKey(c.permalink, used);
    keys.set(c.permalink, key);
    existing[key] = { title: c.title.slice(0, LIMITS.titleChars), type: c.type.slice(0, LIMITS.typeChars), excerpt: c.body.slice(0, LIMITS.excerptChars) };
  }
  const pairs: Record<string, { new: string; old: string; new_note: string; old_note: string }> = {};
  const pairList: HintPair[] = [];
  outer: for (const o of newObs.slice(0, 5)) {
    for (const c of cands.slice(0, LIMITS.hintCandidates)) {
      const olds = c.observations.filter((x) => x.category.toLowerCase() === o.category.toLowerCase()).slice(0, 2);
      for (const old of olds) {
        if (pairList.length >= LIMITS.hintPairs) break outer;
        const key = `p${pairList.length + 1}`;
        pairs[key] = {
          new: `[${o.category}] ${o.content}`.slice(0, LIMITS.pairSideChars),
          old: `[${old.category}] ${old.content}`.slice(0, LIMITS.pairSideChars),
          new_note: note.title.slice(0, LIMITS.titleChars),
          old_note: c.title.slice(0, LIMITS.titleChars),
        };
        pairList.push({ key, candidate: c, new: o.content, old: old.content });
      }
    }
  }
  const questions: Record<string, JevQuestion> = {};
  if (isNew) for (const key of keys.values()) questions[`dup_${key}`] = duplicateQuestion(key);
  for (const key of Object.keys(pairs)) questions[`conflict_${key}`] = conflictQuestion(key);
  if (!Object.keys(questions).length) return null;
  const state = {
    new_note: { title: note.title.slice(0, LIMITS.titleChars), type: note.type.slice(0, LIMITS.typeChars), text: note.body.slice(0, LIMITS.newNoteChars) },
    existing,
    ...(pairList.length ? { pairs } : {}),
  };
  return { state, questions, keys, pairs: pairList };
}
