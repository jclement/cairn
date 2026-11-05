// Evaluate Cairn's Jev questions against the real model (Workers AI REST), on the synthetic
// fixtures in test/fixtures/jev/. Uses the production request builders (src/jev/state.ts), query
// parser (src/vault/fts.ts), fusion (src/vault/embed.ts rrf) and answer readers, bundled here.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/jev-eval.mjs [--split tune|held|all] [--only search|hints] [--verbose]
//
// Search: keyword ranking runs the vault's FTS5 schema and bm25 weights in node:sqlite; semantic
// ranking embeds each note with the production embedding model; both fuse with rrf() as in
// production. Reports top-1/top-3 for RRF alone and after Jev re-ranking, plus any_match bands.
// Hints: duplicate and conflict precision/recall for the "yes" band (what the vault shows) and for
// "yes or unsure". Responses are cached on disk by request hash, so a
// re-run with unchanged requests costs nothing; the run reports the tokens actually sent.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const SPLIT = opt("split", "all");
const ONLY = opt("only", "all");
const VERBOSE = args.includes("--verbose");
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCOUNT) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID (and CLOUDFLARE_API_TOKEN) to run the Jev eval.");
  process.exit(2);
}
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const EMBED_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const JEV_MODEL = process.env.JEV_MODEL ?? "typesafe/jev";
const CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cairn-jev-eval");
mkdirSync(CACHE, { recursive: true });

