// Frontmatter filters and file-name globs, with Basic Memory's semantics (search_notes / find_notes
// `filters`): {field: condition}, dot paths for nested fields; a condition is a value (equality),
// null (absent or null), a list (contains all), or an operator object ($gt $gte $lt $lte $in
// $between $contains $exists). Several operators on one field AND together. YAML scalars compare
// as strings, as Basic Memory normalises them; numbers compare numerically when both sides are.

export type Filters = Record<string, unknown>;

const OPS = new Set(["$gt", "$gte", "$lt", "$lte", "$in", "$between", "$contains", "$exists"]);

/** Bounds on one filters object, so a filter's own size never decides how much work a scan does. */
export const FILTER_LIMITS = { fields: 20, fieldChars: 100, pathDepth: 5, listItems: 50, stringChars: 500, totalBytes: 4096 };

function scalarProblem(v: unknown, where: string): string | null {
  if (v === null || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? null : `${where}: numbers must be finite`;
  if (typeof v === "string") return v.length <= FILTER_LIMITS.stringChars ? null : `${where}: strings are at most ${FILTER_LIMITS.stringChars} characters`;
  return `${where}: values must be strings, numbers, booleans or null`;
}

function listProblem(v: unknown, where: string): string | null {
  if (!Array.isArray(v)) return `${where} needs a list`;
  if (v.length > FILTER_LIMITS.listItems) return `${where}: lists hold at most ${FILTER_LIMITS.listItems} values`;
  for (const x of v) {
    const p = scalarProblem(x, where);
    if (p) return p;
  }
  return null;
}

/** Why a filters object can't be used, or null. Checked before any note is looked at. */
export function filtersProblem(filters: unknown): string | null {
  if (filters === null || typeof filters !== "object" || Array.isArray(filters)) return "filters must be an object of {field: condition}";
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(filters)).length;
  } catch {
    return "filters must be plain JSON";
  }
  if (size > FILTER_LIMITS.totalBytes) return `filters are at most ${FILTER_LIMITS.totalBytes} bytes`;
  const keys = Object.keys(filters as object);
  if (keys.length > FILTER_LIMITS.fields) return `at most ${FILTER_LIMITS.fields} filter fields`;
  for (const [field, cond] of Object.entries(filters as object)) {
    if (!field || field.length > FILTER_LIMITS.fieldChars || field.split(".").length > FILTER_LIMITS.pathDepth || field.split(".").some((p) => !p)) {
      return `bad filter field "${field.slice(0, 100)}" (dot paths of at most ${FILTER_LIMITS.pathDepth} parts)`;
    }
    if (Array.isArray(cond)) {
      const p = listProblem(cond, `filter on ${field}`);
      if (p) return p;
    } else if (cond && typeof cond === "object") {
      const ops = Object.keys(cond);
      if (!ops.length) return `filter on ${field} has no operator`;
      for (const op of ops) {
        if (!OPS.has(op)) return `unknown operator ${op} on ${field} (use ${[...OPS].join(", ")})`;
        const v = (cond as Record<string, unknown>)[op];
        const where = `${op} on ${field}`;
        let p: string | null;
        if (op === "$in") p = listProblem(v, where);
        else if (op === "$between") p = Array.isArray(v) && v.length === 2 ? listProblem(v, where) : `${where} needs [low, high]`;
        else if (op === "$exists") p = typeof v === "boolean" ? null : `${where} needs true or false`;
        else p = v === null ? `${where} needs a value` : scalarProblem(v, where);
        if (p) return p;
      }
    } else {
      const p = scalarProblem(cond, `filter on ${field}`);
      if (p) return p;
    }
  }
  return null;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const scalar = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v));
const lc = (v: unknown) => scalar(v).toLowerCase();

function eq(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return a.some((x) => eq(x, b));
  if (a === undefined || a === null) return b === null;
  return lc(a) === lc(b);
}

