// The browser copy of src/web/next.ts: only a same-origin path starting with a single "/".
// test/secfix1.test.ts runs the same bypass table against both.
export function safeNext(raw, fallback, origin) {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return fallback;
  if (raw[0] !== "/" || raw[1] === "/") return fallback;
  if (/[\\\s]/.test(raw) || /%(2f|5c|09|0a|0d)/i.test(raw)) return fallback;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return fallback; // control characters
  }
  let u;
  try {
    u = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (u.origin !== origin || u.pathname.startsWith("//")) return fallback;
  return u.pathname + u.search + u.hash;
}
