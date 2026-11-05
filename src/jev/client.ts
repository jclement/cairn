// Calls Jev (typesafe/jev) through the Workers AI binding. A failed call is an error the caller
// degrades from; it is never read as a "no". Every call is recorded in the AI usage rollup.

import type { Env } from "../env";
import { BUDGET_EXHAUSTED, spendAiBudget } from "../stats/budget";
import { recordAi } from "../stats/record";
import type { JevAnswer } from "./answers";
import { fakeJev } from "./fake";
import { type JevQuestion, LIMITS } from "./questions";

export const DEFAULT_JEV_MODEL = "typesafe/jev";

export type { JevAnswer };

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type JevResult = { ok: true; answers: Record<string, JevAnswer>; model: string } | { ok: false; error: string; budget?: boolean };

export function jevModel(env: Env): string | null {
  if (env.CAIRN_FAKE_JEV) return env.JEV_MODEL === "" ? null : (env.JEV_MODEL ?? DEFAULT_JEV_MODEL);
  if (env.JEV_MODEL === "") return null;
  if (!env.AI) return null;
  return env.JEV_MODEL ?? DEFAULT_JEV_MODEL;
}

export function jevEnabled(env: Env): boolean {
  return jevModel(env) !== null;
}

export async function askJev(
  env: Env,
  opts: {
    userId: string;
    purpose: "search_rerank" | "write_hints" | "garden_check";
    state: unknown;
    questions: Record<string, JevQuestion>;
    timeoutMs: number;
  },
): Promise<JevResult> {
  const model = jevModel(env);
  if (!model) return { ok: false, error: "Jev is not configured" };
  const payload = JSON.stringify({ state: opts.state, questions: opts.questions });
  if (payload.length > LIMITS.payloadChars) return { ok: false, error: `request too large (${payload.length} chars)` };
  const estimate = Math.ceil(payload.length / 4);
  let admitted: boolean;
  try {
    admitted = await spendAiBudget(env, opts.userId, estimate);
  } catch (e) {
    // Budget storage failed: fail closed for the AI call, never for the caller's request.
    return { ok: false, error: `AI budget unavailable (${(e as Error).message})`, budget: true };
  }
  if (!admitted) return { ok: false, error: BUDGET_EXHAUSTED, budget: true };
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call: Promise<JevResponse> = env.CAIRN_FAKE_JEV
      ? fakeJev(env.CAIRN_FAKE_JEV, { state: opts.state, questions: opts.questions })
      : // biome-ignore lint/suspicious/noExplicitAny: third-party model id outside the typed catalogue
        ((env.AI as Ai).run(model as any, { state: opts.state, questions: opts.questions } as any) as unknown as Promise<JevResponse>);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Jev timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
    });
    const raw = (await Promise.race([call, timeout])) as JevResponse & { state?: string; result?: JevResponse };
    // Third-party models on Workers AI's unified route answer {state: "Completed", result: {...}};
    // accept that wrapping as well as the bare response.
    const res = raw && !raw.answers && raw.result?.answers ? raw.result : raw;
    if (!res || typeof res.answers !== "object") throw new Error("Jev returned no answers");
    for (const id of Object.keys(opts.questions)) if (!res.answers[id]) throw new Error(`Jev returned no answer for ${id}`);
    await recordAi(env.DB, {
      userId: opts.userId,
      model,
      purpose: opts.purpose,
      ok: true,
      latencyMs: Date.now() - started,
      inputTokens: res.usage?.input_tokens ?? Math.ceil(JSON.stringify(opts.state).length / 4),
      outputTokens: res.usage?.output_tokens ?? 0,
      estimated: res.usage?.input_tokens === undefined,
    }).catch(() => {});
    return { ok: true, answers: res.answers, model: res.model ?? model };
  } catch (e) {
    const timedOut = /timed out/.test((e as Error).message);
    await recordAi(env.DB, {
      userId: opts.userId,
      model,
      purpose: opts.purpose,
      ok: false,
      latencyMs: Date.now() - started,
      // A timed-out call may still complete and bill: count what was sent, flagged unknown.
      inputTokens: timedOut ? estimate : 0,
      outputTokens: 0,
      estimated: timedOut,
      unknown: timedOut,
    }).catch(() => {});
    return { ok: false, error: (e as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { expectedLevel, noul, probAtLeast } from "./answers";
