// Deterministic stand-in for Jev, used only when CAIRN_FAKE_JEV is set (tests, offline dev).
// "1" answers from word overlap; "fail" throws; "slow" never answers (exercises timeouts);
// "wrapped" answers like "1" inside {state, result}.
// It understands only Cairn's own question shapes (see questions.ts).

import type { JevResponse } from "./client";
import type { JevQuestion } from "./questions";

const words = (s: unknown) =>
  new Set(
    String(JSON.stringify(s) ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
const overlap = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
};
const get = (obj: unknown, path: string): unknown =>
  path.split(".").reduce((o: unknown, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
const paths = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

export async function fakeJev(mode: string, req: { state: unknown; questions: Record<string, JevQuestion> }): Promise<JevResponse> {
  if (mode === "fail") throw new Error("fake Jev failure");
  if (mode === "slow") return new Promise(() => {});
  if (mode === "wrapped") {
    // As the unified Workers AI route answers for third-party models.
    const inner = await fakeJev("1", req);
    return { state: "Completed", result: inner } as unknown as JevResponse;
  }
  const answers: JevResponse["answers"] = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const [a, b] = paths(q.instructions).map((p) => get(req.state, p));
    if (q.type === "score") {
      // relevance: overlap of the query's words with the candidate
      const o = overlap(words(b), words(a));
      const level = o >= 0.75 ? 3 : o >= 0.4 ? 2 : o > 0 ? 1 : 0;
      answers[id] = { type: "score", score: level, probabilities: { [String(level)]: 1 } };
    } else if (q.instructions.includes("contradict")) {
      // conflict: same leading words, different numbers/values
      const na = String(a ?? "").toLowerCase();
      const nb = String(b ?? "").toLowerCase();
      const head = (s: string) => s.split(/\s+/).slice(0, 3).join(" ");
      answers[id] = { type: "noul", noul: head(na) === head(nb) && na !== nb ? 0.9 : 0.1 };
    } else {
      // duplicate: titles overlap strongly
      const ta = words(get(a, "title"));
      const tb = words(get(b, "title"));
      answers[id] = { type: "noul", noul: overlap(ta, tb) >= 0.99 ? 0.9 : overlap(ta, tb) >= 0.5 ? 0.5 : 0.1 };
    }
  }
  const input = Math.ceil(JSON.stringify(req).length / 4);
  return { model: "fake-jev", answers, usage: { input_tokens: input, output_tokens: 0 } };
}
