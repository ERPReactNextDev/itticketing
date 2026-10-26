import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { mapUserRow, userFieldsToRow } from "@/lib/db/mappers";
import { requireUser } from "@/lib/auth/session";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/auth/password";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Body = {
  currentPassword?: string;
  newPassword?: string;
  /** Lets an admin reset someone else's password without knowing the old one. */
  targetUserId?: string;
};

/**
 * Changes a password.
 *
 * Two flows share this route:
 *  - self-service: requires the current password
 *  - admin reset: requires `manageUsers`, allowed to set a new password directly
 *
 * Both clear `mustChangePassword` so a forced reset is satisfied.
 */
export const POST = withApi(async (req: Request) => {
  const actor = await requireUser();
  const body = await readJson<Body>(req);
  const newPassword = body.newPassword ?? "";

  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) {
    return NextResponse.json({ error: "weak_password", message: strength.message }, { status: 400 });
  }

  const supabase = await connectDB();

  const isAdminReset =
    Boolean(body.targetUserId) && body.targetUserId !== actor.id && actor.permissions.manageUsers;

  let targetId: number;

  if (isAdminReset) {
    targetId = Number(body.targetUserId);
  } else {
    if (body.targetUserId && body.targetUserId !== actor.id) {
      return NextResponse.json(
        { error: "forbidden", message: "You cannot change another user's password." },
        { status: 403 },
      );
    }
    if (!body.currentPassword) {
      return NextResponse.json(
        { error: "bad_request", message: "Your current password is required." },
        { status: 400 },
      );
    }
    const { data: meRow, error: meError } = await supabase
      .from("users")
      .select("*")
      .eq("id", Number(actor.id))
      .maybeSingle<Record<string, unknown>>();
    if (meError) throw new DatabaseError(meError);

    const me = meRow ? mapUserRow(meRow, true) : null;
    if (!me?.passwordHash) {
      return NextResponse.json({ error: "not_found", message: "Account not found." }, { status: 404 });
    }
    if (!(await verifyPassword(body.currentPassword, me.passwordHash))) {
      return NextResponse.json(
        { error: "invalid_credentials", message: "Your current password is incorrect." },
        { status: 401 },
      );
    }
    targetId = Number(actor.id);
  }

  if (!Number.isFinite(targetId)) {
    return NextResponse.json({ error: "not_found", message: "Account not found." }, { status: 404 });
  }

  const { data: targetRow, error: targetError } = await supabase
    .from("users")
    .select("id, Email")
    .eq("id", targetId)
    .maybeSingle<Record<string, unknown>>();
  if (targetError) throw new DatabaseError(targetError);
  if (!targetRow) {
    return NextResponse.json({ error: "not_found", message: "Account not found." }, { status: 404 });
  }

  const target = mapUserRow(targetRow);

  const { error: updateError } = await supabase
    .from("users")
    .update(
      userFieldsToRow({
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockUntil: null,
      }),
    )
    .eq("id", targetId);
  if (updateError) throw new DatabaseError(updateError);

  await writeAuditLog({
    actorId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    action: isAdminReset ? "user.password.reset" : "user.password.changed",
    entity: "User",
    entityId: target.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { targetEmail: target.email },
  });

  return NextResponse.json({ ok: true, mustChangePassword: false });
});
