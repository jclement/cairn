import { describe, expect, it } from "vitest";
import { GLOB_MAX_LENGTH, globMatcher } from "../src/vault/filters";

describe("globMatcher (no regex, no catastrophic backtracking)", () => {
  it("matches like a glob, case-insensitively", () => {
    const m = (g: string, s: string) => globMatcher(g).test(s);
    expect(m("*.md", "Note.MD")).toBe(true);
    expect(m("*meeting*", "2026-11-04 Team Meeting.md")).toBe(true);
    expect(m("a?c", "abc")).toBe(true);
    expect(m("a?c", "ac")).toBe(false);
    expect(m("[abc]x", "bx")).toBe(true);
    expect(m("[a-c]x", "dx")).toBe(false);
    expect(m("[!a]x", "ax")).toBe(false);
    expect(m("[z-a]x", "mx")).toBe(false); // reversed range matches nothing, never throws
    expect(m("*", "")).toBe(true);
    expect(m("a**b", "a/x/b")).toBe(true);
    expect(m("[unclosed", "[unclosed")).toBe(true);
  });

  it("stays fast on the adversarial pattern that hung the regex version", () => {
    const pattern = `${"*a".repeat(10)}b`; // 10 stars: the most allowed
    const name = "a".repeat(300);
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) expect(globMatcher(pattern).test(name)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("refuses over-long and over-starred patterns", () => {
    expect(() => globMatcher("x".repeat(GLOB_MAX_LENGTH + 1))).toThrow();
    expect(() => globMatcher("*a".repeat(11))).toThrow();
  });
});
