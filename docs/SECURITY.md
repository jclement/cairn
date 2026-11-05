# Security

Cairn holds people's long-term memory, and AI assistants write to it. This document says what it
protects, against whom, how, and what it doesn't do yet. It describes the code on `main`.

## Reporting a vulnerability

Please report privately; don't open a public issue.

- **Preferred:** GitHub's private vulnerability reporting on this repository (*Security* →
  *Report a vulnerability*). *(The maintainer must turn it on in the repository's settings when
  it goes public.)*
- **Otherwise:** contact the maintainer, Jeff Clement, directly. *(A dedicated security contact
  address hasn't been chosen yet; this line is a placeholder until Jeff picks one.)*

If you run your own instance, you are its operator: the setup token, your Cloudflare account and
who you let sign up are yours to protect.

Include what you did, what happened, and what you expected. You'll get an acknowledgement within a
few days. Please give a reasonable time to fix before disclosure, and don't access other users'
data beyond what's needed to show the problem. There is no bug bounty.

## What is protected

- **Notes** (markdown, observations, relations, history) in per-project Durable Objects.
- **Attachments** in R2.
- **Accounts:** passkey public keys, hashed sessions, hashed recovery codes, hashed personal
  access tokens, OAuth grants (hashed by the OAuth library), inbox keys and trusted-sender lists.
- **Usage data:** counters, AI usage, audit log.

## Who we defend against

1. Someone on the internet without an account.
2. Another user of the same instance.
3. A malicious or compromised MCP client (or a prompt-injected assistant) holding a valid grant.
4. A malicious web page the user visits while signed in (CSRF, clickjacking, links).
5. Someone who sends email to the capture address.
6. Content in notes, clipped pages and attachments (it's untrusted: users and agents wrote it).

Out of scope: someone with control of the Cloudflare account or the deployer's machine; the
instance admin (who can't read notes through the app, but operates the infrastructure);
compromise of the user's own device or browser.

## Threat model and mitigations

| Threat | Mitigation in Cairn |
|---|---|
| **Phishing for login** | Passkeys only (WebAuthn, user verification required), bound to `PUBLIC_URL`'s hostname, so a lookalike domain gets nothing. No passwords, no email links. Recovery codes are the only phishable secret: 10, hashed, single-use, rate-limited, and they grant a 1-hour restricted session that can only add a passkey; adding one signs out every other session. |
| **Session theft / CSRF / clickjacking** | Opaque session tokens hashed in D1, in a `__Host-` HttpOnly Secure SameSite=Lax cookie; 30-day idle and 90-day absolute expiry. Every POST must carry `PUBLIC_URL`'s `Origin`. `frame-ancestors 'none'` and `X-Frame-Options: DENY`. GET routes don't change state (the clipper's GET only pre-fills a form). |
| **A stolen, still-signed-in session doing damage** | Downloads, account deletion, new recovery codes, adding or removing passkeys and creating tokens need a passkey re-check within the last 5 minutes. |
| **Cross-user access** | Every project is its own Durable Object, and the Worker resolves a project **by owner** in D1 before it ever gets a stub; attachment and API lookups are scoped the same way. Admins can disable accounts but have no route to anyone's notes. |
| **Consent phishing** (a link that authorizes a malicious client) | The consent page shows the client's name, its verified domain (client ID metadata documents) or "unverified", the redirect host, and a warning for loopback redirects; the user picks read or read+write. Grants are listed and revocable in Settings. |
| **Token theft** | 1-hour access tokens; refresh tokens rotate (30-day absolute, 14-day idle); tokens, grants and PATs stored hashed; PATs have a recognisable `cairn_pat_` prefix for secret scanning, optional expiry and a revoke button; tokens are audience-bound to this instance's `/mcp`. Disabling or deleting an account voids every token issued before. |
| **A malicious or prompt-injected agent** (memory poisoning) | Every write records who made it (user, app, tool) and keeps the prior revision; `/app/activity` shows every change, with one-click undo and "undo everything app X did since T". Read-only grants refuse writes. Writes are rate-limited (60/min) and size-limited. The MCP instructions tell agents that note content is data, not instructions. There is no sharing between users, so poisoning can't cross accounts. |
| **XSS through note or clipped content** | Markdown renders with raw HTML disabled; only `http(s)`, `mailto`, `memory://` and relative links survive; external links get `rel="noopener noreferrer nofollow"`. A strict CSP: `script-src 'self'`, `style-src 'self'` (no inline), no third-party scripts. Mermaid runs with `securityLevel: "strict"`; its SVG is stripped of scripts, `foreignObject` and event handlers. Tests cover `<script>`, `javascript:`, `onerror=`, mermaid click directives, footnotes and callouts. |
| **Malicious uploads** | The stored type comes from magic bytes or a short allowlist, never just the client's claim. Only PNG/JPEG/GIF/WebP/AVIF render inline; SVG, HTML and everything else download as attachments. Files are served only to their owner, with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`. |
| **SSRF through the clipper or `attach_file`** | Only http/https on default ports, no credentials in URLs; loopback, private, link-local, CGNAT, multicast, IPv6 local and metadata hosts are refused (numeric forms included); redirects are followed by hand and re-checked; size (5–10 MB) and time (10 s) caps. DNS rebinding is left to the `global_fetch_strictly_public` compatibility flag, which makes the runtime refuse private destinations. |
| **Spoofed email** | Unknown recipients are rejected generically. A message is accepted only with the user's secret inbox key (rotatable), or from a trusted sender when **Cloudflare's own** `Authentication-Results` (authserv-id `mx.cloudflare.net`, read from the delivery event, never from the message) shows DMARC pass or aligned DKIM pass; SPF alone isn't enough. 25 MB and 20-attachment caps, per-user rate limit, Message-ID dedupe. |
| **Resource abuse** | Per-IP rate limits on sign-up, sign-in, recovery, `/authorize`, `/oauth/token` and client registration; per-user limits on writes, searches, invites and clips. 1 MB per note, 50 MB per user (notes, history and attachments, with a per-file overhead charge), 20 projects, 5,000 files. A per-user daily AI token budget, charged before each AI call. |
| **Instance takeover at setup** | Nobody is an admin by default; admin requires the `CAIRN_SETUP_TOKEN` secret, compared in constant time. |
| **Data you can't take with you** | Export is a zip of plain markdown (and files), byte-for-byte as stored. Account deletion removes the projects' Durable Objects, vectors, files and directory rows, and is resumable. |

## Known limitations

- **No session list or "sign out everywhere"** yet; disabling an account, recovery, or deleting it
  are the ways to end every session.
- **No per-project grants:** an OAuth grant covers all of the user's projects.
- **No DPoP or sender-constrained tokens** (MCP clients don't support them); a stolen access token
  works until it expires (1 hour) or the grant is revoked.
- **Loopback redirects:** any local process can present Claude Code's public client ID and listen
  on a loopback port; the consent page warns, and the risk needs local code execution.
- **No WebAuthn attestation** or authenticator allowlist (any passkey provider is accepted).
- **Prompt injection is mitigated, not solved:** an agent with write access can still write
  misleading notes; provenance, history and undo are the defence.
- **The admin operates the infrastructure.** The app gives admins no way to read notes, but anyone
  with the Cloudflare account can read the Durable Objects and R2. Self-host if that matters.
- **Email trust** depends on Cloudflare prepending its `Authentication-Results`; this hasn't yet
  been checked against real routed mail.
- **Per-isolate limits:** the clipper's and converter's concurrency limits are per Worker isolate
  (best effort); the rate-limit bindings are the hard limits.
- Not independently audited. An internal review (Codex) has been run on each feature round; its
  reports are in the repository's lead notes.
