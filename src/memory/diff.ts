// Line diff (LCS) for revision views. Bounded: very large inputs fall back to a coarse diff.

export type DiffOp = { op: "eq" | "del" | "add"; text: string; a?: number; b?: number };

export function diffLines(before: string, after: string, maxCells = 4_000_000): DiffOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // trim common prefix/suffix first
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: DiffOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ op: "eq", text: a[i], a: i + 1, b: i + 1 });
  if (am.length * bm.length > maxCells) {
    for (let i = 0; i < am.length; i++) ops.push({ op: "del", text: am[i], a: pre + i + 1 });
    for (let j = 0; j < bm.length; j++) ops.push({ op: "add", text: bm[j], b: pre + j + 1 });
  } else {
    const n = am.length;
    const m = bm.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ op: "eq", text: am[i], a: pre + i + 1, b: pre + j + 1 });
        i++;
        j++;
      } else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) {
        ops.push({ op: "del", text: am[i], a: pre + i + 1 });
        i++;
      } else {
        ops.push({ op: "add", text: bm[j], b: pre + j + 1 });
        j++;
      }
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ op: "eq", text: a[a.length - suf + k], a: a.length - suf + k + 1, b: b.length - suf + k + 1 });
  return ops;
}

/** Lines added by a change (for digests). */
export function addedLines(before: string | null, after: string): string[] {
  if (before === null) return after.split("\n");
  return diffLines(before, after)
    .filter((o) => o.op === "add")
    .map((o) => o.text);
}
