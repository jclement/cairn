// /auth/* JSON endpoints for passkey sign-up, sign-in, adding passkeys, recovery and logout.

import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  audit,
  clearSessionCookie,
  consumeRecoveryCode,
  createSession,
  createUser,
  deleteOtherSessions,
  deleteSession,
  getUserByName,
  inviteValid,
  issueRecoveryCodes,
  newId,
  normaliseUsername,
  SESSION_COOKIE,
  safeEqual,
  sessionCookie,
  USERNAME_RE,
} from "../directory";
import { openSignup, publicOrigin, rpId } from "../env";
import { sha256Hex } from "../vault/embed";
import { reauthFresh } from "../web/account";
import type { AppEnv } from "../web/types";
import { authenticationOptions, registrationOptions, type WebAuthnVerifier } from "./webauthn";

const CHALLENGE_TTL_MS = 5 * 60e3;

export function authRoutes(verifier: WebAuthnVerifier) {
  const app = new Hono<AppEnv>();

  async function storeChallenge(c: { env: AppEnv["Bindings"] }, kind: string, challenge: string, userId: string | null, data: unknown) {
    const id = newId();
    await c.env.DB.prepare("INSERT INTO challenges (id, challenge, kind, user_id, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, challenge, kind, userId, JSON.stringify(data ?? null), new Date(Date.now() + CHALLENGE_TTL_MS).toISOString())
      .run();
    // opportunistic cleanup
    await c.env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(new Date().toISOString()).run();
    return id;
  }

  async function takeChallenge(c: { env: AppEnv["Bindings"] }, id: unknown, kind: string) {
    if (typeof id !== "string") return null;
    const row = await c.env.DB.prepare("DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING *")
      .bind(id, kind)
      .first<{ challenge: string; user_id: string | null; data: string; expires_at: string }>();
    if (!row || Date.parse(row.expires_at) < Date.now()) return null;
    return { challenge: row.challenge, userId: row.user_id, data: JSON.parse(row.data) };
  }

  const ip = (c: { req: { header(n: string): string | undefined } }) => c.req.header("cf-connecting-ip") ?? null;

  // ---- sign up ----
  app.post("/signup/options", async (c) => {
    const body = await c.req.json<{ username?: string; invite?: string; setupToken?: string }>().catch(() => ({}) as Record<string, string>);
    const username = normaliseUsername(String(body.username ?? ""));
    if (!USERNAME_RE.test(username))
      return c.json({ error: "Usernames are 2-32 characters: letters, digits, dot, dash or underscore, starting with a letter or digit." }, 400);
    const setupOk = !!(c.env.CAIRN_SETUP_TOKEN && body.setupToken && safeEqual(body.setupToken, c.env.CAIRN_SETUP_TOKEN));
    const inviteOk = await inviteValid(c.env, body.invite);
    if (!openSignup(c.env) && !inviteOk && !setupOk) return c.json({ error: "Sign-up on this Cairn is by invitation. Ask an admin for an invite link." }, 403);
    if (await getUserByName(c.env, username)) return c.json({ error: "That username is taken." }, 409);
    const userHandle = crypto.getRandomValues(new Uint8Array(16));
    const options = await registrationOptions({ rpName: c.env.APP_NAME || "Cairn", rpID: rpId(c.env), userName: username, userID: userHandle, exclude: [] });
    const challengeId = await storeChallenge(c, "signup", options.challenge, null, { username, invite: inviteOk ? body.invite : null, admin: setupOk });
    return c.json({ challengeId, options });
  });

  app.post("/signup/verify", async (c) => {
    const body = await c.req.json<{ challengeId?: string; response?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    const ch = await takeChallenge(c, body.challengeId, "signup");
    if (!ch) return c.json({ error: "This sign-up attempt expired. Start again." }, 400);
    const { username, invite, admin } = ch.data as { username: string; invite: string | null; admin: boolean };
    let cred: Awaited<ReturnType<WebAuthnVerifier["verifyRegistration"]>>;
    try {
      cred = await verifier.verifyRegistration({
        // biome-ignore lint/suspicious/noExplicitAny: validated by the verifier
        response: body.response as any,
        expectedChallenge: ch.challenge,
        expectedOrigin: publicOrigin(c.env),
        expectedRPID: rpId(c.env),
      });
    } catch (e) {
      return c.json({ error: `Passkey could not be verified: ${(e as Error).message}` }, 400);
    }
    if (!cred) return c.json({ error: "Passkey could not be verified." }, 400);
    // Claim the invite and create the account atomically when sign-up needs the invite.
    const needsInvite = !openSignup(c.env) && !admin;
    if (needsInvite && !invite) return c.json({ error: "Sign-up on this Cairn is by invitation." }, 403);
    // With an invite (required or not), claim it in the same transaction so invited_by is recorded.
    let created = await createUser(c.env, username, admin, invite ? { inviteCode: invite } : {});
    // Open sign-up: an invite someone else just used doesn't block joining, it just isn't credited.
    if (!created.ok && created.reason === "invite" && !needsInvite) created = await createUser(c.env, username, admin);
    if (!created.ok) {
      return created.reason === "taken"
        ? c.json({ error: "That username is taken." }, 409)
        : c.json({ error: "This invite has already been used or has expired." }, 403);
    }
    const user = created.user;
    await insertCredential(c.env, user.id, cred, "first passkey");
    const codes = await issueRecoveryCodes(c.env, user.id);
    const token = await createSession(c.env, user.id, { userAgent: c.req.header("user-agent") });
    await audit(c.env, user.id, "signup", { admin }, ip(c));
    c.header("Set-Cookie", sessionCookie(token));
    return c.json({ ok: true, username: user.username, recoveryCodes: codes });
  });

  // ---- sign in (discoverable credentials) ----
  app.post("/login/options", async (c) => {
    const options = await authenticationOptions(rpId(c.env));
    const challengeId = await storeChallenge(c, "login", options.challenge, null, null);
    return c.json({ challengeId, options });
  });

  app.post("/login/verify", async (c) => {
    const body = await c.req.json<{ challengeId?: string; response?: { id?: string } }>().catch(() => ({}) as Record<string, never>);
    const ch = await takeChallenge(c, body.challengeId, "login");
    if (!ch) return c.json({ error: "This sign-in attempt expired. Try again." }, 400);
    const credId = body.response?.id;
    if (typeof credId !== "string") return c.json({ error: "Missing credential." }, 400);
    const row = await c.env.DB.prepare("SELECT * FROM credentials WHERE id = ?")
      .bind(credId)
      .first<{ id: string; user_id: string; public_key: ArrayBuffer; counter: number; transports: string | null }>();
    if (!row) return c.json({ error: "This passkey is not registered here." }, 400);
    const owner = await c.env.DB.prepare("SELECT disabled_at FROM users WHERE id = ?").bind(row.user_id).first<{ disabled_at: string | null }>();
    if (owner?.disabled_at) return c.json({ error: "This account is disabled. Contact the admin of this Cairn." }, 403);
    let res: { newCounter: number } | null;
    try {
      res = await verifier.verifyAuthentication({
        // biome-ignore lint/suspicious/noExplicitAny: validated by the verifier
        response: body.response as any,
        expectedChallenge: ch.challenge,
        expectedOrigin: publicOrigin(c.env),
        expectedRPID: rpId(c.env),
        credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports ?? "[]") },
      });
    } catch (e) {
      return c.json({ error: `Passkey could not be verified: ${(e as Error).message}` }, 400);
    }
    if (!res) return c.json({ error: "Passkey could not be verified." }, 400);
    await c.env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").bind(res.newCounter, new Date().toISOString(), row.id).run();
    const token = await createSession(c.env, row.user_id, { userAgent: c.req.header("user-agent") });
    await audit(c.env, row.user_id, "login", null, ip(c));
    c.header("Set-Cookie", sessionCookie(token));
    return c.json({ ok: true });
  });

  // ---- add a passkey (signed in, including a recovery session) ----
  // Enrolling a passkey grants a credential that can satisfy reauth, so an ordinary session needs a
  // fresh reauth with an EXISTING passkey, at options and again at verify. The only exception is a
  // recovery session (restricted), whose whole purpose is to enrol one. The challenge is bound to
  // the session that asked for it.
  const enrollGate = (c: Context<AppEnv>) => {
    const session = c.get("session");
    if (!session) return "Sign in first.";
    if (session.restricted) return null;
    return reauthFresh(session) ? null : "Confirm with one of your existing passkeys first.";
  };

  app.post("/passkey/options", async (c) => {
    const user = c.get("user");
    const token = c.get("sessionToken");
    if (!user || !token) return c.json({ error: "Sign in first." }, 401);
    const gate = enrollGate(c);
    if (gate) return c.json({ error: gate, reauth: "/app/reauth?next=%2Fapp%2Fsettings%2Faccount" }, 403);
    const existing = await c.env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?")
      .bind(user.id)
      .all<{ id: string; transports: string | null }>();
    const options = await registrationOptions({
      rpName: c.env.APP_NAME || "Cairn",
      rpID: rpId(c.env),
      userName: user.username,
      userID: new TextEncoder().encode(user.id),
      exclude: existing.results.map((r) => ({ id: r.id, transports: JSON.parse(r.transports ?? "[]") })),
    });
    const challengeId = await storeChallenge(c, "add-passkey", options.challenge, user.id, { session: await sha256Hex(token) });
    return c.json({ challengeId, options });
  });

  app.post("/passkey/verify", async (c) => {
    const user = c.get("user");
    const token = c.get("sessionToken");
    if (!user || !token) return c.json({ error: "Sign in first." }, 401);
    const body = await c.req.json<{ challengeId?: string; response?: unknown; name?: string }>().catch(() => ({}) as Record<string, never>);
    const ch = await takeChallenge(c, body.challengeId, "add-passkey");
    if (!ch || ch.userId !== user.id || (ch.data as { session?: string } | null)?.session !== (await sha256Hex(token))) {
      return c.json({ error: "This attempt expired. Try again." }, 400);
    }
    const gate = enrollGate(c);
    if (gate) return c.json({ error: gate, reauth: "/app/reauth?next=%2Fapp%2Fsettings%2Faccount" }, 403);
    let cred: Awaited<ReturnType<WebAuthnVerifier["verifyRegistration"]>>;
    try {
      cred = await verifier.verifyRegistration({
        // biome-ignore lint/suspicious/noExplicitAny: validated by the verifier
        response: body.response as any,
        expectedChallenge: ch.challenge,
        expectedOrigin: publicOrigin(c.env),
        expectedRPID: rpId(c.env),
      });
    } catch (e) {
      return c.json({ error: `Passkey could not be verified: ${(e as Error).message}` }, 400);
    }
    if (!cred) return c.json({ error: "Passkey could not be verified." }, 400);
    await insertCredential(c.env, user.id, cred, String(body.name ?? "").slice(0, 64) || "passkey");
    if (c.get("session")?.restricted) {
      // Recovery completes: sign out everywhere else and turn this into a normal session.
      await deleteOtherSessions(c.env, user.id, token);
      const t = Date.now();
      await c.env.DB.prepare("UPDATE sessions SET restricted = 0, expires_at = ?, absolute_expires_at = ? WHERE user_id = ?")
        .bind(new Date(t + 30 * 86400e3).toISOString(), new Date(t + 90 * 86400e3).toISOString(), user.id)
        .run();
      c.header("Set-Cookie", sessionCookie(token));
    }
    await audit(c.env, user.id, "passkey.add", null, ip(c));
    return c.json({ ok: true });
  });

  // ---- re-authentication (fresh passkey assertion for sensitive actions) ----
  app.post("/reauth/options", async (c) => {
    const user = c.get("user");
    const token = c.get("sessionToken");
    if (!user || !token || c.get("session")?.restricted) return c.json({ error: "Sign in with a passkey first." }, 401);
    const creds = await c.env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?")
      .bind(user.id)
      .all<{ id: string; transports: string | null }>();
    const options = await authenticationOptions(
      rpId(c.env),
      creds.results.map((r) => ({ id: r.id, transports: JSON.parse(r.transports ?? "[]") })),
    );
    const challengeId = await storeChallenge(c, "reauth", options.challenge, user.id, { issuedAt: new Date().toISOString(), session: await sha256Hex(token) });
    return c.json({ challengeId, options });
  });

  app.post("/reauth/verify", async (c) => {
    const user = c.get("user");
    const token = c.get("sessionToken");
    if (!user || !token || c.get("session")?.restricted) return c.json({ error: "Sign in with a passkey first." }, 401);
    const body = await c.req.json<{ challengeId?: string; response?: { id?: string } }>().catch(() => ({}) as Record<string, never>);
    const ch = await takeChallenge(c, body.challengeId, "reauth");
    const chData = (ch?.data ?? {}) as { issuedAt?: string; session?: string };
    if (!ch || ch.userId !== user.id || chData.session !== (await sha256Hex(token))) return c.json({ error: "This attempt expired. Try again." }, 400);
    const row = await c.env.DB.prepare("SELECT * FROM credentials WHERE id = ? AND user_id = ?")
      .bind(String(body.response?.id ?? ""), user.id)
      .first<{ id: string; public_key: ArrayBuffer; counter: number; transports: string | null; created_at: string }>();
    if (!row) return c.json({ error: "That passkey doesn't belong to this account." }, 400);
    // Only a passkey that already existed when this check began can satisfy it.
    if (!chData.issuedAt || row.created_at >= chData.issuedAt) return c.json({ error: "Use a passkey that was already on this account." }, 400);
    let res: { newCounter: number } | null;
    try {
      res = await verifier.verifyAuthentication({
        // biome-ignore lint/suspicious/noExplicitAny: validated by the verifier
        response: body.response as any,
        expectedChallenge: ch.challenge,
        expectedOrigin: publicOrigin(c.env),
        expectedRPID: rpId(c.env),
        credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports ?? "[]") },
      });
    } catch (e) {
      return c.json({ error: `Passkey could not be verified: ${(e as Error).message}` }, 400);
    }
    if (!res) return c.json({ error: "Passkey could not be verified." }, 400);
    const at = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").bind(res.newCounter, at, row.id),
      c.env.DB.prepare("UPDATE sessions SET reauth_at = ? WHERE id_hash = ?").bind(at, await sha256Hex(token)),
    ]);
    return c.json({ ok: true });
  });

  // ---- recovery ----
  app.post("/recover", async (c) => {
    const body = await c.req.json<{ username?: string; code?: string }>().catch(() => ({}) as Record<string, string>);
    const user = body.username ? await getUserByName(c.env, body.username) : null;
    const okCode = !!user && !!body.code && (await consumeRecoveryCode(c.env, user.id, body.code));
    if (!user || !okCode) {
      await audit(c.env, user?.id ?? null, "recover.fail", null, ip(c));
      return c.json({ error: "That username and recovery code don't match." }, 400);
    }
    const token = await createSession(c.env, user.id, { restricted: true, userAgent: c.req.header("user-agent") });
    await audit(c.env, user.id, "recover", null, ip(c));
    c.header("Set-Cookie", sessionCookie(token, 3600));
    return c.json({ ok: true, next: "/app/settings?recovered=1" });
  });

  app.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(c.env, token);
    c.header("Set-Cookie", clearSessionCookie());
    return c.redirect("/", 303);
  });

  return app;
}

async function insertCredential(
  env: AppEnv["Bindings"],
  userId: string,
  cred: { id: string; publicKey: Uint8Array; counter: number; transports: string[]; deviceType: string; backedUp: boolean },
  name: string,
) {
  await env.DB.prepare(
    "INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      cred.id,
      userId,
      cred.publicKey,
      cred.counter,
      JSON.stringify(cred.transports),
      cred.deviceType,
      cred.backedUp ? 1 : 0,
      name,
      new Date().toISOString(),
    )
    .run();
}