function cmp(a: unknown, b: unknown): number | null {
  if (a === undefined || a === null || Array.isArray(a)) return null;
  const na = Number(a);
  const nb = Number(b);
  if (typeof b !== "string" || /^-?\d+(\.\d+)?$/.test(b)) {
    if (!Number.isNaN(na) && !Number.isNaN(nb) && scalar(a).trim() !== "") return na - nb;
  }
  const sa = scalar(a);
  const sb = scalar(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function test(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === undefined || value === null;
  if (Array.isArray(cond)) {
    // contains-all; a scalar field matches a one-item list
    const have = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return cond.every((c) => have.some((h) => eq(h, c)));
  }
  if (typeof cond === "object") {
    for (const [op, arg] of Object.entries(cond as Record<string, unknown>)) {
      let ok: boolean;
      switch (op) {
        case "$exists":
          ok = (value !== undefined && value !== null) === arg;
          break;
        case "$in":
          ok = (arg as unknown[]).some((x) => eq(value, x));
          break;
        case "$contains":
          ok = Array.isArray(value) ? value.some((x) => eq(x, arg)) : value != null && lc(value).includes(lc(arg));
          break;
        case "$between": {
          const [lo, hi] = arg as unknown[];
          const a = cmp(value, lo);
          const b = cmp(value, hi);
          ok = a !== null && b !== null && a >= 0 && b <= 0;
          break;
        }
        default: {
          const c = cmp(value, arg);
          ok = c !== null && (op === "$gt" ? c > 0 : op === "$gte" ? c >= 0 : op === "$lt" ? c < 0 : c <= 0);
        }
      }
      if (!ok) return false;
    }
    return true;
  }
  return eq(value, cond);
}

/** True when the frontmatter object satisfies every filter (filters already checked by filtersProblem). */
export function matchFilters(frontmatter: Record<string, unknown>, filters: Filters): boolean {
  return compileFilters(filters)(frontmatter);
}

/** Filters as one predicate, with their arguments normalised once rather than per note. */
export function compileFilters(filters: Filters): (frontmatter: Record<string, unknown>) => boolean {
  const norm = (c: unknown): unknown => {
    if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x.toLowerCase() : x));
    if (typeof c === "string") return c.toLowerCase();
    if (c && typeof c === "object")
      return Object.fromEntries(
        Object.entries(c as Record<string, unknown>).map(([k, v]) => [
          k,
          k.startsWith("$") && k !== "$gt" && k !== "$gte" && k !== "$lt" && k !== "$lte" && k !== "$between" ? norm(v) : v,
        ]),
      );
    return c;
  };
  const checks = Object.entries(filters).map(([field, cond]) => ({ field, cond: norm(cond) }));
  return (fm) => checks.every(({ field, cond }) => test(getPath(fm, field), cond));
}

/** Longest glob accepted, and most '*' in one; bounds the matcher's worst case (O(name × pattern)). */
export const GLOB_MAX_LENGTH = 100;
export const GLOB_MAX_STARS = 10;

type GlobToken = { k: "star" } | { k: "any" } | { k: "lit"; c: string } | { k: "class"; neg: boolean; ranges: [string, string][] };

function parseGlob(glob: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (out.at(-1)?.k !== "star") out.push({ k: "star" }); // '**' == '*'
    } else if (ch === "?") out.push({ k: "any" });
    else if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        out.push({ k: "lit", c: "[" });
        continue;
      }
      let body = glob.slice(i + 1, close).toLowerCase();
      const neg = body.startsWith("!") || body.startsWith("^");
      if (neg) body = body.slice(1);
      const ranges: [string, string][] = [];
      for (let j = 0; j < body.length; j++) {
        const a = body[j] as string;
        if (body[j + 1] === "-" && j + 2 < body.length) {
          ranges.push([a, body[j + 2] as string]); // a reversed range like z-a matches nothing
          j += 2;
        } else ranges.push([a, a]);
      }
      out.push({ k: "class", neg, ranges });
      i = close;
    } else out.push({ k: "lit", c: ch.toLowerCase() });
  }
  return out;
}

function tokenMatches(t: GlobToken, c: string): boolean {
  if (t.k === "any") return true;
  if (t.k === "lit") return t.c === c;
  if (t.k === "class") {
    const hit = t.ranges.some(([a, b]) => a <= c && c <= b);
    return t.neg ? !hit : hit;
  }
  return false;
}

/**
 * A case-insensitive glob over a whole string ('*' any run of characters, '/' included; '?' one;
 * '[abc]', '[a-z]', '[!x]'). Greedy matching that remembers only the last '*': never exponential
 * (no regex, so no catastrophic backtracking), worst case O(text × pattern) with both lengths capped.
 * Throws INVALID-worthy errors for over-long or over-starred patterns.
 */
export function globMatcher(
  glob: string,
  limits: { maxLength: number; maxStars: number } = { maxLength: GLOB_MAX_LENGTH, maxStars: GLOB_MAX_STARS },
): { test(text: string): boolean } {
  if (glob.length > limits.maxLength) throw new Error(`glob is longer than ${limits.maxLength} characters`);
  const tokens = parseGlob(glob);
  if (tokens.filter((t) => t.k === "star").length > limits.maxStars) throw new Error(`glob has more than ${limits.maxStars} '*'`);
  return {
    test(raw: string): boolean {
      const s = raw.toLowerCase();
      let i = 0;
      let p = 0;
      let starP = -1;
      let mark = 0;
      while (i < s.length) {
        const t = tokens[p];
        if (t && t.k !== "star" && tokenMatches(t, s[i] as string)) {
          i++;
          p++;
        } else if (t && t.k === "star") {
          starP = p++;
          mark = i;
        } else if (starP !== -1) {
          p = starP + 1;
          i = ++mark;
        } else return false;
      }
      while (tokens[p]?.k === "star") p++;
      return p === tokens.length;
    },
  };
}
