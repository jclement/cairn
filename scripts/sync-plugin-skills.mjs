// Copy skills/ into plugin/skills/ (the plugin must be self-contained) and generate
// src/setup/skills.gen.ts (the Worker serves the same files at /skills/*). With --check, only
// verify both match skills/ (used by `mise run lint`, read-only).
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const src = "skills";
const dst = "plugin/skills";
const gen = "src/setup/skills.gen.ts";
const files = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter((f) => statSync(join(dir, f)).isFile())
        .sort()
    : [];

function generated() {
  const skills = readdirSync(src)
    .filter((d) => existsSync(join(src, d, "SKILL.md")))
    .sort()
    .map((name) => {
      const body = readFileSync(join(src, name, "SKILL.md"), "utf8");
      const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
      return { name, description, body };
    });
  return `// Generated from skills/ by scripts/sync-plugin-skills.mjs (\`mise run plugin:sync\`). Do not edit.\n// \`mise run lint\` fails if this drifts from skills/.\nexport const SKILLS: { name: string; description: string; body: string }[] = ${JSON.stringify(skills, null, 2)};\n`;
}

if (process.argv.includes("--check")) {
  const a = files(src);
  const b = files(dst);
  const bad = a.length !== b.length || a.some((f, i) => f !== b[i] || readFileSync(join(src, f), "utf8") !== readFileSync(join(dst, f), "utf8"));
  if (bad) {
    console.error("plugin/skills is out of date with skills/: run `mise run plugin:sync`");
    process.exit(1);
  }
  if (!existsSync(gen) || readFileSync(gen, "utf8") !== generated()) {
    console.error(`${gen} is out of date with skills/: run \`mise run plugin:sync\``);
    process.exit(1);
  }
  console.log(`plugin skills and ${gen} in sync (${a.length} files)`);
} else {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  writeFileSync(gen, generated());
  console.log(`synced ${files(dst).length} files into ${dst} and ${gen}`);
}
