import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/directory";
import { dateLabel, inWindow, isoWeekMonday, noteDate } from "../src/vault/notedate";
import { parseUntil } from "../src/vault/time";
import { caller, defaultVault, makeUser } from "./helpers";
import { callTool } from "./oauth";

describe("noteDate", () => {
  it("prefers a frontmatter date, then created", () => {
    expect(noteDate({ frontmatter: JSON.stringify({ date: "2026-06-17" }), title: "x", permalink: "daily/x" })).toEqual({ date: "2026-06-17", from: "date" });
    expect(noteDate({ frontmatter: { created: "2026-03-02T10:00:00Z" }, title: "x", permalink: "links/x" })).toEqual({ date: "2026-03-02", from: "created" });
  });
  it("falls back to a date or ISO week in the title, then the path", () => {
    expect(noteDate({ frontmatter: "{}", title: "Acme water tests review 2026-11-03", permalink: "meetings/x" })?.date).toBe("2026-11-03");
    expect(noteDate({ frontmatter: "{}", title: "Northwind", permalink: "meetings/2026-10-05-northwind" })).toEqual({ date: "2026-10-05", from: "path" });
    expect(noteDate({ frontmatter: "{}", title: "2026-W18", permalink: "weekly/2026-w18" })).toEqual({ date: "2026-04-27", from: "title", week: "2026-W18" });
  });
  it("is null when the note doesn't say, and ignores impossible dates", () => {
    expect(noteDate({ frontmatter: "{}", title: "Dana Whitlow", permalink: "people/dana-whitlow" })).toBeNull();
    expect(noteDate({ frontmatter: { date: "2026-02-30" }, title: "x", permalink: "x" })).toBeNull();
    expect(noteDate({ frontmatter: "not json", title: "x", permalink: "x" })).toBeNull();
  });
});

describe("isoWeekMonday", () => {
  it("maps ISO weeks to their Monday", () => {
    expect(isoWeekMonday(2026, 1)).toBe("2025-12-29");
    expect(isoWeekMonday(2026, 9)).toBe("2026-02-23");
    expect(isoWeekMonday(2026, 53)).toBe("2026-12-28");
    expect(isoWeekMonday(2025, 53)).toBeNull();
    expect(isoWeekMonday(2026, 0)).toBeNull();
  });
});

describe("dateLabel", () => {
  const imported = { created_at: "2026-11-04T22:00:00Z", updated_at: "2026-11-04T22:00:00Z" };
  it("says the note's own date, and a later edit", () => {
    expect(dateLabel({ frontmatter: { date: "2026-07-15" }, title: "2026-07-15", permalink: "daily/2026-07-15", ...imported })).toBe("dated 2026-07-15");
    expect(dateLabel({ frontmatter: "{}", title: "Dana Whitlow", permalink: "people/dana-whitlow", ...imported, updated_at: "2026-11-05T13:12:00Z" })).toBe(
      "edited 2026-11-05",
    );
    expect(dateLabel({ frontmatter: "{}", title: "Dana Whitlow", permalink: "people/dana-whitlow", ...imported })).toBe("");
    expect(dateLabel({ frontmatter: "{}", title: "2026-W09", permalink: "weekly/2026-w09", ...imported })).toBe("week 2026-W09 (from 2026-02-23)");
  });
});

describe("parseUntil", () => {
  it("reads dates and months inclusively, refuses junk", () => {
    expect(parseUntil("2026-09")).toBe("2026-09-30");
    expect(parseUntil("2026-02")).toBe("2026-02-28");
    expect(parseUntil("2026-09-15")).toBe("2026-09-15");
    expect(parseUntil("yesterday", Date.parse("2026-11-06T12:00:00Z"))).toBe("2026-11-05");
    expect(parseUntil("")).toBeNull();
    expect(parseUntil("2026-13")).toBeUndefined();
    expect(parseUntil("whenever")).toBeUndefined();
  });
});

