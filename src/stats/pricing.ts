// Workers AI list prices used for the stats page's cost estimates (USD per million tokens).
export const PRICING_SOURCES = {
  jev: "https://developers.cloudflare.com/ai/models/typesafe/jev/",
  workersAi: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
};

const PRICES: Record<string, { input: number; output: number }> = {
  "typesafe/jev": { input: 0.042, output: 0 }, // Jev: $0.042/M input, output free
  "@cf/qwen/qwen3-embedding-0.6b": { input: 0.012, output: 0 }, // $0.012/M input tokens (1,075 neurons/M)
  "@cf/google/gemma-4-26b-a4b-it": { input: 0.1, output: 0.3 }, // digests: $0.100/M in, $0.300/M out
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}
