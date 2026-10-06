import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { User, Role } from "@/lib/models";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";
import { isSuperAdminRoleName } from "@/lib/shared/permissions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Guards against a Mongoose CastError on a malformed id. */
function assertObjectId(id: string): void {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) {
    throw new ApiInputError("That user id is not valid.");
  }
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
  assertObjectId(id);
  const body = await readJson<UpdateBody>(req);

  await connectDB();
  const target = await User.findById(id);
  if (!target) {
    return NextResponse.json({ error: "not_found", message: "User not found." }, { status: 404 });
  }

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
    const clash = await User.findOne({ email, _id: { $ne: target._id } });
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
    if (!/^[0-9a-fA-F]{24}$/.test(body.roleId)) {
      throw new ApiInputError("That role id is not valid.");
    }
    const role = await Role.findById(body.roleId);
    if (!role) throw new ApiInputError("That role does not exist.");

    // Guard against removing the last Super Admin, which would lock everyone
    // out of role management permanently.
    if (
      target._id.toString() !== actor.id &&
      isSuperAdminRoleName(await currentRoleName(target.role as string))
    ) {
      const superAdmins = await countSuperAdmins();
      if (superAdmins <= 1) {
        return NextResponse.json(
          {
            error: "last_super_admin",
            message:
              "This is the only Super Admin account. Promote another account to Super Admin before changing this one.",
          },
          { status: 409 },
        );
      }
    }
    set.role = role._id;
  }

  // An admin must not be able to suspend or demote their own account and lock
  // themselves out mid-session.
  if (target._id.toString() === actor.id) {
    if (set.status === "suspended") {
      return NextResponse.json(
        { error: "self_lockout", message: "You cannot suspend your own account." },
        { status: 409 },
      );
    }
  }

  if (Object.keys(set).length === 0) throw new ApiInputError("Nothing to update.");

  await User.updateOne({ _id: target._id }, { $set: set });

  await writeAuditLog({
    actorId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    action: "user.update",
    entity: "User",
    entityId: String(target._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { changed: Object.keys(set) },
  });

  const updated = await User.findById(target._id).lean<Record<string, unknown>>();
  if (!updated) {
    return NextResponse.json({ error: "not_found", message: "User not found." }, { status: 404 });
  }
  const role = await Role.findById(updated.role as string).lean<{ name?: string }>();

  return NextResponse.json({
    user: {
      id: String(updated._id),
      name: String(updated.name ?? ""),
      email: String(updated.email ?? ""),
      employeeId: String(updated.employeeId ?? ""),
      roleId: String(updated.role ?? ""),
      roleName: role?.name ?? "",
      department: String(updated.department ?? ""),
      site: String(updated.site ?? ""),
      position: String(updated.position ?? ""),
      phone: String(updated.phone ?? ""),
      status: String(updated.status ?? "active"),
      avatarUrl: String(updated.avatarUrl ?? ""),
    },
  });
});

/** Suspends a user without deleting the record, preserving ticket history. */
export const DELETE = withApi(async (req: Request, { params }: Params) => {
  const actor = await requireUser();
  requirePermission(actor, "manageUsers");
  const { id } = await params;
  assertObjectId(id);

  if (id === actor.id) {
    return NextResponse.json(
      { error: "self_lockout", message: "You cannot remove your own account." },
      { status: 409 },
    );
  }

  await connectDB();
  const target = await User.findById(id);
  if (!target) {
    return NextResponse.json({ error: "not_found", message: "User not found." }, { status: 404 });
  }

  // Users are referenced by processedBy / technician / closedBy on historical
  // tickets, so they are suspended rather than hard-deleted.
  await User.updateOne(
    { _id: target._id },
    { $set: { status: "suspended", lockUntil: null } },
  );

  await writeAuditLog({
    actorId: actor.id,
    actorName: actor.name,
    actorEmail: actor.email,
    action: "user.suspend",
    entity: "User",
    entityId: String(target._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
  });

  return NextResponse.json({ ok: true, suspended: true });
});

async function currentRoleName(roleId: string): Promise<string> {
  const role = await Role.findById(roleId).lean<{ name?: string }>();
  return role?.name ?? "";
}

async function countSuperAdmins(): Promise<number> {
  const superAdminRole = await Role.findOne({ name: "Super Admin" });
  if (!superAdminRole) return 0;
  return User.countDocuments({ role: superAdminRole._id, status: "active" });
}