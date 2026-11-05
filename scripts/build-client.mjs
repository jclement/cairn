// Bundle the viewer's browser code: src/client/<page>.ts -> public/app/dist/<page>.js.
// The app's CSP is `script-src 'self'; style-src 'self'`, so everything is bundled (no CDNs), and the
// <style> tags some libraries inject at import time (force-graph, float-tooltip) are stripped here;
// their rules live in public/app/cairn/viewer.css instead.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const stripStyleInject = {
  name: "strip-style-inject",
  setup(b) {
    b.onLoad({ filter: /node_modules[\\/](force-graph|float-tooltip)[\\/].*\.m?js$/ }, async (args) => ({
      contents: (await readFile(args.path, "utf8")).replace(/^styleInject\(css_\w+\);$/m, ""),
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: ["app", "search", "editor", "graph", "mermaid"].map((n) => `src/client/${n}.ts`),
  outdir: "public/app/dist",
  bundle: true,
  format: "esm",
  splitting: false,
  minify: true,
  sourcemap: false,
  target: ["es2022", "chrome111", "firefox115", "safari16.4"],
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
  alias: { yaml: "./src/client/yaml-stub.ts" },
  plugins: [stripStyleInject],
});

for (const [file, out] of Object.entries(result.metafile.outputs)) {
  console.log(`${file.padEnd(32)} ${(out.bytes / 1024).toFixed(1).padStart(7)} KB`);
}

// Mermaid: copy the prebuilt ESM build (entry + lazily imported chunks), without source maps.
const MSRC = "node_modules/mermaid/dist";
const MOUT = "public/app/dist/mermaid";
await mkdir(`${MOUT}/chunks/mermaid.esm.min`, { recursive: true });
const strip = (s) => s.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, "\n");
await writeFile(`${MOUT}/mermaid.esm.min.mjs`, strip(await readFile(`${MSRC}/mermaid.esm.min.mjs`, "utf8")));
let mbytes = 0;
const chunks = (await readdir(`${MSRC}/chunks/mermaid.esm.min`)).filter((f) => f.endsWith(".mjs"));
for (const f of chunks) {
  const text = strip(await readFile(`${MSRC}/chunks/mermaid.esm.min/${f}`, "utf8"));
  mbytes += text.length;
  await writeFile(`${MOUT}/chunks/mermaid.esm.min/${f}`, text);
}
console.log(`${"public/app/dist/mermaid/ (lazy)".padEnd(32)} ${(mbytes / 1024).toFixed(1).padStart(7)} KB in ${chunks.length + 1} files`);
