import { NextResponse } from "next/server";
import { connectDB, getSupabase, DatabaseError } from "@/lib/db/supabase";
import { mapUserRow, userFieldsToRow } from "@/lib/db/mappers";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";
import { isSuperAdminRoleName } from "@/lib/shared/permissions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
type Row = Record<string, unknown>;

/** Guards against a malformed id reaching PostgREST. */
function parseUserId(id: string): number {
  const n = Number(id);
  if (!Number.isFinite(n)) {
    throw new ApiInputError("That user id is not valid.");
  }
  return n;
}

type UpdateBody = {
  name?: string;
  email?: string;
  employeeId?: string;
  roleId?: string;
  department?: string;
  site?: string;
  position?: string;
  phone?: string;
  status?: string;
  avatarUrl?: string;
};

export const PATCH = withApi(async (req: Request, { params }: Params) => {
  const actor = await requireUser();
  requirePermission(actor, "manageUsers");
  const { id } = await params;
  const userId = parseUserId(id);
  const body = await readJson<UpdateBody>(req);

  const supabase = await connectDB();
  const { data: targetRow, error: targetError } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle<Row>();
  if (targetError) throw new DatabaseError(targetError);
  if (!targetRow) {
    return NextResponse.json({ error: "not_found", message: "User not found." }, { status: 404 });
  }

  const target = mapUserRow(targetRow);
  const set: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new ApiInputError("Name cannot be empty.");
    set.name = name;
  }

  if (body.email !== undefined) {
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiInputError("That email address is not valid.");
    }
    const { data: clash, error: clashError } = await supabase
      .from("users")
      .select("id")
      .eq("Email", email)
      .neq("id", userId)
      .maybeSingle<{ id: unknown }>();
    if (clashError) throw new DatabaseError(clashError);
    if (clash) {
      return NextResponse.json(
        { error: "duplicate", message: "A user with that email already exists." },
        { status: 409 },
      );
    }
    set.email = email;
  }

  if (body.employeeId !== undefined) set.employeeId = body.employeeId.trim();
  if (body.department !== undefined) set.department = body.department.trim();
  if (body.site !== undefined) set.site = body.site.trim();
  if (body.position !== undefined) set.position = body.position.trim();
  if (body.phone !== undefined) set.phone = body.phone.trim();
  if (body.avatarUrl !== undefined) set.avatarUrl = body.avatarUrl.trim();

  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "suspended") {
      throw new ApiInputError("Status must be active or suspended.");
    }
    set.status = body.status;
    // Suspending must also clear any active lockout.
    if (body.status === "suspended") set.lockUntil = null;
  }

  if (body.roleId !== undefined) {
    const roleId = Number(body.roleId);
    if (!Number.isFinite(roleId)) {
      throw new ApiInputError("That role id is not valid.");
    }
    const { data: role, error: roleError } = await supabase
      .from("roles")
      .select("id")
      .eq("id", roleId)
      .maybeSingle<{ id: unknown }>();
    if (roleError) throw new DatabaseError(roleError);
    if (!role) throw new ApiInputError("That role does not exist.");

    // Guard against removing the last SuperAdmin, which would lock everyone
    // out of the system.
    const isTargetSuperAdmin = isSuperAdminRoleName(await currentRoleName(target.roleId));
    if (isTargetSuperAdmin) {
      const { count: superAdminCount } = await supabase
        .from("users")
        .select("*", { count: "exact", head: true })
        .eq("role_id", target.roleId)
        .eq("Status", "active");

      if ((superAdminCount ?? 0) <= 1) {
        return NextResponse.json(
          {
            error: "forbidden",
            message:
              "This is the only SuperAdmin account. Promote another account to SuperAdmin before changing this one.",
          },
          { status: 403 },
        );
      }
    }
    set.roleId = String(roleId);
  }

  // An admin must not be able to suspend their own account and lock themselves
  // out mid-session.
  if (target.id === actor.id && set.status === "suspended") {
    return NextResponse.json(
      { error: "self_lockout", message: "You cannot suspend your own account." },
      { status: 409 },
    );
  }

  if (Object.keys(set).length === 0) throw new ApiInputError("Nothing to update.");

  const { error: updateError } = await supabase
    .from("users")
    .update(userFieldsToRow(set))
    .eq("id", userId);
  if (updateError) throw new DatabaseError(updateError);

  await writeAuditLog({
    actorId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    action: "user.update",
    entity: "User",
    entityId: target.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { changed: Object.keys(set) },
  });

  const { data: updatedRow, error: readError } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle<Row>();
  if (readError) throw new DatabaseError(readError);
  if (!updatedRow) {
    return NextResponse.json({ error: "not_found", message: "User not found." }, { status: 404 });
  }

  const updated = mapUserRow(updatedRow);

  return NextResponse.json({
    user: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      employeeId: updated.employeeId,
      roleId: updated.roleId,
      roleName: await currentRoleName(updated.roleId),
      department: updated.department,
      site: updated.site,
      position: updated.position,
      phone: updated.phone,
      status: updated.status,
      avatarUrl: updated.avatarUrl,
    },
  });
});

/** Suspends a user without deleting the record, preserving ticket history. */
export const DELETE = withApi(async (req: Request, { params }: Params) => {
  const actor = await requireUser();
  requirePermission(actor, "manageUsers");
  const { id } = await params;
  const userId = parseUserId(id);

  if (userId === Number(actor.id)) {
    return NextResponse.json(
      { error: "self_lockout", message: "You cannot remove your own account." },
      { status: 409 },
    );
  }

  const supabase = await connectDB();
  const { data: targetRow, error: targetError } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle<Row>();
  if (targetError) throw new DatabaseError(targetError);
  if (!targetRow) {
    return NextResponse.json({ error: "not_found", message: "User not found." }, { status: 404 });
  }

  const target = mapUserRow(targetRow);

  // Users are referenced by processedBy / technician / closedBy on historical
  // tickets, so they are suspended rather than hard-deleted.
  const { error: updateError } = await supabase
    .from("users")
    .update({ Status: "suspended", lock_until: null })
    .eq("id", userId);
  if (updateError) throw new DatabaseError(updateError);

  await writeAuditLog({
    actorId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    action: "user.suspend",
    entity: "User",
    entityId: target.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
  });

  return NextResponse.json({ ok: true, suspended: true });
});

async function currentRoleName(roleId: string): Promise<string> {
  if (!roleId) return "";
  const supabase = getSupabase();
  const { data } = await supabase
    .from("roles")
    .select("name")
    .eq("id", Number(roleId))
    .maybeSingle<{ name: string }>();
  return data?.name ?? "";
}

async function countSuperAdmins(): Promise<number> {
  const supabase = getSupabase();
  const { data: superAdminRole } = await supabase
    .from("roles")
    .select("id")
    .eq("name", "Super Admin")
    .maybeSingle<{ id: unknown }>();
  if (!superAdminRole) return 0;

  const { count } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("role_id", Number(superAdminRole.id))
    .ilike("Status", "active");
  return count ?? 0;
}
