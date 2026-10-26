import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { mapRoleRow, roleFieldsToRow, type RoleDoc } from "@/lib/db/mappers";
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

type Row = Record<string, unknown>;

/** Guards against a malformed id reaching PostgREST. */
function parseRoleId(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ApiInputError("That role id is not valid.");
  }
  return n;
}

function toDTO(doc: RoleDoc, userCount?: number) {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    permissions: normalizePermissions(doc.permissions),
    isSystem: doc.isSystem,
    order: doc.order,
    userCount,
  };
}

/**
 * Any signed-in user can read roles - the login page needs the role list and
 * the sidebar needs permission names. Mutations require `manageRoles`.
 */
export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  const supabase = await connectDB();

  const url = new URL(req.url);

  const { data, error } = await supabase
    .from("roles")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new DatabaseError(error);
  const roles = ((data ?? []) as unknown as Row[]).map(mapRoleRow);

  // Permission catalogue for the matrix editor.
  if (url.searchParams.get("matrix") === "1") {
    requirePermission(user, "manageRoles");

    // PostgREST cannot group, so count per role. The role list is small, and a
    // `head: true` count does not pull any rows back.
    const counts = await Promise.all(
      roles.map(async (role) => {
        const { count } = await supabase
          .from("users")
          .select("id", { count: "exact", head: true })
          .eq("role_id", Number(role.id));
        return [role.id, count ?? 0] as const;
      }),
    );
    const countByRole = new Map(counts);

    return NextResponse.json({
      roles: roles.map((role) => toDTO(role, countByRole.get(role.id))),
      permissionKeys: PERMISSION_KEYS,
    });
  }

  return NextResponse.json({
    roles: roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      permissions: normalizePermissions(role.permissions),
      isSystem: role.isSystem,
      order: role.order,
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

  const supabase = await connectDB();
  const { data: existing, error: existingError } = await supabase
    .from("roles")
    .select("id")
    .eq("name", name)
    .maybeSingle<{ id: unknown }>();
  if (existingError) throw new DatabaseError(existingError);
  if (existing) {
    return NextResponse.json(
      { error: "duplicate", message: `A role named "${name}" already exists.` },
      { status: 409 },
    );
  }

  const { data: created, error: insertError } = await supabase
    .from("roles")
    .insert(
      roleFieldsToRow({
        name,
        description: (body.description ?? "").trim(),
        permissions: normalizePermissions(body.permissions),
        isSystem: false,
        order: 100,
      }),
    )
    .select("*")
    .single<Row>();
  if (insertError) throw new DatabaseError(insertError);

  const doc = mapRoleRow(created);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "role.create",
    entity: "Role",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { name },
  });

  return NextResponse.json({ role: toDTO(doc) }, { status: 201 });
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
  const roleId = parseRoleId(id);

  const body = await readJson<UpdateBody>(req);
  const supabase = await connectDB();

  const { data: roleRow, error: roleError } = await supabase
    .from("roles")
    .select("*")
    .eq("id", roleId)
    .maybeSingle<Row>();
  if (roleError) throw new DatabaseError(roleError);
  if (!roleRow) {
    return NextResponse.json({ error: "not_found", message: "Role not found." }, { status: 404 });
  }
  const role = mapRoleRow(roleRow);

  const set: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw new ApiInputError("Role name cannot be empty.");
    const { data: clash, error: clashError } = await supabase
      .from("roles")
      .select("id")
      .eq("name", name)
      .neq("id", roleId)
      .maybeSingle<{ id: unknown }>();
    if (clashError) throw new DatabaseError(clashError);
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

    // SuperAdmin must always retain role + settings management, otherwise the
    // system could become unadministrable.
    if (
      isSuperAdminRoleName(role.name) &&
      (!next.manageRoles || !next.manageSettings)
    ) {
      return NextResponse.json(
        {
          error: "forbidden",
          message:
            "The SuperAdmin role must keep the Manage Roles and Manage Settings permissions.",
        },
        { status: 403 },
      );
    }
    set.permissions = next;
  }

  if (Object.keys(set).length === 0) throw new ApiInputError("Nothing to update.");

  const { error: updateError } = await supabase
    .from("roles")
    .update(roleFieldsToRow(set))
    .eq("id", roleId);
  if (updateError) throw new DatabaseError(updateError);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "role.update",
    entity: "Role",
    entityId: role.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: {
      changed: Object.keys(set),
      permissions: body.permissions ? normalizePermissions(body.permissions) : undefined,
    },
  });

  const { data: updatedRow, error: readError } = await supabase
    .from("roles")
    .select("*")
    .eq("id", roleId)
    .maybeSingle<Row>();
  if (readError) throw new DatabaseError(readError);
  if (!updatedRow) {
    return NextResponse.json({ error: "not_found", message: "Role not found." }, { status: 404 });
  }
  return NextResponse.json({ role: toDTO(mapRoleRow(updatedRow)) });
});

export const DELETE = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageRoles");

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) throw new ApiInputError("A role id is required.");
  const roleId = parseRoleId(id);

  const supabase = await connectDB();
  const { data: roleRow, error: roleError } = await supabase
    .from("roles")
    .select("*")
    .eq("id", roleId)
    .maybeSingle<Row>();
  if (roleError) throw new DatabaseError(roleError);
  if (!roleRow) {
    return NextResponse.json({ error: "not_found", message: "Role not found." }, { status: 404 });
  }
  const role = mapRoleRow(roleRow);

  if (role.isSystem) {
    return NextResponse.json(
      { error: "protected", message: "System roles cannot be deleted. Rename them instead." },
      { status: 409 },
    );
  }

  const { count, error: countError } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("role_id", roleId);
  if (countError) throw new DatabaseError(countError);

  const userCount = count ?? 0;
  if (userCount > 0) {
    return NextResponse.json(
      {
        error: "in_use",
        message: `${userCount} account${userCount === 1 ? " is" : "s are"} assigned to this role. Reassign them first.`,
      },
      { status: 409 },
    );
  }

  const { error: deleteError } = await supabase.from("roles").delete().eq("id", roleId);
  if (deleteError) throw new DatabaseError(deleteError);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "role.delete",
    entity: "Role",
    entityId: role.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { name: role.name },
  });

  return NextResponse.json({ ok: true });
});
