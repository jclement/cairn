// Cheap counters: one D1 batch of upserts per operation. Daily rollups, never raw events.

export const today = () => new Date().toISOString().slice(0, 10);

/** Add to a user's daily counters. Metric names are short strings; client names are truncated. */
export async function bump(db: D1Database, userId: string, metrics: Record<string, number>): Promise<void> {
  const day = today();
  const stmts = Object.entries(metrics)
    .filter(([, v]) => v)
    .map(([metric, value]) =>
      db
        .prepare(
          "INSERT INTO stats_daily (user_id, day, metric, value) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, day, metric) DO UPDATE SET value = value + excluded.value",
        )
        .bind(userId, day, metric.slice(0, 80), value),
    );
  if (stmts.length) await db.batch(stmts);
}

export interface AiCall {
  userId: string;
  model: string;
  purpose: "embed" | "query_embed" | "search_rerank" | "write_hints" | "garden_check" | "digest" | "caption" | "to_markdown";
  ok: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  /** Timed out: the call may still run and bill; tokens are what was sent (estimated). */
  unknown?: boolean;
}

export async function recordAi(db: D1Database, call: AiCall): Promise<void> {
  const failed = call.ok ? 0 : 1;
  const unknown = call.unknown ? 1 : 0;
  // Instance-wide hourly counts for the health check (last 24 h). Best effort: never fails the call.
  await db
    .prepare(
      `INSERT INTO ai_hourly (hour, model, purpose, calls, failed, unknown_calls) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT (hour, model, purpose) DO UPDATE SET calls = calls + 1, failed = failed + excluded.failed, unknown_calls = unknown_calls + excluded.unknown_calls`,
    )
    .bind(new Date().toISOString().slice(0, 13), call.model, call.purpose, failed, unknown)
    .run()
    .catch(() => undefined);
  await db
    .prepare(
      `INSERT INTO ai_daily (user_id, day, model, purpose, calls, failed, latency_ms, input_tokens, output_tokens, estimated_calls, unknown_calls)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, day, model, purpose) DO UPDATE SET
         calls = calls + 1, failed = failed + excluded.failed, latency_ms = latency_ms + excluded.latency_ms,
         input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
         estimated_calls = estimated_calls + excluded.estimated_calls, unknown_calls = unknown_calls + excluded.unknown_calls`,
    )
    .bind(
      call.userId,
      today(),
      call.model,
      call.purpose,
      call.ok ? 0 : 1,
      Math.round(call.latencyMs),
      call.inputTokens,
      call.outputTokens,
      call.estimated ? 1 : 0,
      call.unknown ? 1 : 0,
    )
    .run();
}

/** Embedding token estimate: ~4 characters per token. */
export const estimateTokens = (texts: string[]) => Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
