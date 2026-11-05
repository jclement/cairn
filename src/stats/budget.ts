// Per-user daily AI budget, charged atomically in D1 before a paid call is made.
import type { Env } from "../env";
import { today } from "./record";

export const DEFAULT_AI_DAILY_TOKENS = 1_000_000;

export function aiDailyTokens(env: Env): number {
  const n = Number(env.AI_DAILY_TOKENS ?? DEFAULT_AI_DAILY_TOKENS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AI_DAILY_TOKENS;
}

/** Spend `tokens` from today's budget. False (and nothing spent) if it would exceed the limit. */
export async function spendAiBudget(env: Env, userId: string, tokens: number): Promise<boolean> {
  if (env.CAIRN_FAULT_BUDGET === "1") throw new Error("injected fault: budget storage");
  const limit = aiDailyTokens(env);
  if (tokens > limit) return false;
  const row = await env.DB.prepare(
    `INSERT INTO ai_budget (user_id, day, tokens) VALUES (?1, ?2, ?3)
     ON CONFLICT (user_id, day) DO UPDATE SET tokens = tokens + excluded.tokens WHERE tokens + excluded.tokens <= ?4
     RETURNING tokens`,
  )
    .bind(userId, today(), tokens, limit)
    .first();
  return row !== null;
}

export const BUDGET_EXHAUSTED = "daily AI budget reached";
