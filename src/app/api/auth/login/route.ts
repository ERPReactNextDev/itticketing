import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/supabase";
import { mapRoleRow, mapUserRow } from "@/lib/db/mappers";
import { verifyPassword } from "@/lib/auth/password";
import { createSessionCookie } from "@/lib/auth/session";
import { getSettings } from "@/lib/server/settings";
import { enforce, loginRule, clientIp, userAgent, resetBucket } from "@/lib/server/rate-limit";
import { setSessionCookie } from "@/lib/server/session-actions";
import { writeAuditLog } from "@/lib/server/audit";
import { normalizePermissions } from "@/lib/shared/permissions";
import { withApi, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type LoginBody = { email?: string; password?: string };

const GENERIC_ERROR = "Invalid email or password.";

export const POST = withApi(async (req: Request) => {
  // Read the body once up front so the rate-limit rule can key on the email
  // without consuming the stream.
  const body = await readJson<LoginBody>(req);
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  if (!email || !password) {
    return NextResponse.json(
      { error: "bad_request", message: "Email and password are required." },
      { status: 400 },
    );
  }

  const limited = await enforce(await loginRule(req, email));
  if (limited) return limited;

  const supabase = await connectDB();
  const settings = await getSettings();

  // Emails are stored lower-cased (schema.sql normalises any legacy casing),
  // so a single equality lookup is enough - and it uses the unique index.
  const { data: row } = await supabase
    .from("users")
    .select("*")
    .eq("Email", email)
    .maybeSingle<Record<string, unknown>>();

  if (!row) {
    await writeAuditLog({
      action: "user.login.failed",
      entity: "User",
      entityId: email,
      ip: clientIp(req),
      userAgent: userAgent(req),
      meta: { reason: "unknown-email" },
    });
    return NextResponse.json({ error: "invalid_credentials", message: GENERIC_ERROR }, { status: 401 });
  }

  const doc = mapUserRow(row, true);
  const userId = Number(doc.id);

  // Account lockout is checked before the password compare so a locked account
  // cannot be used as a password oracle.
  if (doc.lockUntil && doc.lockUntil.getTime() > Date.now()) {
    const minutes = Math.max(1, Math.ceil((doc.lockUntil.getTime() - Date.now()) / 60000));
    await writeAuditLog({
      actorId: doc.id,
      actorName: doc.name,
      actorEmail: doc.email,
      action: "user.login.blocked",
      entity: "User",
      entityId: doc.id,
      ip: clientIp(req),
      userAgent: userAgent(req),
      meta: { reason: "locked", minutesRemaining: minutes },
    });
    return NextResponse.json(
      {
        error: "account_locked",
        message: `This account is temporarily locked. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      },
      { status: 423 },
    );
  }

  if (doc.status !== "active") {
    return NextResponse.json(
      {
        error: "account_suspended",
        message: "This account has been suspended. Contact your administrator.",
      },
      { status: 403 },
    );
  }

  const passwordOk = await verifyPassword(password, doc.passwordHash);

  if (!passwordOk) {
    const failedAttempts = doc.failedLoginAttempts + 1;
    const shouldLock = failedAttempts >= settings.rateLimits.loginLockAfterFails;

    await supabase
      .from("users")
      .update({
        LoginAttempts: failedAttempts,
        // Lock window matches the login limiter window so both reset together.
        lock_until: shouldLock
          ? new Date(Date.now() + settings.rateLimits.loginWindowMin * 60_000).toISOString()
          : null,
      })
      .eq("id", userId);

    await writeAuditLog({
      actorId: doc.id,
      actorName: doc.name,
      actorEmail: doc.email,
      action: "user.login.failed",
      entity: "User",
      entityId: doc.id,
      ip: clientIp(req),
      userAgent: userAgent(req),
      meta: { failedAttempts, locked: shouldLock },
    });

    const remaining = Math.max(
      0,
      settings.rateLimits.loginLockAfterFails - failedAttempts,
    );

    return NextResponse.json(
      {
        error: "invalid_credentials",
        message: shouldLock
          ? `Too many failed attempts. This account is locked for ${settings.rateLimits.loginWindowMin} minutes.`
          : `${GENERIC_ERROR} ${remaining} attempt${remaining === 1 ? "" : "s"} remaining before the account is locked.`,
      },
      { status: 401 },
    );
  }

  const { data: roleRow } = await supabase
    .from("roles")
    .select("*")
    .eq("id", Number(doc.roleId))
    .maybeSingle<Record<string, unknown>>();

  if (!roleRow) {
    return NextResponse.json(
      { error: "server_error", message: "Your account has no role assigned. Contact an administrator." },
      { status: 500 },
    );
  }
  const role = mapRoleRow(roleRow);

  await supabase
    .from("users")
    .update({
      LoginAttempts: 0,
      lock_until: null,
      LastLoginAt: new Date().toISOString().slice(0, 10),
    })
    .eq("id", userId);

  const token = await createSessionCookie(
    { id: doc.id, email: doc.email, name: doc.name, roleId: role.id, roleName: role.name },
    settings.sessionTimeoutMin,
  );
  await setSessionCookie(token);

  await writeAuditLog({
    actorId: doc.id,
    actorName: doc.name,
    actorEmail: doc.email,
    action: "user.login",
    entity: "User",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
  });

  // A successful login clears the IP+email bucket so a user who fumbled a few
  // times then got it right is not left one attempt from lockout.
  await resetBucket(`login:${clientIp(req)}:${email}`);

  return NextResponse.json({
    user: {
      id: doc.id,
      name: doc.name,
      email: doc.email,
      employeeId: doc.employeeId,
      roleId: role.id,
      roleName: role.name,
      permissions: normalizePermissions(role.permissions),
      department: doc.department,
      site: doc.site,
      status: doc.status,
      avatarUrl: doc.avatarUrl,
      mustChangePassword: doc.mustChangePassword,
      lastLoginAt: doc.lastLoginAt,
    },
  });
});