describe("inWindow", () => {
  const imported = { created_at: "2026-11-04T22:00:00Z", updated_at: "2026-11-04T22:00:00Z" };
  const daily = { frontmatter: { date: "2026-07-15" }, title: "2026-07-15", permalink: "daily/2026-07-15", ...imported };
  const project = { frontmatter: {}, title: "Tie-ins", permalink: "projects/tie-ins", ...imported };
  it("places a dated note by its own date, not its import time", () => {
    expect(inWindow(daily, "2026-07-01T00:00:00.000Z", "2026-07-31")).toBe(true);
    expect(inWindow(daily, "2026-08-01T00:00:00.000Z", null)).toBe(false);
    expect(inWindow(daily, null, "2026-07-14")).toBe(false);
    // ...unless it was edited inside the window
    expect(inWindow({ ...daily, updated_at: "2026-11-06T09:00:00Z" }, "2026-11-01T00:00:00.000Z", null)).toBe(true);
  });
  it("places an undated note by its write time for since, and keeps it for until", () => {
    expect(inWindow(project, "2026-08-01T00:00:00.000Z", null)).toBe(true);
    expect(inWindow(project, "2026-11-05T00:00:00.000Z", null)).toBe(false);
    expect(inWindow(project, null, "2026-09-30")).toBe(true);
  });
});

describe("search by when", () => {
  it("filters on the note's own date, and labels each result with it", async () => {
    const { user } = await makeUser("when");
    const v = await defaultVault(user.id);
    const put = async (directory: string, title: string, content: string) => {
      const w = await v.stub.writeNote(v.ref, caller(user), { directory, title, content });
      if (!w.ok) throw new Error(w.message);
    };
    await put("daily", "2026-07-21", "---\ndate: 2026-07-21\n---\n# 2026-07-21\n\n- iOS app resubmitted after the location prompt fix");
    await put("daily", "2026-09-02", "---\ndate: 2026-09-02\n---\n# 2026-09-02\n\n- iOS app build numbering service deployed");
    await put("weekly", "2026-W09", "# 2026-W09\n\n- iOS app planning");
    await put("projects", "Mobile app", "# Mobile app\n\n- iOS app release tracking");

    const titles = async (a: Record<string, unknown>) => {
      const r = await v.stub.search(v.ref, { query: "iOS app", ...a });
      if (!r.ok) throw new Error(r.message);
      return r.value.hits.map((h) => h.title).sort();
    };
    expect(await titles({})).toEqual(["2026-07-21", "2026-09-02", "2026-W09", "Mobile app"]);
    // All four were written today; since/until go by each note's own date. The undated project note
    // passes since (written today) and until (date unknown).
    expect(await titles({ since: "2026-07-01", until: "2026-07" })).toEqual(["2026-07-21", "Mobile app"]);
    expect(await titles({ until: "2026-03" })).toEqual(["2026-W09", "Mobile app"]);
    expect(await titles({ since: "2026-08-15" })).toEqual(["2026-09-02", "Mobile app"]);

    const pat = await createPat(env, user.id, "t", ["memory:read"], null);
    const t = (await callTool(pat, "search_notes", { query: "iOS app" })).content[0].text as string;
    expect(t).toMatch(/2026-07-21 — daily\/2026-07-21 \| daily\/2026-07-21\.md \(note\) dated 2026-07-21; score/);
    expect(t).toContain("week 2026-W09 (from 2026-02-23);");
    expect(t).not.toMatch(/Mobile app — .*dated/);
    const bad = await callTool(pat, "search_notes", { query: "iOS", until: "someday" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('"someday" is not a date');
    const filterOnly = (await callTool(pat, "search_notes", { until: "2026-07-31", since: "2026-07-01" })).content[0].text as string;
    expect(filterOnly).toContain("daily/2026-07-21");
    expect(filterOnly).not.toContain("daily/2026-09-02");

    const list = (await callTool(pat, "list_notes", { path: "daily" })).content[0].text as string;
    expect(list).toContain("(daily/2026-07-21; note, dated 2026-07-21)");
    const found = (await callTool(pat, "find_notes", { name: "*W09*" })).content[0].text as string;
    expect(found).toContain("week 2026-W09 (from 2026-02-23)");
  });
});
