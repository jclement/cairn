// Browser bundles alias "yaml" here: the preview only needs splitFrontmatter()'s body, and the
// real parser would add ~90 KB. splitFrontmatter() treats a throw as "no frontmatter data".
export function parseDocument(): never {
  throw new Error("yaml is not bundled in the browser");
}
export function stringify(): never {
  throw new Error("yaml is not bundled in the browser");
}
// Type guards used by setFrontmatter (never reached in the browser: parseDocument throws first).
export function isMap(): boolean {
  return false;
}
export function isNode(): boolean {
  return false;
}
export function isScalar(): boolean {
  return false;
}
