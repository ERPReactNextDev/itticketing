import "server-only";
import { cookies } from "next/headers";
import { connectDB } from "../db/mongoose";
import { User, Role } from "../models";
import { normalizePermissions, type PermissionKey, type PermissionSet } from "../shared/permissions";
import { SESSION_COOKIE, sessionAgeSeconds, signSession, verifySession, type SessionClaims } from "./jwt";
import { getSettings } from "../server/settings";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  roleId: string;
  roleName: string;
  permissions: PermissionSet;
  department: string;
  site: string;
  status: "active" | "suspended";
  avatarUrl: string;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
};

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 401, code = "unauthenticated") {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Resolves the current user from the httpOnly session cookie.
 *
 * Always re-reads the user document rather than trusting the token body alone:
 * a suspended account or a deleted role must take effect on the very next
 * request, not when the token happens to expire.
 */
export async function getSessionUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const claims: SessionClaims | null = await verifySession(token);
  if (!claims) return null;

  // Idle timeout - the token is still cryptographically valid but the seat has
  // been inactive longer than the configured window.
  const settings = await getSettings();
  const age = sessionAgeSeconds(claims);
  if (age !== null && age > settings.sessionTimeoutMin * 60) return null;

  const doc = await User.findById(claims.sub).lean<Record<string, unknown>>();
  if (!doc) return null;
  if (doc.status !== "active") return null;

  const role = await Role.findById(doc.role as string).lean<{
    name: string;
    permissions: unknown;
  }>();
  if (!role) return null;

  return {
    id: String(doc._id),
    name: String(doc.name ?? ""),
    email: String(doc.email ?? ""),
    employeeId: String(doc.employeeId ?? ""),
    roleId: String(doc.role),
    roleName: String(role.name ?? ""),
    permissions: normalizePermissions(role.permissions),
    department: String(doc.department ?? ""),
    site: String(doc.site ?? ""),
    status: doc.status as "active" | "suspended",
    avatarUrl: String(doc.avatarUrl ?? ""),
    mustChangePassword: Boolean(doc.mustChangePassword),
    lastLoginAt: (doc.lastLoginAt as Date | null) ?? null,
  };
}

/** Same as `getSessionUser` but throws a 401 instead of returning null. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("You must be signed in to do that.", 401);
  return user;
}

export class ForbiddenError extends Error {
  status = 403;
  code = "forbidden";
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Throws 403 unless the user holds the permission. */
export function requirePermission(user: AuthUser, permission: PermissionKey): void {
  if (!user.permissions[permission]) {
    throw new ForbiddenError(
      `Your role (${user.roleName}) does not have the "${permission}" permission.`,
    );
  }
}

/** Throws 403 unless the user holds at least one of the permissions. */
export function requireAnyPermission(
  user: AuthUser,
  permissions: PermissionKey[],
): void {
  if (!permissions.some((p) => user.permissions[p])) {
    throw new ForbiddenError(
      `Your role (${user.roleName}) does not have any of: ${permissions.join(", ")}.`,
    );
  }
}

/** Signs a session cookie. The token body is only a fast path; see getSessionUser. */
export async function createSessionCookie(
  user: { id: string; email: string; name: string; roleId: string; roleName: string },
  ttlMinutes: number,
): Promise<string> {
  return signSession(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      roleId: user.roleId,
      roleName: user.roleName,
    },
    ttlMinutes,
  );
}

/**
 * Agent scoping: viewers without `viewAllTickets` only ever see tickets assigned
 * to them or processed by them.
 */
export function canSeeAllTickets(user: AuthUser): boolean {
  return user.permissions.viewAllTickets === true;
}

export function ticketVisibilityFilter(user: AuthUser): Record<string, unknown> {
  if (canSeeAllTickets(user)) return {};
  return {
    $or: [{ technician: user.id }, { processedBy: user.id }],
  };
}

/** Whether the user may modify this specific ticket. */
export function canEditTicket(
  user: AuthUser,
  ticket: { technician?: unknown; processedBy?: unknown },
): boolean {
  if (user.permissions.editAnyTicket) return true;
  const id = String(ticket.technician ?? "") || String(ticket.processedBy ?? "");
  return id === user.id;
}

export { SESSION_COOKIE, connectDB };