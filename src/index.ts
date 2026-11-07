// Cairn Worker entry: one OAuthProvider wraps everything. /mcp is the protected API (stateless
// MCP over Streamable HTTP); every other path goes to the Hono app (viewer, passkeys, /authorize).

import { ExternalTokenError, OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { handleEmail } from "./capture/email";
import { runExtractionQueue } from "./capture/extract";
import { sweepUploadTickets } from "./capture/links";
import { resolvePat, touchUser } from "./directory";
import { type AuthProps, type Env, SCOPE_READ, SCOPE_WRITE } from "./env";
import { buildMcpServer } from "./mcp/server";
import { recordNightly } from "./memory/cron";
import { resolveSite, withCanonical } from "./site";
import { createApp } from "./web/app";

export { VaultDO } from "./vault/do";

/** The nightly maintenance trigger (wrangler.jsonc); any other cron only reads queued files. */
export const NIGHTLY_CRON = "0 3 * * *";

interface ApiCtx extends ExecutionContext {
  props: AuthProps;
  auth?: { scope: string[]; clientId?: string };
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ApiCtx): Promise<Response> {
    const props = ctx.props;
    const account = await env.DB.prepare("SELECT id, disabled_at, last_active_at, tokens_valid_after FROM users WHERE id = ?")
      .bind(props.userId)
      .first<{ id: string; disabled_at: string | null; last_active_at: string | null; tokens_valid_after: string | null }>();
    // Credentials issued at or before the account's cutoff (set when it was disabled) stay dead after re-enabling.
    const revokedByCutoff = !!account?.tokens_valid_after && (Number(props.issuedAt) || 0) <= Date.parse(account.tokens_valid_after);
    if (!account || account.disabled_at || revokedByCutoff) {
      return Response.json(
        { error: "invalid_token", error_description: "This account is disabled" },
        { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } },
      );
    }
    await touchUser(env, account);
    const scope = ctx.auth?.scope?.length ? ctx.auth.scope : ((props.scope as string[] | undefined) ?? []);
    if (!scope.includes(SCOPE_READ) && !scope.includes(SCOPE_WRITE)) {
      return new Response(JSON.stringify({ error: "insufficient_scope", error_description: "memory:read is required" }), {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${SCOPE_READ}"`,
        },
      });
    }
    const handler = createMcpHandler(
      () =>
        buildMcpServer(env, {
          userId: props.userId,
          username: props.username,
          clientName: props.clientName || "MCP client",
          scope,
        }),
      {
        route: "/mcp",
        authContext: { props },
        allowedHostnames: [new URL(env.PUBLIC_URL).hostname],
        corsOptions: false,
      },
    );
    return handler(request, env, ctx);
  },
};

export function providerOptions(env: Env, app = createApp()): OAuthProviderOptions<Env> {
  const origin = new URL(env.PUBLIC_URL).origin;
  return {
    apiRoute: "/mcp",
    // biome-ignore lint/suspicious/noExplicitAny: the provider's handler type is broader than ours
    apiHandler: mcpApiHandler as any,
    // biome-ignore lint/suspicious/noExplicitAny: Hono app satisfies ExportedHandler
    defaultHandler: app as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [SCOPE_READ, SCOPE_WRITE, "offline_access"],
    // What clients are told to request (protected-resource metadata and the 401 challenge). Claude
    // requests exactly these, so advertising read and write makes the consent page offer both, with
    // write ticked; the user can untick it. Advertised, not enforced: mcpApiHandler checks scopes.
    requiredScopes: [SCOPE_READ, SCOPE_WRITE],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86400,
    refreshTokenIdleTTL: 14 * 86400,
    resolveExternalToken: async ({ token }) => {
      const pat = await resolvePat(env, token);
      if (!pat) return null;
      if (!pat.scope.includes(SCOPE_READ)) {
        throw new ExternalTokenError("insufficient_scope", { description: "This token lacks memory:read", statusCode: 403, requiredScopes: [SCOPE_READ] });
      }
      const props: AuthProps = { userId: pat.user.id, username: pat.user.username, clientName: `token: ${pat.name}`, scope: pat.scope, issuedAt: pat.issuedAt };
      return { props, audience: `${origin}/mcp` };
    },
  };
}

/** Per-IP limits applied before the OAuth provider does any work (KV, CIMD fetches). */
export async function rateLimit(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rule =
    path === "/oauth/register" && request.method === "POST"
      ? { binding: env.RL_OAUTH, key: `register:${ip}`, what: "registrations" }
      : path === "/oauth/token"
        ? { binding: env.RL_TOKEN, key: `token:${ip}`, what: "token requests" }
        : path === "/authorize"
          ? { binding: env.RL_AUTHORIZE, key: `authorize:${ip}`, what: "authorization requests" }
          : null;
  if (!rule?.binding) return null;
  const { success } = await rule.binding.limit({ key: rule.key });
  if (success) return null;
  return Response.json(
    { error: "temporarily_unavailable", error_description: `Too many ${rule.what}; wait a minute.` },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}

// The provider's options depend on env (PUBLIC_URL), so build it per isolate on first request.
let cached: { url: string; provider: OAuthProvider<Env> } | null = null;

/** For responses that set no policy of their own (JSON errors, OAuth endpoints, MCP): nothing may load. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Every response leaves with the baseline security headers: the web app sets its own (and its
 * pages' CSP is kept); the OAuth provider's endpoints, MCP and rate-limit answers get them here.
 */
export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101 || (res as Response & { webSocket?: unknown }).webSocket) return res;
  const out = new Response(res.body, res);
  const set = (k: string, v: string) => {
    if (!out.headers.has(k)) out.headers.set(k, v);
  };
  out.headers.set("X-Content-Type-Options", "nosniff");
  set("Referrer-Policy", "same-origin");
  set("X-Frame-Options", "DENY");
  set("Content-Security-Policy", API_CSP);
  return out;
}

export default {
  async fetch(request: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    const limited = await rateLimit(request, rawEnv);
    if (limited) return withSecurityHeaders(limited);
    // The canonical URL (configured, recorded at the claim, or the request's before the claim), a
    // redirect off a non-canonical host, or "not claimed yet" (src/site.ts).
    const site = await resolveSite(request, rawEnv);
    if (site.response) return withSecurityHeaders(site.response);
    const env = site.env;
    if (!cached || cached.url !== env.PUBLIC_URL) cached = { url: env.PUBLIC_URL, provider: new OAuthProvider<Env>(providerOptions(env)) };
    return withSecurityHeaders(await cached.provider.fetch(request, env, ctx));
  },
  /** Cloudflare Email Routing: mail to INBOUND_EMAIL_ADDRESS becomes notes (src/capture/email.ts). */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, await withCanonical(env));
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Every 15 minutes: read queued files' text (uploads whose inline read didn't finish, backfills,
    // files waiting for the next day's AI budget). The nightly run does that too, after its work.
    if (controller.cron !== NIGHTLY_CRON) {
      ctx.waitUntil(
        withCanonical(env)
          .then((e) => runExtractionQueue(e))
          .then(() => undefined),
      );
      return;
    }
    ctx.waitUntil(
      withCanonical(env)
        .then(async (e) => {
          await recordNightly(e, new Date(controller.scheduledTime));
          await sweepUploadTickets(e).catch(() => 0);
          await runExtractionQueue(e).catch(() => undefined);
        })
        .then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;
