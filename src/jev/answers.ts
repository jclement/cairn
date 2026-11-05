// Reading Jev's answers (shared by the vault and scripts/jev-eval.mjs).

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence?: number; probabilities: Record<string, number> }
  | { type: "choice"; choice: string; confidence?: number; probabilities: Record<string, number> };

export function noul(a: JevAnswer | undefined): number | null {
  return a && a.type === "noul" && typeof a.noul === "number" ? a.noul : null;
}

/** Expected level of a Score answer (0..levels-1), from its level probabilities when present. */
export function expectedLevel(a: JevAnswer | undefined): number | null {
  if (!a || a.type !== "score") return null;
  const probs = Object.entries(a.probabilities ?? {});
  if (probs.length) return probs.reduce((s, [k, p]) => s + Number(k) * p, 0);
  return typeof a.score === "number" ? a.score : null;
}

/** Probability that a Score answer is at `level` or above (null without level probabilities). */
export function probAtLeast(a: JevAnswer | undefined, level: number): number | null {
  if (!a || a.type !== "score") return null;
  const probs = Object.entries(a.probabilities ?? {});
  if (!probs.length) return typeof a.score === "number" ? (a.score >= level ? 1 : 0) : null;
  return probs.reduce((s, [k, p]) => s + (Number(k) >= level ? p : 0), 0);
}
