// Adversarial probe for the Picoschema field-key parser, with an isolated deadline: the real
// module is bundled in memory and run in a worker thread that is terminated after DEADLINE_MS.
// A synchronous runaway (catastrophic regex backtracking) can't be interrupted from inside, so it
// must run where it can be killed. Exit 0 = every case finished in time; 1 = a case timed out.
import { Worker } from "node:worker_threads";
import { build } from "esbuild";

const DEADLINE_MS = 2000;
const bundle = await build({
  entryPoints: [process.argv[2] ?? "src/schema/picoschema.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
});
const code = bundle.outputFiles[0].text;
const cases = [
  `x(object,${" ".repeat(30000)}!`,
  `x(object,${" ".repeat(199 - 9)}!`,
  `x(enum,${" , ".repeat(10000)}`,
  `x?((((((((((array))))))))))`,
  `x(${"(".repeat(30000)}`,
  `${"a".repeat(50000)}?(array`,
  `x(array,${"\t ".repeat(20000)})`,
];
const worker = new Worker(
  `
  import { parentPort } from "node:worker_threads";
  const mod = await import("data:text/javascript;base64," + ${JSON.stringify(Buffer.from(code).toString("base64"))});
  parentPort.on("message", (cases) => {
    for (const [i, k] of cases.entries()) {
      parentPort.postMessage({ start: i });
      mod.parseFieldKey(k);
      try { mod.parsePicoschema({ [k]: "string" }); } catch {}
      parentPort.postMessage({ done: i });
    }
    // Work-budget cases (review-schemafix finding 1): frontmatter arrays can't multiply the checks.
    if (mod.validateNote && mod.diffSchema) {
      const big = Array.from({ length: 100000 }, () => "bad");
      const note = (fm) => ({ permalink: "n", title: "n", file_path: "n.md", type: "t", frontmatter: fm, observations: [], relations: [] });
      parentPort.postMessage({ start: "validate-200-fields-x-100k" });
      const fields = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["f" + i + "(array)", "integer"]));
      const fm = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["f" + i, big]));
      mod.validateNote(note(fm), mod.parseSchemaNote({ entity: "t", schema: fields }, "s"));
      parentPort.postMessage({ start: "diff-500-notes-x-100k" });
      const two = mod.parseSchemaNote({ entity: "t", schema: { "x(array)": "integer", "y(array)": "integer" } }, "s");
      mod.diffSchema(two, "t", Array.from({ length: 500 }, () => note({ x: big, y: big })));
    }
    parentPort.postMessage({ all: true });
  });
  `,
  { eval: true, type: "module" },
);
let current = -1;
const timer = setTimeout(() => {
  console.error(`TIMEOUT: case ${current} did not finish within ${DEADLINE_MS} ms`);
  worker.terminate();
  process.exit(1);
}, DEADLINE_MS);
worker.on("message", (m) => {
  if ("start" in m) current = m.start;
  if (m.all) {
    clearTimeout(timer);
    console.log(`ok: ${cases.length} adversarial keys and the work-budget cases finished within ${DEADLINE_MS} ms`);
    worker.terminate();
  }
});
worker.on("error", (e) => {
  console.error(e);
  process.exit(1);
});
worker.postMessage(cases);
