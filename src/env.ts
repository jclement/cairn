import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { VaultDO } from "./vault/do";

export const VERSION = "0.1.0";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS?: Fetcher;
  VAULT: DurableObjectNamespace<VaultDO>;
  AI?: Ai;
  VECTORIZE?: Vectorize;
  RL_AUTH?: RateLimit;
  RL_OAUTH?: RateLimit;
  /** Per-IP: GET/POST /authorize. */
  RL_AUTHORIZE?: RateLimit;
  /** Per-IP: /oauth/token. */
  RL_TOKEN?: RateLimit;
  /** Per-user: MCP writes. */
  RL_WRITE?: RateLimit;
  OAUTH_PROVIDER: OAuthHelpers;
  APP_NAME: string;
  PUBLIC_URL: string;
  OPEN_SIGNUP?: string;
  EMBEDDING_MODEL?: string;
  /** Secret. Whoever presents it at signup or in settings becomes an admin. */
  CAIRN_SETUP_TOKEN?: string;
  /** Jev model on Workers AI. Default "typesafe/jev"; "" turns Jev off. */
  JEV_MODEL?: string;
  /** Workers AI text model for weekly digests. Default @cf/google/gemma-4-26b-a4b-it; "" turns digests' summaries off. */
  DIGEST_MODEL?: string;
  /** Test-only: "1" fake text model, "fail" always errors. */
  CAIRN_FAKE_LLM?: string;
  /** Per-user daily AI token budget (Jev, query embeddings). Default 1,000,000. */
  AI_DAILY_TOKENS?: string;
  /** Per-user: searches (MCP and browser). */
  RL_SEARCH?: RateLimit;
  /** Per-user: invite create/revoke. */
  RL_INVITE?: RateLimit;
  /** "true" turns on zip import (Settings → Import, /app/api/import). Default off. */
  IMPORT_ENABLED?: string;
  /** "true" also registers Basic Memory's bm_* tool names as aliases of Cairn's tools. Default off. */
  BM_COMPAT?: string;
  /** check_schema evaluation; "true" to enable (off in production until its parser is bounded). */
  SCHEMA_ENABLED?: string;
  /** Outstanding (unused) invites a non-admin may hold. Default 5. */
  INVITES_PER_USER?: string;
  /** Test-only: "1" deterministic fake Jev, "fail" always errors, "slow" never answers. */
  CAIRN_FAKE_JEV?: string;
  /** Test-only: "1" makes the AI budget store throw (set per vault via setJevTestMode). */
  CAIRN_FAULT_BUDGET?: string;
  /** Test-only: "1" enables VaultDO.setFaults (accounting failure injection). */
  CAIRN_TEST_HOOKS?: string;
  /** Test-only: "off" stops writes from scheduling the embedding alarm (tests call embedPending). */
  CAIRN_EMBED_ALARM?: string;
  /** Test-only: "1" makes vaults use the deterministic fake embedder + shared fake vector index. */
  CAIRN_FAKE_EMBEDDINGS?: string;
  /** R2 bucket for attachments (`cairn-files`). Without it, uploads and email attachments are refused/skipped. */
  FILES?: R2Bucket;
  /** Inbound address for email capture (e.g. "cairn@example.com"). Unset: the email section says it's off. */
  INBOUND_EMAIL_ADDRESS?: string;
  /** Workers AI vision model for image captions. Default @cf/meta/llama-4-scout-17b-16e-instruct; "" turns captions off. */
  VISION_MODEL?: string;
  /** Test-only: a fetch used by the clipper instead of the global one (passed via app.request env). */
  CAPTURE_FETCH?: typeof fetch;
  /** Test-only: "1" makes captions and toMarkdown deterministic fakes. */
  CAIRN_FAKE_CAPTURE_AI?: string;
  /** Dev-only: "1" enables GET /app/dev-login (headless UI checks). Set only in wrangler's `local` env. */
  DEV_LOGIN?: string;
}

/** Props stored in each OAuth grant (encrypted by the provider) and on PAT lookups. */
export interface AuthProps extends Record<string, unknown> {
  userId: string;
  username: string;
  clientName: string;
}

export const SCOPE_READ = "memory:read";
export const SCOPE_WRITE = "memory:write";

/** Who is acting: recorded as provenance on every write. */
export interface Caller {
  userId: string;
  username: string;
  client: string; // OAuth client name, "web", or "pat:<name>"
  tool: string; // MCP tool name or web action
}

export function publicOrigin(env: Env): string {
  return new URL(env.PUBLIC_URL).origin;
}

export function rpId(env: Env): string {
  return new URL(env.PUBLIC_URL).hostname;
}

export function openSignup(env: Env): boolean {
  return env.OPEN_SIGNUP === "true" || env.OPEN_SIGNUP === "1";
}

/** Default core-memory budget (bytes); per-user setting in users.core_budget. */
export const DEFAULT_CORE_BUDGET = 8192;

export const LIMITS = {
  noteBytes: 1024 * 1024,
  userBytes: 50 * 1024 * 1024,
  vaultsPerUser: 20,
};
