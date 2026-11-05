// Text generation for the weekly digest (Workers AI chat model). Logged in the AI usage rollup.
import type { Env } from "../env";
import { recordAi } from "../stats/record";

export const DEFAULT_DIGEST_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export function digestModel(env: Env): string | null {
  if (env.DIGEST_MODEL === "") return null;
  if (!env.AI && !env.CAIRN_FAKE_LLM) return null;
  return env.DIGEST_MODEL ?? DEFAULT_DIGEST_MODEL;
}

export async function generate(
  env: Env,
  opts: { userId: string; system: string; prompt: string; maxTokens: number; timeoutMs?: number },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const model = digestModel(env);
  if (!model) return { ok: false, error: "no text model configured" };
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = env.CAIRN_FAKE_LLM
      ? env.CAIRN_FAKE_LLM === "fail"
        ? Promise.reject(new Error("fake LLM failure"))
        : Promise.resolve({
            choices: [{ message: { content: `Summary of ${opts.prompt.split("\n").filter((l) => l.startsWith("## ")).length} notes this week.` } }],
            usage: { prompt_tokens: Math.ceil(opts.prompt.length / 4), completion_tokens: 12 },
          })
      : (env.AI as unknown as { run(model: string, input: unknown): Promise<unknown> }).run(model, {
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.prompt },
          ],
          max_tokens: opts.maxTokens,
          chat_template_kwargs: { enable_thinking: false },
        });
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("text model timed out")), opts.timeoutMs ?? 60_000);
    });
    const out = (await Promise.race([call, timeout])) as {
      choices?: { message?: { content?: string } }[];
      response?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = (out.choices?.[0]?.message?.content ?? out.response ?? "").trim();
    if (!text) throw new Error("text model returned nothing");
    await recordAi(env.DB, {
      userId: opts.userId,
      model,
      purpose: "digest",
      ok: true,
      latencyMs: Date.now() - started,
      inputTokens: out.usage?.prompt_tokens ?? Math.ceil((opts.system.length + opts.prompt.length) / 4),
      outputTokens: out.usage?.completion_tokens ?? Math.ceil(text.length / 4),
      estimated: out.usage?.prompt_tokens === undefined,
    }).catch(() => {});
    return { ok: true, text };
  } catch (e) {
    await recordAi(env.DB, {
      userId: opts.userId,
      model,
      purpose: "digest",
      ok: false,
      latencyMs: Date.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
    }).catch(() => {});
    return { ok: false, error: (e as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
