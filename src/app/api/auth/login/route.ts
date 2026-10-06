import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { User, Role } from "@/lib/models";
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

  await connectDB();
  const settings = await getSettings();

  // `passwordHash` is `select: false` on the schema, so ask for it explicitly.
  const user = await User.findOne({ email }).select("+passwordHash");
  if (!user) {
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

  // Account lockout is checked before the password compare so a locked account
  // cannot be used as a password oracle.
  if (user.lockUntil && user.lockUntil.getTime() > Date.now()) {
    const minutes = Math.max(1, Math.ceil((user.lockUntil.getTime() - Date.now()) / 60000));
    await writeAuditLog({
      actorId: String(user._id),
      actorName: user.name,
      actorEmail: user.email,
      action: "user.login.blocked",
      entity: "User",
      entityId: String(user._id),
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

  if (user.status !== "active") {
    return NextResponse.json(
      {
        error: "account_suspended",
        message: "This account has been suspended. Contact your administrator.",
      },
      { status: 403 },
    );
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);

  if (!passwordOk) {
    const failedAttempts = Number(user.failedLoginAttempts ?? 0) + 1;
    const shouldLock = failedAttempts >= settings.rateLimits.loginLockAfterFails;

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          failedLoginAttempts: failedAttempts,
          // Lock window matches the login limiter window so both reset together.
          lockUntil: shouldLock
            ? new Date(Date.now() + settings.rateLimits.loginWindowMin * 60_000)
            : null,
        },
      },
    );

    await writeAuditLog({
      actorId: String(user._id),
      actorName: user.name,
      actorEmail: user.email,
      action: "user.login.failed",
      entity: "User",
      entityId: String(user._id),
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

  const role = await Role.findById(user.role);
  if (!role) {
    return NextResponse.json(
      { error: "server_error", message: "Your account has no role assigned. Contact an administrator." },
      { status: 500 },
    );
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: new Date() } },
  );

  const token = await createSessionCookie(
    {
      id: String(user._id),
      email: user.email,
      name: user.name,
      roleId: String(role._id),
      roleName: role.name,
    },
    settings.sessionTimeoutMin,
  );
  await setSessionCookie(token);

  await writeAuditLog({
    actorId: String(user._id),
    actorName: user.name,
    actorEmail: user.email,
    action: "user.login",
    entity: "User",
    entityId: String(user._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
  });

  // A successful login clears the IP+email bucket so a user who fumbled a few
  // times then got it right is not left one attempt from lockout.
  await resetBucket(`login:${clientIp(req)}:${email}`);

  return NextResponse.json({
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      employeeId: user.employeeId ?? "",
      roleId: String(role._id),
      roleName: role.name,
      permissions: normalizePermissions(role.permissions),
      department: user.department ?? "",
      site: user.site ?? "",
      status: user.status,
      avatarUrl: user.avatarUrl ?? "",
      mustChangePassword: Boolean(user.mustChangePassword),
      lastLoginAt: user.lastLoginAt ?? null,
    },
  });
});