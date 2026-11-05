// Fetching user-supplied URLs (clipper, attach_file) without becoming an SSRF proxy.
//
// Layers: (1) only http/https on default ports; (2) hostnames that are, or obviously name, private
// / loopback / link-local / metadata addresses are refused here; (3) redirects are followed by
// hand (max 5) and every hop is re-checked; (4) size and time caps. DNS rebinding (a public name
// resolving to a private address) can't be checked from a Worker; in production the
// `global_fetch_strictly_public` compatibility flag (set in wrangler.jsonc) makes the runtime
// refuse private destinations, which covers that case. On top of that: names from well-known
// wildcard / rebinding DNS services, and any name that embeds a private IPv4 address (dotted,
// dashed or hex labels, as nip.io / sslip.io-style services resolve them), are refused here; and a
// non-2xx final response is a refusal, so an error page (for instance the runtime refusing a
// private destination) is never stored as content.

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

/** Public DNS services that resolve names to any address, loopback included (rebinding helpers). */
export const REBIND_SUFFIXES = [
  "nip.io",
  "sslip.io",
  "xip.io",
  "nip.direct",
  "localtest.me",
  "lvh.me",
  "vcap.me",
  "lacolhost.com",
  "traefik.me",
  "local.gd",
  "localh.st",
  "1u.ms",
  "rbndr.us",
  "fuf.me",
  "readme.localtest.me",
];

/** A private IPv4 address written into the name's labels: 127.0.0.1.x, app-10-0-0-5.x, 7f000001.x. */
function embedsPrivateIp(h: string): boolean {
  const labels = h.split(".");
  for (let i = 0; i + 4 <= labels.length; i++) {
    const four = labels.slice(i, i + 4);
    if (four.every((l) => /^\d{1,3}$/.test(l)) && ipv4Private(four.join("."))) return true;
  }
  for (const l of labels) {
    for (const m of l.matchAll(/(?:^|[^0-9])(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?=$|[^0-9])/g))
      if (ipv4Private(`${m[1]}.${m[2]}.${m[3]}.${m[4]}`)) return true;
    const hex = /(?:^|-)([0-9a-f]{8})$/.exec(l);
    if (hex) {
      const n = Number.parseInt(hex[1], 16);
      // Unicast private ranges only: hex-looking labels in ordinary names rarely decode to them.
      if (n >>> 24 < 224 && ipv4Private(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`)) return true;
    }
  }
  return false;
}

/** Numeric host forms browsers/URL parsers normalise (decimal, hex, octal) are already dotted by URL(). */
export function blockedHost(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return "empty host";
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (/\.(local|internal|intranet|lan|home|corp|localdomain)$/.test(h)) return "private name";
  if (h === "metadata.google.internal" || h === "metadata") return "metadata service";
  if (ipv4Private(h)) return "private address";
  if (REBIND_SUFFIXES.some((x) => h === x || h.endsWith(`.${x}`))) return "wildcard DNS name (can resolve to private addresses)";
  if (embedsPrivateIp(h)) return "name embeds a private address";
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
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel();
      // An error page is not the content (the runtime also answers this way for refused destinations).
      return { ok: false, code: "FETCH_FAILED", message: `The server answered ${res.status}; nothing was saved.` };
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
