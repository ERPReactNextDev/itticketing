import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { ServerConfigError } from "../server/http";

export const SESSION_COOKIE = "itd_session";

export type SessionClaims = {
  /** User document id. */
  sub: string;
  email: string;
  name: string;
  roleId: string;
  roleName: string;
  /** Session issue time (seconds). Used for idle-timeout enforcement. */
  iat?: number;
  exp?: number;
};

/**
 * `JWT_SECRET` is required. A weak or missing secret must fail loudly rather
 * than silently signing tokens with a guessable key.
 *
 * This is a *deployment* fault, not a user error, so it throws a
 * `ServerConfigError` that `handleApiError` reports verbatim. The previous
 * plain `Error` fell through to the generic 500 handler, which told the user
 * "Something went wrong" and sent them hunting for a credential problem that
 * did not exist - the real cause was a missing environment variable.
 */
function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new ServerConfigError(
      "The server is not configured: JWT_SECRET is missing from .env.local. " +
        "Add it (32+ characters) and restart, e.g. openssl rand -base64 48.",
    );
  }
  if (secret.length < 32) {
    throw new ServerConfigError(
      "The server is not configured: JWT_SECRET is only " +
        `${secret.length} characters. It must be at least 32 - regenerate it with ` +
        "openssl rand -base64 48 and restart.",
    );
  }
  // A constant secret (e.g. all one character) is length-valid but worthless.
  if (new Set(secret).size < 8) {
    throw new ServerConfigError(
      "The server is not configured: JWT_SECRET is not random enough. " +
        "Regenerate it with: openssl rand -base64 48",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(
  claims: Omit<SessionClaims, "iat" | "exp">,
  ttlMinutes: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, iat: now })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + Math.max(60, ttlMinutes) * 60)
    .sign(getSecret());
}

/** Verifies signature + expiry. Returns null for any invalid token. */
export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return payload as unknown as SessionClaims;
  } catch {
    return null;
  }
}

/** Seconds since the token was issued - drives idle-timeout checks. */
export function sessionAgeSeconds(claims: SessionClaims): number | null {
  if (typeof claims.iat !== "number") return null;
  return Math.floor(Date.now() / 1000) - claims.iat;
}