// The one guard for post-login/reauth destinations (`next=`): only a same-origin path that starts
// with a single "/". public/app/cairn/passkey.js applies the same rule in the browser.

const BASE = "https://cairn.invalid";

/**
 * `raw` as a safe same-origin destination (path + query + hash), or `fallback`. Refuses anything a
 * browser could resolve to another origin: schemes, protocol-relative "//x", backslashes ("/\x"
 * is "//x" to a browser), encoded slashes or backslashes, control characters and whitespace.
 */
export function safeNext(raw: string | null | undefined, fallback = "/app"): string {
  if (typeof raw !== "string" || !raw || raw.length > 2048) return fallback;
  if (raw[0] !== "/" || raw[1] === "/") return fallback;
  if (/[\\\s]/.test(raw) || /%(2f|5c|09|0a|0d)/i.test(raw)) return fallback;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return fallback; // control characters
  }
  let u: URL;
  try {
    u = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (u.origin !== BASE || !u.pathname.startsWith("/") || u.pathname.startsWith("//")) return fallback;
  return u.pathname + u.search + u.hash;
}
