// Fetching user-supplied URLs (clipper, attach_file) without becoming an SSRF proxy.
//
// Layers: (1) only http/https on default ports; (2) hostnames that are, or obviously name, private
// / loopback / link-local / metadata addresses are refused here; (3) redirects are followed by
// hand (max 5) and every hop is re-checked; (4) size and time caps. DNS rebinding (a public name
// resolving to a private address) can't be checked from a Worker; in production the
// `global_fetch_strictly_public` compatibility flag (set in wrangler.jsonc) makes the runtime
// refuse private destinations, which covers that case.

export const FETCH_LIMITS = { bytes: 5 * 1024 * 1024, timeoutMs: 10_000, redirects: 5 };

export type SafeFetchResult =
  | { ok: true; url: string; status: number; contentType: string; bytes: Uint8Array; truncated: boolean }
  | { ok: false; code: "BLOCKED" | "INVALID" | "TOO_LARGE" | "FETCH_FAILED" | "TIMEOUT"; message: string };

function ipv4Private(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Numeric host forms browsers/URL parsers normalise (decimal, hex, octal) are already dotted by URL(). */
export function blockedHost(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return "empty host";
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (/\.(local|internal|intranet|lan|home|corp|localdomain)$/.test(h)) return "private name";
  if (h === "metadata.google.internal" || h === "metadata") return "metadata service";
  if (ipv4Private(h)) return "private address";
  if (h.startsWith("[") || h.includes(":")) {
    const v6 = h.replace(/^\[|\]$/g, "");
    if (v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6)) return "private address";
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (mapped) {
      const v4 =
        mapped.length === 2
          ? mapped[1]
          : (() => {
              const hi = Number.parseInt(mapped[1], 16);
              const lo = Number.parseInt(mapped[2], 16);
              return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
            })();
      if (ipv4Private(v4)) return "private address";
    }
  }
  return null;
}

export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, message: "Not a valid URL." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, message: "Only http and https URLs can be fetched." };
  if (u.username || u.password) return { ok: false, message: "URLs with credentials are refused." };
  if (u.port && !((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80"))) {
    return { ok: false, message: "Only the default ports (80, 443) are allowed." };
  }
  const why = blockedHost(u.hostname);
  if (why) return { ok: false, message: `Refused: ${why}.` };
  return { ok: true, url: u };
}

export async function safeFetch(raw: string, opts: { accept?: string; maxBytes?: number; fetcher?: typeof fetch } = {}): Promise<SafeFetchResult> {
  const max = opts.maxBytes ?? FETCH_LIMITS.bytes;
  const doFetch = opts.fetcher ?? fetch;
  let current = raw;
  const signal = AbortSignal.timeout(FETCH_LIMITS.timeoutMs);
  for (let hop = 0; hop <= FETCH_LIMITS.redirects; hop++) {
    const c = checkUrl(current);
    if (!c.ok) return { ok: false, code: hop ? "BLOCKED" : c.message.startsWith("Refused") ? "BLOCKED" : "INVALID", message: c.message };
    let res: Response;
    try {
      res = await doFetch(c.url.toString(), {
        redirect: "manual",
        signal,
        headers: { accept: opts.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "user-agent": "Cairn-Clipper/1.0 (+self-hosted)" },
      });
    } catch (e) {
      const name = (e as Error).name;
      return name === "TimeoutError" || name === "AbortError"
        ? { ok: false, code: "TIMEOUT", message: "The page took too long to respond." }
        : { ok: false, code: "FETCH_FAILED", message: `Could not fetch: ${(e as Error).message}` };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location") as string, c.url).toString();
      await res.body?.cancel();
      continue;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > max) {
      await res.body?.cancel();
      return { ok: false, code: "TOO_LARGE", message: `The response is ${declared} bytes; the limit is ${max}.` };
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > max) {
            truncated = true;
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      } catch {
        return { ok: false, code: "TIMEOUT", message: "The page took too long to respond." };
      }
    }
    const bytes = new Uint8Array(chunks.reduce((n, x) => n + x.byteLength, 0));
    let o = 0;
    for (const ch of chunks) {
      bytes.set(ch, o);
      o += ch.byteLength;
    }
    return { ok: true, url: c.url.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", bytes, truncated };
  }
  return { ok: false, code: "BLOCKED", message: "Too many redirects." };
}
