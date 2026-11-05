// The shared per-account write limiter (RL_WRITE, 60/min per user in production). Every path that
// changes notes on a person's or assistant's behalf takes a token: MCP tools, the editor, pins,
// reverts (one per note), memory settings, and index creation from core_memory.
import type { Env } from "../env";

export async function admitWrite(env: Env, userId: string): Promise<boolean> {
  if (!env.RL_WRITE) return true;
  return (await env.RL_WRITE.limit({ key: `write:${userId}` })).success;
}

/**
 * Admit up to `wanted` writes for a bulk operation (one token per note, as bulk undo and import do),
 * counting `held` tokens the request already took; stops at the first refusal. Returns how many.
 */
export async function admitWrites(env: Env, userId: string, wanted: number, held = 1): Promise<number> {
  let budget = Math.min(held, wanted);
  while (budget < wanted && (await admitWrite(env, userId))) budget++;
  return budget;
}

/** Clients that are Cairn's own maintenance, not a person or an assistant. */
export const SYSTEM_CLIENTS = ["cairn-gardener", "cairn-cron", "cairn-digest"] as const;
