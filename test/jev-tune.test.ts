// Jev tuning (scripts/jev-eval.mjs, .lead/reports/jev-eval.md): request budget, fuller excerpts,
// abstention computed from the relevance answers, yes-only write hints, wrapped responses.
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/jev/questions";
import { anyMatch, hintRequest, rerankRequest } from "../src/jev/state";
import { caller, defaultVault, makeUser } from "./helpers";

const long = (i: number) => ({
  permalink: `notes/candidate-${i}`,
  title: `Candidate ${i}`,
  type: "note",
  matches: [`budget line ${i} `.repeat(30)],
  body: "x ".repeat(2000),
});

describe("Jev request builders", () => {
  it("keeps the whole re-rank request under the payload cap", () => {
    const req = rerankRequest(
      "how much will it cost",
      Array.from({ length: 20 }, (_, i) => long(i)),
    );
    expect(JSON.stringify({ state: req.state, questions: req.questions }).length).toBeLessThanOrEqual(LIMITS.payloadChars);
    expect(req.keys.size).toBeGreaterThanOrEqual(3);
    expect(Object.keys(req.questions)).toEqual([...req.keys.values()].map((k) => `rel_${k}`));
  });

  it("fills a candidate's excerpt with the rest of the note after the matching lines", () => {
    const req = rerankRequest("japan trip cost", [
      { permalink: "travel/japan", title: "Japan trip", type: "plan", matches: ["# Japan trip"], body: "# Japan trip\n\n- [budget] About 9,000 CAD" },
      { permalink: "a", title: "A", type: "note", matches: [], body: "a" },
      { permalink: "b", title: "B", type: "note", matches: [], body: "b" },
    ]);
    const c = (req.state as { candidates: Record<string, { excerpt: string }> }).candidates.travel_japan;
    expect(c.excerpt).toBe("# Japan trip\n- [budget] About 9,000 CAD");
  });

  it("computes any_match as the best P(relevance >= 2), with no separate question", () => {
    const req = rerankRequest(
      "q",
      ["a", "b", "c"].map((p) => ({ permalink: p, title: p, type: "note", matches: [], body: p })),
    );
    expect(Object.keys(req.questions).some((k) => !k.startsWith("rel_"))).toBe(false);
    const s = (probabilities: Record<string, number>) => ({ type: "score" as const, score: 0, probabilities });
    expect(anyMatch({ rel_a: s({ 0: 0.9, 1: 0.1 }), rel_b: s({ 1: 0.5, 2: 0.3, 3: 0.2 }), rel_c: s({ 0: 1 }) }, req.keys.values())).toBeCloseTo(0.5);
  });

  it("gives each contradiction pair the titles of both notes", () => {
    const req = hintRequest(
      { title: "Acme", type: "org", body: "- [contact] Main contact is Omar" },
      [{ category: "contact", content: "Main contact is Omar" }],
      [{ permalink: "orgs/acme-old", title: "Acme (old)", type: "org", body: "", observations: [{ category: "contact", content: "Main contact is Dana" }] }],
      false,
    );
    expect((req!.state as { pairs: Record<string, unknown> }).pairs.p1).toEqual({
      new: "[contact] Main contact is Omar",
      old: "[contact] Main contact is Dana",
      new_note: "Acme",
      old_note: "Acme (old)",
    });
  });
});

describe("Jev in the vault", () => {
  it("reads answers wrapped as {state, result} (unified Workers AI route)", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    for (const t of ["alpha one", "alpha two", "alpha three"]) await v.stub.writeNote(v.ref, caller(user), { title: t, content: `${t} alpha` });
    await v.stub.setJevTestMode({ CAIRN_FAKE_JEV: "wrapped" });
    const r = await v.stub.search(v.ref, { query: "alpha" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.rerank?.applied).toBe(true);
  });

  it("shows only 'yes' write hints", async () => {
    const { user } = await makeUser();
    const v = await defaultVault(user.id);
    await v.stub.writeNote(v.ref, caller(user), { title: "Water supply", content: "- [contact] Main contact is Dana Roe" });
    // The fake answers 0.5 (unsure) for half-overlapping titles: not shown.
    const w = await v.stub.writeNote(v.ref, caller(user), { title: "Water supply plans", content: "- [note] something new" });
    if (!w.ok) throw new Error(w.message);
    expect(w.value.hints?.duplicates ?? []).toEqual([]);
  });
});
