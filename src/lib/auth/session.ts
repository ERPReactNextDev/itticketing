import "server-only";
import { cookies } from "next/headers";
import { connectDB } from "../db/supabase";
import { mapUserRow } from "../db/mappers";
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

  const supabase = await connectDB();

  // Always re-read the row rather than trusting the token body: a suspended
  // account or a deleted role must take effect on the very next request.
  const { data: row } = await supabase
    .from("users")
    .select("*")
    .eq("id", Number(claims.sub))
    .maybeSingle<Record<string, unknown>>();
  if (!row) return null;

  const doc = mapUserRow(row);
  if (doc.status !== "active") return null;
  if (!doc.roleId) return null;

  const { data: role } = await supabase
    .from("roles")
    .select("name, permissions")
    .eq("id", Number(doc.roleId))
    .maybeSingle<{ name: string; permissions: unknown }>();
  if (!role) return null;

  return {
    id: doc.id,
    name: doc.name,
    email: doc.email,
    employeeId: doc.employeeId,
    roleId: doc.roleId,
    roleName: String(role.name ?? ""),
    permissions: normalizePermissions(role.permissions),
    department: doc.department,
    site: doc.site,
    status: doc.status,
    avatarUrl: doc.avatarUrl,
    mustChangePassword: doc.mustChangePassword,
    lastLoginAt: doc.lastLoginAt,
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
 *
 * Returns the PostgREST `.or()` scope string, or `null` when the user may see
 * everything. `ticketQueryBuilder` applies the same rule for ticket lists.
 */
export function ticketVisibilityFilter(user: AuthUser): string | null {
  if (user.permissions.viewAllTickets) return null;
  return `technician_id.eq.${user.id},processed_by_id.eq.${user.id}`;
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
