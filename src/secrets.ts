// Secret scanner: redacts credentials from text Cairn keeps verbatim (a note's original words, a
// logged search miss) before it is stored. Each hit becomes "[redacted]"; the caller says so in
// its receipt. Patterns: common key prefixes, PEM private keys, JWTs, `password:`/`token=` style
// assignments, and long random-looking strings. It errs towards redacting: a false positive costs
// a few characters of a note's original text, a miss stores a credential.

export const REDACTED = "[redacted]";

export interface Redaction {
  text: string;
  /** How many secrets were replaced. */
  count: number;
  /** What kinds were found (e.g. "github token"), without the values. */
  kinds: string[];
}

/** Whole-match patterns: the entire match is the secret. */
const WHOLE: { kind: string; re: RegExp }[] = [
  { kind: "private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "api key", re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g },
  { kind: "stripe key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "github token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "github token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: "aws key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "google key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: "bearer token", re: /\b(?<=Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g },
];

/**
 * `name: value` / `name = value` where the name says it is a secret: the value is redacted, the
 * name kept ("password: [redacted]"). A value in quotes runs to the closing quote.
 */
const ASSIGNMENT =
  /\b((?:[A-Za-z0-9_-]*[_-])?(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth))(\s*["']?\s*[:=]\s*)("[^"\n]{1,500}"|'[^'\n]{1,500}'|[^\s,;"'&]{1,500})/gi;

/** A long run of key-like characters (no slash, so URL paths and file paths aren't read as one). */
const LONG = /[A-Za-z0-9_+=-]{32,}/g;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Random-looking: mixed case and a digit (hex digests and UUIDs aren't), and high entropy. */
function looksRandom(s: string): boolean {
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9]/.test(s)) return false;
  return entropy(s) >= 4.2;
}

/** Redact every secret in `text`. Text without one comes back unchanged (same string). */
export function redactSecrets(text: string): Redaction {
  let out = text;
  let count = 0;
  const kinds = new Set<string>();
  const hit = (kind: string) => {
    count++;
    kinds.add(kind);
    return REDACTED;
  };
  for (const { kind, re } of WHOLE) out = out.replace(re, () => hit(kind));
  out = out.replace(ASSIGNMENT, (m, name: string, sep: string, value: string) => {
    const bare = value.replace(/^["']|["']$/g, "");
    // Already redacted, or a placeholder rather than a value.
    if (bare === REDACTED || bare.includes(REDACTED) || /^(\*+|x+|\.{3}|<[^>]*>|\$\{?[A-Z_]+\}?|null|none|true|false|required|optional)$/i.test(bare)) return m;
    const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
    return `${name}${sep}${q}${hit("password or token")}${q}`;
  });
  out = out.replace(LONG, (m) => (looksRandom(m) ? hit("random-looking string") : m));
  return count ? { text: out, count, kinds: [...kinds] } : { text, count: 0, kinds: [] };
}

/** One line for a receipt, e.g. "redacted 2 secrets (github token, password or token)". */
export function redactionLine(r: Pick<Redaction, "count" | "kinds">): string {
  return `redacted ${r.count} secret${r.count === 1 ? "" : "s"} (${r.kinds.join(", ")})`;
}
