// Passkey ceremonies with @simplewebauthn/server. Settings per docs/research/auth.md #3:
// resident keys required, user verification required, algorithms -8/-7/-257, no attestation.
// The verify calls sit behind an adapter so tests can stand in for an authenticator.

import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

export const SUPPORTED_ALGS = [-8, -7, -257];

export interface VerifiedCredential {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
}

export interface WebAuthnVerifier {
  verifyRegistration(args: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRPID: string;
  }): Promise<VerifiedCredential | null>;
  verifyAuthentication(args: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRPID: string;
    credential: { id: string; publicKey: Uint8Array; counter: number; transports: string[] };
  }): Promise<{ newCounter: number } | null>;
}

export const simpleWebAuthnVerifier: WebAuthnVerifier = {
  async verifyRegistration({ response, expectedChallenge, expectedOrigin, expectedRPID }) {
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGS,
    });
    if (!v.verified) return null;
    const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
    return {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: (credential.transports ?? []) as string[],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    };
  },
  async verifyAuthentication({ response, expectedChallenge, expectedOrigin, expectedRPID, credential }) {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: credential.publicKey as Uint8Array<ArrayBuffer>,
        counter: credential.counter,
        // biome-ignore lint/suspicious/noExplicitAny: transports are stored as plain strings
        transports: credential.transports as any,
      },
    });
    return v.verified ? { newCounter: v.authenticationInfo.newCounter } : null;
  },
};

export function registrationOptions(args: {
  rpName: string;
  rpID: string;
  userName: string;
  userID: Uint8Array;
  exclude: { id: string; transports: string[] }[];
}) {
  return generateRegistrationOptions({
    rpName: args.rpName,
    rpID: args.rpID,
    userName: args.userName,
    userID: args.userID as Uint8Array<ArrayBuffer>,
    attestationType: "none",
    supportedAlgorithmIDs: SUPPORTED_ALGS,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    // biome-ignore lint/suspicious/noExplicitAny: transports are stored as plain strings
    excludeCredentials: args.exclude.map((c) => ({ id: c.id, transports: c.transports as any })),
  });
}

export function authenticationOptions(rpID: string, allow: { id: string; transports: string[] }[] = []) {
  return generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    // biome-ignore lint/suspicious/noExplicitAny: transports are stored as plain strings
    allowCredentials: allow.map((c) => ({ id: c.id, transports: c.transports as any })),
  });
}
