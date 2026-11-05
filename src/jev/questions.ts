// Every question Cairn asks Jev, and the thresholds code applies to the answers, in one place.
// Principle: Jev makes narrow judgments; code makes the decisions.

export const NOUL_YES = 0.7;
export const NOUL_NO = 0.3;

export type NoulBand = "yes" | "no" | "unsure";
export const band = (p: number): NoulBand => (p >= NOUL_YES ? "yes" : p <= NOUL_NO ? "no" : "unsure");

export interface JevQuestion {
  type: "noul" | "score" | "choice";
  instructions: string;
  criteria?: { true: string; false: string } | string[] | Record<string, string>;
}

// ---- search re-ranking ----

/** Score per candidate. Levels are ordered lowest first; code reads the expected level 0-3. */
export function relevanceQuestion(key: string): JevQuestion {
  return {
    type: "score",
    instructions: `How directly does \`candidates.${key}\` answer \`query\`?`,
    criteria: [
      "The note is about a different subject; nothing in it helps answer the query.",
      "The note is on a related subject but does not contain what the query asks for.",
      "The note contains part of what the query asks for, or background that helps answer it.",
      "The note directly contains what the query asks for.",
    ],
  };
}

/**
 * Abstention is computed in code, not asked: a candidate "answers" the query when its relevance is
 * at least this level (it contains part of what the query asks for). any_match is the highest
 * probability of that among the candidates. A separate "does any note answer?" Noul over all
 * candidates said "no" for 10 of 22 answerable queries in scripts/jev-eval.mjs (Nov 2026).
 */
export const MATCH_LEVEL = 2;

// ---- write-time hints ----

export function duplicateQuestion(key: string): JevQuestion {
  return {
    type: "noul",
    instructions: `Do \`new_note\` and \`existing.${key}\` have the same main subject?`,
    criteria: {
      true: "Each note is mainly about the same single person, project, thing or topic, at the same scope, so they would be one note: two notes about the same person, or two copies of the same document.",
      false:
        "Their main subjects differ, even if related: one is about a part, detail, date, event or decision concerning the other's subject (a meeting about a project, one deadline of a plan); they are different instances of the same kind of thing (two different holidays, two different products); or one is connected to the other (a person and the company they work at).",
    },
  };
}

export function conflictQuestion(key: string): JevQuestion {
  return {
    type: "noul",
    instructions: `Does \`pairs.${key}.new\` contradict \`pairs.${key}.old\`?`,
    criteria: {
      true: `Both statements are about the same thing (\`pairs.${key}.new_note\` and \`pairs.${key}.old_note\` name the notes they come from) and give different values for the same fact, so they cannot both be true now: two different main contacts, two different dates for the same deadline, a choice that was later changed.`,
      false:
        "Both can be true: they are about different things (two different people, products or years), one adds a detail or a fact the other doesn't mention, or they describe different aspects.",
    },
  };
}

/** Bounds on cost and latency. */
export const LIMITS = {
  rerankCandidates: 20,
  rerankMinCandidates: 3,
  excerptChars: 500,
  stateChars: 12_000,
  hintCandidates: 5,
  hintPairs: 10,
  gardenPairs: 20,
  rerankTimeoutMs: 3000,
  /** Hard cap on the whole serialized request (state + questions); larger requests are not sent. */
  payloadChars: 16_000,
  queryChars: 500,
  titleChars: 200,
  typeChars: 40,
  pairSideChars: 300,
  newNoteChars: 1500,
  hintsTimeoutMs: 1500,
};
