// A minimal software passkey (ES256, "none" attestation, UV set) for tests, so the real
// @simplewebauthn/server verification runs on workerd end to end.

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function cbor(v: Cbor): number[] {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return [...head(3, b.length), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  if (Array.isArray(v)) return [...head(4, v.length), ...v.flatMap(cbor)];
  const out = head(5, v.size);
  for (const [k, val] of v) out.push(...cbor(k), ...cbor(val));
  return out;
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Raw r||s (64 bytes) -> DER ECDSA signature, as authenticators send it. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export class SoftAuthenticator {
  private counter = 0;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  private keys!: CryptoKeyPair;
  userHandle: Uint8Array | null = null;

  constructor(
    private rpId: string,
    private origin: string,
  ) {}

  async create(options: { challenge: string; user: { id: string } }) {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    this.userHandle = fromB64url(options.user.id);
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, fromB64url(jwk.x ?? "")],
      [-3, fromB64url(jwk.y ?? "")],
    ]);
    const authData = concat(
      await sha256(new TextEncoder().encode(this.rpId)),
      new Uint8Array([0x45]), // UP | UV | AT
      new Uint8Array([0, 0, 0, 0]),
      new Uint8Array(16), // aaguid
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      new Uint8Array(cbor(cose)),
    );
    const clientData = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const attestationObject = new Uint8Array(
      cbor(
        new Map<Cbor, Cbor>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      ),
    );
    const id = b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestationObject), transports: ["internal"] },
    };
  }

  async get(options: { challenge: string }) {
    this.counter++;
    const authData = concat(
      await sha256(new TextEncoder().encode(this.rpId)),
      new Uint8Array([0x05]), // UP | UV
      new Uint8Array([0, 0, 0, this.counter]),
    );
    const clientData = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const signed = concat(authData, await sha256(clientData));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    const id = b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(derSignature(raw)),
        userHandle: this.userHandle ? b64url(this.userHandle) : undefined,
      },
    };
  }
}
