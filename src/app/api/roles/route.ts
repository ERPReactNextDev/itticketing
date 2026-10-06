import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { Role, User } from "@/lib/models";
import { requireUser, requirePermission } from "@/lib/auth/session";
import {
  PERMISSION_KEYS,
  normalizePermissions,
  isSuperAdminRoleName,
} from "@/lib/shared/permissions";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Lean = Record<string, unknown>;

/** Guards against a Mongoose CastError on a malformed id. */
function isObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

function toDTO(doc: Lean, userCount?: number) {
  return {
    id: String(doc._id),
    name: String(doc.name ?? ""),
    description: String(doc.description ?? ""),
    permissions: normalizePermissions(doc.permissions),
    isSystem: Boolean(doc.isSystem),
    order: Number(doc.order ?? 0),
    userCount,
  };
}

/**
 * Any signed-in user can read roles - the login page needs the role list and
 * the sidebar needs permission names. Mutations require `manageRoles`.
 */
export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  await connectDB();

  const url = new URL(req.url);

  // Permission catalogue for the matrix editor.
  if (url.searchParams.get("matrix") === "1") {
    requirePermission(user, "manageRoles");
    const roles = await Role.find().sort({ order: 1, name: 1 }).lean<Lean[]>();
    const counts = await User.aggregate<{ _id: unknown; count: number }>([
      { $group: { _id: "$role", count: { $sum: 1 } } },
    ]);
    const countByRole = new Map(counts.map((c) => [String(c._id), c.count]));

    return NextResponse.json({
      roles: roles.map((doc) => toDTO(doc, countByRole.get(String(doc._id)))),
      permissionKeys: PERMISSION_KEYS,
    });
  }

  const roles = await Role.find().sort({ order: 1, name: 1 }).lean<Lean[]>();
  return NextResponse.json({
    roles: roles.map((doc) => ({
      id: String(doc._id),
      name: String(doc.name ?? ""),
      description: String(doc.description ?? ""),
      permissions: normalizePermissions(doc.permissions),
      isSystem: Boolean(doc.isSystem),
      order: Number(doc.order ?? 0),
    })),
  });
});

type CreateBody = { name?: string; description?: string; permissions?: Record<string, boolean> };

export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageRoles");
  const body = await readJson<CreateBody>(req);

  const name = (body.name ?? "").trim();
  if (!name) throw new ApiInputError("Role name is required.");

  await connectDB();
  const existing = await Role.findOne({ name });
  if (existing) {
    return NextResponse.json(
      { error: "duplicate", message: `A role named "${name}" already exists.` },
      { status: 409 },
    );
  }

  const doc = await Role.create({
    name,
    description: (body.description ?? "").trim(),
    permissions: normalizePermissions(body.permissions),
    isSystem: false,
    order: 100,
  });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "role.create",
    entity: "Role",
    entityId: String(doc._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { name },
  });

  return NextResponse.json({ role: toDTO(doc.toObject()) }, { status: 201 });
});

type UpdateBody = {
  name?: string;
  description?: string;
  permissions?: Record<string, boolean>;
};

export const PATCH = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageRoles");

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) throw new ApiInputError("A role id is required.");
  if (!isObjectId(id)) throw new ApiInputError("That role id is not valid.");

  const body = await readJson<UpdateBody>(req);
  await connectDB();

  const role = await Role.findById(id);
  if (!role) {
    return NextResponse.json({ error: "not_found", message: "Role not found." }, { status: 404 });
  }

  const set: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new ApiInputError("Role name cannot be empty.");
    const clash = await Role.findOne({ name, _id: { $ne: role._id } });
    if (clash) {
      return NextResponse.json(
        { error: "duplicate", message: `A role named "${name}" already exists.` },
        { status: 409 },
      );
    }
    set.name = name;
  }
  if (body.description !== undefined) set.description = body.description.trim();

  if (body.permissions !== undefined) {
    const next = normalizePermissions(body.permissions);

    // Super Admin must always retain role + settings management, otherwise the
    // app can become permanently unadministrable.
    if (isSuperAdminRoleName(String(role.name)) && !(next.manageRoles && next.manageSettings)) {
      return NextResponse.json(
        {
          error: "locked_permission",
          message:
            "The Super Admin role must keep the Manage Roles and Manage Settings permissions.",
        },
        { status: 409 },
      );
    }
    set.permissions = next;
  }

  if (Object.keys(set).length === 0) throw new ApiInputError("Nothing to update.");

  await Role.updateOne({ _id: role._id }, { $set: set });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "role.update",
    entity: "Role",
    entityId: String(role._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: {
      changed: Object.keys(set),
      permissions: body.permissions ? normalizePermissions(body.permissions) : undefined,
    },
  });

  const updated = await Role.findById(role._id).lean<Lean>();
  if (!updated) {
    return NextResponse.json({ error: "not_found", message: "Role not found." }, { status: 404 });
  }
  return NextResponse.json({ role: toDTO(updated) });
});

export const DELETE = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageRoles");

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) throw new ApiInputError("A role id is required.");
  if (!isObjectId(id)) throw new ApiInputError("That role id is not valid.");

  await connectDB();
  const role = await Role.findById(id);
  if (!role) {
    return NextResponse.json({ error: "not_found", message: "Role not found." }, { status: 404 });
  }

  if (role.isSystem) {
    return NextResponse.json(
      { error: "protected", message: "System roles cannot be deleted. Rename them instead." },
      { status: 409 },
    );
  }

  const userCount = await User.countDocuments({ role: role._id });
  if (userCount > 0) {
    return NextResponse.json(
      {
        error: "in_use",
        message: `${userCount} account${userCount === 1 ? " is" : "s are"} assigned to this role. Reassign them first.`,
      },
      { status: 409 },
    );
  }

  await Role.deleteOne({ _id: role._id });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "role.delete",
    entity: "Role",
    entityId: String(role._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { name: role.name },
  });

  return NextResponse.json({ ok: true });
});