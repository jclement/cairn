import { env } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeUser } from "./helpers";
import { fetchWorker } from "./oauth";

// Every skill in skills/, discovered at build time, so adding a skill never needs a test edit.
const REPO: Record<string, string> = Object.fromEntries(
  Object.entries(
    (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob("../skills/*/SKILL.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ).map(([path, text]) => [path.split("/")[2] as string, text]),
);
const origin = new URL(env.PUBLIC_URL).origin;

describe("one-line setup flow", () => {
  it("serves /setup.md publicly as markdown, addressed to this instance", async () => {
    const res = await fetchWorker("/setup.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const doc = await res.text();
    expect(doc).toContain(`${origin}/mcp`);
    expect(doc).toContain(`claude mcp add --transport http cairn ${origin}/mcp`);
    expect(doc).toContain(`codex mcp add cairn --url ${origin}/mcp`);
    expect(doc).toContain(`${origin}/skills/index.json`);
    for (const step of ["projects", "core_memory", "memory/how-i-use-cairn", "pinned", "undo"]) expect(doc).toContain(step);
    for (const name of Object.keys(REPO)) expect(doc).toContain(name);
  });

  it("serves each skill exactly as in skills/, and lists them in index.json", async () => {
    const idx = (await (await fetchWorker("/skills/index.json")).json()) as {
      skills: { name: string; url: string; zip: string }[];
      bundle: string;
      useCases: { skills: string[] }[];
    };
    expect(idx.skills.map((s) => s.name).sort()).toEqual(Object.keys(REPO).sort());
    expect(idx.bundle).toBe(`${origin}/skills/cairn-skills.zip`);
    for (const u of idx.useCases) for (const s of u.skills) expect(REPO[s]).toBeDefined();
    for (const s of idx.skills) {
      expect(s.url).toBe(`${origin}/skills/${s.name}/SKILL.md`);
      const res = await fetchWorker(`/skills/${s.name}/SKILL.md`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(await res.text()).toBe(REPO[s.name]);
    }
    expect((await fetchWorker("/skills/nope/SKILL.md")).status).toBe(404);
    expect((await fetchWorker("/skills/nope.zip")).status).toBe(404);
  });

  it("zips contain the repo's skill files", async () => {
    const res = await fetchWorker("/skills/cairn-skills.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(
      Object.keys(REPO)
        .map((n) => `${n}/SKILL.md`)
        .sort(),
    );
    for (const [n, body] of Object.entries(REPO)) expect(strFromU8(files[`${n}/SKILL.md`])).toBe(body);
    const one = unzipSync(new Uint8Array(await (await fetchWorker("/skills/cairn-notes.zip")).arrayBuffer()));
    expect(Object.keys(one)).toEqual(["cairn-notes/SKILL.md"]);
    expect(strFromU8(one["cairn-notes/SKILL.md"])).toBe(REPO["cairn-notes"]);
  });

  it("shows the copyable setup line in Settings → Connect and on the home page", async () => {
    const line = `Set up Cairn for me: read ${origin}/setup.md and follow it.`;
    const { cookie } = await makeUser();
    const settings = await (await fetchWorker("/app/settings", { headers: { cookie } })).text();
    expect(settings).toContain(line);
    const home = await (await fetchWorker("/app", { headers: { cookie } })).text();
    expect(home).toContain(line);
  });
});