// ---- production code, bundled ----
const bundle = await build({
  stdin: {
    contents: [
      'export * from "./src/jev/state.ts";',
      'export * from "./src/jev/questions.ts";',
      'export * from "./src/jev/answers.ts";',
      'export { ftsQuery } from "./src/vault/fts.ts";',
      'export { rrf } from "./src/vault/embed.ts";',
    ].join("\n"),
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});
const P = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

// ---- Workers AI REST, cached ----
const usage = { calls: 0, cached: 0, inputTokens: 0, failures: 0 };
async function run(model, input) {
  const key = createHash("sha256").update(JSON.stringify([model, input])).digest("hex");
  const file = join(CACHE, `${key}.json`);
  try {
    const hit = JSON.parse(readFileSync(file, "utf8"));
    usage.cached++;
    return hit;
  } catch {}
  if (!TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is not set (and this request is not cached)");
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Workers AI's own models (@cf/...) answer at /ai/run/<model>; third-party models such as
    // typesafe/jev only at the unified /ai/run with {model, input}, wrapped as {state, result}.
    const native = model.startsWith("@cf/");
    const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`;
    const res = await fetch(native ? `${base}/${model}` : base, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(native ? input : { model, input }),
    });
    const body = await res.json().catch(() => null);
    const result = native ? body?.result : body?.result?.state === "Completed" ? body.result.result : null;
    if (res.ok && body?.success !== false && result) {
      usage.calls++;
      usage.inputTokens += result.usage?.input_tokens ?? 0;
      writeFileSync(file, JSON.stringify(result));
      return result;
    }
    lastErr = new Error(`${model}: HTTP ${res.status} ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`);
    if (res.status < 500 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  usage.failures++;
  throw lastErr;
}
async function askJev(req) {
  const payload = JSON.stringify({ state: req.state, questions: req.questions });
  if (payload.length > P.LIMITS.payloadChars) throw new Error(`request too large (${payload.length} chars)`);
  const r = await run(JEV_MODEL, { state: req.state, questions: req.questions });
  for (const id of Object.keys(req.questions)) if (!r.answers?.[id]) throw new Error(`no answer for ${id}`);
  return r.answers;
}

// ---- fixtures ----
const fx = (f) => JSON.parse(readFileSync(`test/fixtures/jev/${f}`, "utf8"));
const corpus = fx("corpus.json").notes;
const byLink = new Map(corpus.map((n) => [n.permalink, n]));
const obsOf = (body) => [...body.matchAll(/^- \[([^\]]+)\] (.+)$/gm)].map((m) => ({ category: m[1], content: m[2] }));
const inSplit = (c) => SPLIT === "all" || c.split === SPLIT;
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : "n/a");

// ---- search ----
async function searchEval() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tags, tokenize = 'porter unicode61 remove_diacritics 2')");
  db.exec("CREATE VIRTUAL TABLE obs_fts USING fts5(category, content, tags, tokenize = 'porter unicode61 remove_diacritics 2')");
  const obsNote = [];
  corpus.forEach((n, i) => {
    db.prepare("INSERT INTO notes_fts (rowid, title, content, tags) VALUES (?, ?, ?, '')").run(i + 1, n.title, n.body);
    for (const o of obsOf(n.body)) {
      obsNote.push(i + 1);
      db.prepare("INSERT INTO obs_fts (rowid, category, content, tags) VALUES (?, ?, ?, '')").run(obsNote.length, o.category, o.content);
    }
  });
  const runFts = (e) => ({
    noteIds: db.prepare("SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts, 10.0, 1.0, 3.0) LIMIT 200").all(e).map((r) => r.id),
    obs: db
      .prepare("SELECT rowid AS id FROM obs_fts WHERE obs_fts MATCH ? ORDER BY bm25(obs_fts, 2.0, 1.0, 2.0) LIMIT 200")
      .all(e)
      .map((r) => ({ id: r.id, note_id: obsNote[r.id - 1] })),
  });
  const docVecs = (await run(EMBED_MODEL, { documents: corpus.map((n) => `${n.title}\n\n${n.body}`) })).data;
  const cos = (a, b) => {
    let d = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      d += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return d / Math.sqrt(na * nb);
  };

  const rows = [];
  for (const c of fx("search.json").cases.filter(inSplit)) {
    const { expr, terms } = P.ftsQuery(c.query);
    const lists = [];
    const obsHits = new Map();
    if (expr) {
      let res = runFts(expr);
      if (terms.length > 1 && new Set([...res.noteIds, ...res.obs.map((o) => o.note_id)]).size < 10) {
        const or = runFts(P.ftsQuery(c.query, "OR").expr ?? expr);
        const seenN = new Set(res.noteIds);
        const seenO = new Set(res.obs.map((o) => o.id));
        res = { noteIds: [...res.noteIds, ...or.noteIds.filter((id) => !seenN.has(id))], obs: [...res.obs, ...or.obs.filter((o) => !seenO.has(o.id))] };
      }
      const ranked = [];
      const seen = new Set();
      for (let i = 0; i < Math.max(res.noteIds.length, res.obs.length); i++) {
        for (const id of [res.noteIds[i], res.obs[i]?.note_id]) {
          if (id !== undefined && !seen.has(id)) {
            seen.add(id);
            ranked.push(id);
          }
        }
      }
      for (const o of res.obs) obsHits.set(o.note_id, [...(obsHits.get(o.note_id) ?? []), o.id]);
      lists.push(ranked.map(String));
    }
    const qv = (await run(EMBED_MODEL, { queries: [terms.join(" ")] })).data[0];
    lists.push(
      docVecs
        .map((v, i) => ({ id: i + 1, s: cos(qv, v) }))
        .filter((x) => x.s > 0.2)
        .sort((a, b) => b.s - a.s)
        .map((x) => String(x.id)),
    );
    const fused = [...P.rrf(lists).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => corpus[Number(id) - 1]);
    const rrfOrder = fused.map((n) => n.permalink);
    const window = fused.slice(0, P.LIMITS.rerankCandidates);
    let reranked = rrfOrder;
    let any = null;
    if (terms.length && window.length >= P.LIMITS.rerankMinCandidates) {
      const lower = terms.map((t) => t.toLowerCase());
      const allObs = [];
      corpus.forEach((n) => {
        for (const o of obsOf(n.body)) allObs.push(o);
      });
      const req = P.rerankRequest(
        c.query,
        window.map((n) => {
          const idx = corpus.indexOf(n) + 1;
          return {
            permalink: n.permalink,
            title: n.title,
            type: n.type,
            matches: [
              ...P.matchLines(n.body.split("\n"), 0, lower).map((m) => m.text),
              ...(obsHits.get(idx) ?? []).slice(0, 3).map((oid) => `[${allObs[oid - 1].category}] ${allObs[oid - 1].content}`),
            ],
            body: n.body,
          };
        }),
      );
      const answers = await askJev(req);
      const included = window.slice(0, req.keys.size);
      const rel = new Map(included.map((n) => [n.permalink, P.expectedLevel(answers[`rel_${req.keys.get(n.permalink)}`]) ?? -1]));
      const rrfRank = new Map(included.map((n, i) => [n.permalink, i]));
      const top = [...included].sort((a, b) => rel.get(b.permalink) - rel.get(a.permalink) || rrfRank.get(a.permalink) - rrfRank.get(b.permalink));
      reranked = [...top.map((n) => n.permalink), ...rrfOrder.slice(included.length)];
      any = P.anyMatch ? P.anyMatch(answers, req.keys.values()) : P.noul(answers.any_match); // older builds asked a Noul
      if (VERBOSE) {
        console.error(`\n${c.id} ${c.query}  any_match=${any?.toFixed(2)}`);
        for (const n of top.slice(0, 5)) console.error(`  ${rel.get(n.permalink).toFixed(2)}  ${n.permalink}${c.relevant.includes(n.permalink) ? "  *" : ""}`);
      }
    }
    rows.push({ c, rrfOrder, reranked, any });
  }
  const pos = rows.filter((r) => r.c.relevant.length);
  const neg = rows.filter((r) => !r.c.relevant.length);
  const hitAt = (order, rel, k) => order.slice(0, k).some((p) => rel.includes(p));
  const count = (f) => pos.filter(f).length;
  const bands = (rs) => {
    const b = { yes: 0, unsure: 0, no: 0 };
    for (const r of rs) if (r.any !== null) b[P.band(r.any)]++;
    return b;
  };
  return {
    cases: rows.length,
    positives: pos.length,
    inWindow: count((r) => hitAt(r.rrfOrder, r.c.relevant, P.LIMITS.rerankCandidates)),
    rrf: { top1: count((r) => hitAt(r.rrfOrder, r.c.relevant, 1)), top3: count((r) => hitAt(r.rrfOrder, r.c.relevant, 3)) },
    rerank: { top1: count((r) => hitAt(r.reranked, r.c.relevant, 1)), top3: count((r) => hitAt(r.reranked, r.c.relevant, 3)) },
    anyMatch: { positives: bands(pos), negatives: bands(neg) },
    misses: pos.filter((r) => !hitAt(r.reranked, r.c.relevant, 1)).map((r) => `${r.c.id}: got ${r.reranked[0]}`),
  };
}

// ---- write hints ----
async function hintsEval() {
  const dup = { tp: 0, fp: 0, fn: 0, tpYes: 0, fpYes: 0, fnYes: 0 };
  const con = { tp: 0, fp: 0, fn: 0, tpYes: 0, fpYes: 0, fnYes: 0 };
  const errors = [];
  const tally = (t, expected, p, label) => {
    const shown = p !== null && P.band(p) !== "no";
    const yes = p !== null && P.band(p) === "yes";
    if (expected && shown) t.tp++;
    if (!expected && shown) t.fp++;
    if (expected && !shown) t.fn++;
    if (expected && yes) t.tpYes++;
    if (!expected && yes) t.fpYes++;
    if (expected && !yes) t.fnYes++;
    if (expected !== yes || expected !== shown) errors.push(`${label}: expected ${expected ? "flag" : "no flag"}, p=${p?.toFixed(2)}`);
  };
  for (const c of fx("hints.json").cases.filter(inSplit)) {
    const cands = c.candidates.map((x) => (typeof x === "string" ? byLink.get(x) : x)).map((n) => ({ ...n, observations: obsOf(n.body) }));
    const req = P.hintRequest(c.note, obsOf(c.note.body), cands, c.isNew);
    if (!req) continue;
    const answers = await askJev(req);
    if (c.isNew) for (const n of cands.slice(0, P.LIMITS.hintCandidates)) tally(dup, c.dup.includes(n.permalink), P.noul(answers[`dup_${req.keys.get(n.permalink)}`]), `${c.id} dup ${n.permalink}`);
    for (const pr of req.pairs) {
      const expected = c.conflicts.some(([a, b]) => a === pr.new && b === pr.old);
      tally(con, expected, P.noul(answers[`conflict_${pr.key}`]), `${c.id} ${c.kind}: "${pr.new}" vs "${pr.old}"`);
    }
  }
  const pr = (t, s = "") => ({ precision: pct(t[`tp${s}`], t[`tp${s}`] + t[`fp${s}`]), recall: pct(t[`tp${s}`], t[`tp${s}`] + t[`fn${s}`]) });
  return {
    duplicates: { "yes or unsure": pr(dup), "yes (shown to the user)": pr(dup, "Yes") },
    conflicts: { "yes or unsure": pr(con), "yes (shown to the user)": pr(con, "Yes") },
    errors,
  };
}

const out = { split: SPLIT, model: JEV_MODEL };
if (ONLY !== "hints") {
  const s = await searchEval();
  out.search = {
    cases: s.cases,
    "relevant note in the re-rank window": pct(s.inWindow, s.positives),
    "RRF only": { top1: pct(s.rrf.top1, s.positives), top3: pct(s.rrf.top3, s.positives) },
    "with Jev re-rank": { top1: pct(s.rerank.top1, s.positives), top3: pct(s.rerank.top3, s.positives) },
    "any_match bands (relevant / nothing relevant)": s.anyMatch,
    "re-rank top-1 misses": s.misses,
  };
}
if (ONLY !== "search") out.hints = await hintsEval();
out.usage = usage;
console.log(JSON.stringify(out, null, 2));
