// Embeddings and vector index behind small interfaces so the vault works without them
// (local dev, tests) and so tests can use deterministic fakes.

export interface Embedder {
  model: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface VectorMatch {
  id: string;
  score: number;
}

export interface VectorIndex {
  upsert(namespace: string, items: { id: string; values: number[]; metadata: Record<string, string | number> }[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  query(namespace: string, values: number[], topK: number): Promise<VectorMatch[]>;
}

export const DEFAULT_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const EMBEDDING_DIMS = 1024;

export function workersAiEmbedder(ai: Ai, model: string): Embedder {
  const run = async (input: Record<string, unknown>): Promise<number[][]> => {
    // biome-ignore lint/suspicious/noExplicitAny: model id comes from config
    const out = (await ai.run(model as any, input as any)) as { data?: number[][] };
    return out.data ?? [];
  };
  return {
    model,
    embedDocuments: (texts) => run({ documents: texts }),
    embedQuery: async (text) => (await run({ queries: [text] }))[0] ?? [],
  };
}

export function vectorizeIndex(index: Vectorize): VectorIndex {
  return {
    async upsert(namespace, items) {
      for (let i = 0; i < items.length; i += 500) {
        await index.upsert(items.slice(i, i + 500).map((it) => ({ id: it.id, values: it.values, namespace, metadata: it.metadata })));
      }
    },
    async remove(ids) {
      for (let i = 0; i < ids.length; i += 500) await index.deleteByIds(ids.slice(i, i + 500));
    },
    async query(namespace, values, topK) {
      const res = await index.query(values, { topK, namespace, returnMetadata: "none" });
      return res.matches.map((m) => ({ id: m.id, score: m.score }));
    },
  };
}

/** Deterministic bag-of-words hashing embedder: tests and offline dev only. */
export function fakeEmbedder(dims = 256): Embedder {
  const vec = (text: string) => {
    const v = new Array<number>(dims).fill(0);
    for (const tok of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
      v[Math.abs(h) % dims] += 1;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  return {
    model: "fake-hash-embedder",
    embedDocuments: async (texts) => texts.map(vec),
    embedQuery: async (text) => vec(text),
  };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Reciprocal rank fusion over ranked id lists. */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Test/offline stand-in for Vectorize with the same semantics that matter for isolation:
 * one index shared by every vault, ids unique index-wide, upsert replaces by id (namespace
 * included), deletes by id are index-wide, queries filter by namespace. Stored in D1.
 */
export function fakeSharedIndex(db: D1Database): VectorIndex {
  const ensure = () => db.prepare("CREATE TABLE IF NOT EXISTS fake_vectors (id TEXT PRIMARY KEY, ns TEXT NOT NULL, vec TEXT NOT NULL)").run();
  return {
    async upsert(namespace, items) {
      await ensure();
      if (!items.length) return;
      await db.batch(
        items.map((it) => db.prepare("INSERT OR REPLACE INTO fake_vectors (id, ns, vec) VALUES (?, ?, ?)").bind(it.id, namespace, JSON.stringify(it.values))),
      );
    },
    async remove(ids) {
      await ensure();
      if (!ids.length) return;
      await db.batch(ids.map((id) => db.prepare("DELETE FROM fake_vectors WHERE id = ?").bind(id)));
    },
    async query(namespace, values, topK) {
      await ensure();
      const rows = (await db.prepare("SELECT id, vec FROM fake_vectors WHERE ns = ?").bind(namespace).all<{ id: string; vec: string }>()).results;
      return rows
        .map((r) => ({ id: r.id, score: cosine(values, JSON.parse(r.vec)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
  };
}
