import "server-only";
import { compare, hash } from "bcrypt";

const SALT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, passwordHash: string): Promise<boolean> {
  return compare(plain, passwordHash);
}

/**
 * Password policy for locally-managed accounts (there is no external IdP).
 * Length is the dominant factor, so the rule is generous on composition and
 * strict on length.
 */
export const PASSWORD_MIN_LENGTH = 10;

export function validatePasswordStrength(
  password: string,
): { ok: true } | { ok: false; message: string } {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    };
  }
  if (!/[a-z]/i.test(password)) {
    return { ok: false, message: "Password must contain at least one letter." };
  }
  if (!/\d/.test(password)) {
    return { ok: false, message: "Password must contain at least one number." };
  }
  return { ok: true };
}
