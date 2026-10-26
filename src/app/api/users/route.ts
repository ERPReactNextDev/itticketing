import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { mapUserRow, userFieldsToRow, type UserDoc } from "@/lib/db/mappers";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, intParam, csvParam, ApiInputError } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

export type UserDTO = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  roleId: string;
  roleName: string;
  department: string;
  site: string;
  position: string;
  phone: string;
  status: string;
  avatarUrl: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  locked: boolean;
  createdAt: string;
};

function toDTO(doc: UserDoc, roleName: string): UserDTO {
  return {
    id: doc.id,
    name: doc.name,
    email: doc.email,
    employeeId: doc.employeeId,
    roleId: doc.roleId,
    roleName,
    department: doc.department,
    site: doc.site,
    position: doc.position,
    phone: doc.phone,
    status: doc.status,
    avatarUrl: doc.avatarUrl,
    lastLoginAt: doc.lastLoginAt ? doc.lastLoginAt.toISOString() : null,
    mustChangePassword: doc.mustChangePassword,
    locked: Boolean(doc.lockUntil && doc.lockUntil.getTime() > Date.now()),
    createdAt: doc.createdAt ?? "",
  };
}

/**
 * PostgREST's `or` filter is comma/paren delimited and `%` is a LIKE wildcard,
 * so a raw search term could be read as filter syntax. Strip those characters
 * before interpolating.
 */
function sanitizeTerm(value: string): string {
  return value.replace(/[(),%]/g, " ").trim();
}

export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  const supabase = await connectDB();

  const url = new URL(req.url);
  const search = (url.searchParams.get("search") ?? "").trim();
  const statuses = csvParam(url.searchParams.get("status"));
  const roleIds = csvParam(url.searchParams.get("roleId"));

  const page = intParam(url.searchParams.get("page"), 1, { min: 1 });
  const pageSize = intParam(url.searchParams.get("pageSize"), 25, { min: 1, max: 200 });

  let q = supabase.from("users").select("*", { count: "exact" });

  if (search) {
    const term = sanitizeTerm(search);
    if (term) {
      q = q.or(
        [
          `Firstname.ilike.%${term}%`,
          `Lastname.ilike.%${term}%`,
          `Email.ilike.%${term}%`,
          `ReferenceID.ilike.%${term}%`,
        ].join(","),
      );
    }
  }

  if (statuses.length) {
    // The legacy `Status` column is free text ("Active", "Suspended", ...), so
    // match case-insensitively rather than on an exact value.
    const clauses = statuses.map((s) => sanitizeTerm(s)).filter(Boolean);
    if (clauses.length) q = q.or(clauses.map((s) => `Status.ilike.${s}`).join(","));
  }

  const numericRoleIds = roleIds.map(Number).filter(Number.isFinite);
  if (numericRoleIds.length) q = q.in("role_id", numericRoleIds);

  // Viewer / Agent roles do not get the full staff list - only SuperAdmin and
  // Admin can browse the directory. Agents see only themselves.
  if (!user.permissions.manageUsers) q = q.eq("id", Number(user.id));

  const { data, error, count } = await q
    .order("Firstname", { ascending: true })
    .order("Lastname", { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new DatabaseError(error);

  const rows = (data ?? []) as unknown as Row[];
  const total = count ?? 0;

  const { data: roleRows, error: roleError } = await supabase.from("roles").select("id, name");
  if (roleError) throw new DatabaseError(roleError);
  const roleNameById = new Map(
    (roleRows ?? []).map((role) => [String(role.id), String(role.name ?? "")]),
  );

  return NextResponse.json({
    users: rows.map((row) => {
      const doc = mapUserRow(row);
      return toDTO(doc, roleNameById.get(doc.roleId) ?? "Unassigned");
    }),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

type CreateBody = {
  name?: string;
  email?: string;
  employeeId?: string;
  password?: string;
  roleId?: string;
  department?: string;
  site?: string;
  position?: string;
  phone?: string;
  status?: string;
  mustChangePassword?: boolean;
};

export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageUsers");

  const body = await readJson<CreateBody>(req);
  const supabase = await connectDB();

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();

  if (!name) throw new ApiInputError("Name is required.");
  if (!email) throw new ApiInputError("Email is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiInputError("That email address is not valid.");
  }
  if (!body.roleId) throw new ApiInputError("A role must be assigned.");

  const roleId = Number(body.roleId);
  if (!Number.isFinite(roleId)) throw new ApiInputError("That role id is not valid.");

  const { data: role, error: roleError } = await supabase
    .from("roles")
    .select("id, name")
    .eq("id", roleId)
    .maybeSingle<{ id: unknown; name: string }>();
  if (roleError) throw new DatabaseError(roleError);
  if (!role) throw new ApiInputError("That role does not exist.");

  const { data: existing, error: existingError } = await supabase
    .from("users")
    .select("id")
    .eq("Email", email)
    .maybeSingle<{ id: unknown }>();
  if (existingError) throw new DatabaseError(existingError);
  if (existing) {
    return NextResponse.json(
      { error: "duplicate", message: "A user with that email already exists." },
      { status: 409 },
    );
  }

  // Generate a temporary password when the admin does not supply one, and
  // force a change at first login either way.
  const password = body.password?.trim() || `temp-${Math.random().toString(36).slice(2, 12)}`;
  const strength = validatePasswordStrength(password);
  if (!strength.ok && body.password) {
    return NextResponse.json({ error: "weak_password", message: strength.message }, { status: 400 });
  }

  // `ReferenceID` is NOT NULL + UNIQUE on the legacy table, so blank employee
  // ids would collide. Fall back to the already-unique email.
  const employeeId = (body.employeeId ?? "").trim() || email;

  const { data: created, error: insertError } = await supabase
    .from("users")
    .insert(
      userFieldsToRow({
        name,
        email,
        employeeId,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
        roleId: String(roleId),
        department: (body.department ?? "").trim(),
        site: (body.site ?? "").trim(),
        position: (body.position ?? "").trim(),
        phone: (body.phone ?? "").trim(),
        status: body.status === "suspended" ? "suspended" : "active",
      }),
    )
    .select("*")
    .single<Row>();
  if (insertError) throw new DatabaseError(insertError);

  const doc = mapUserRow(created);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "user.create",
    entity: "User",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { email, roleId: String(roleId) },
  });

  return NextResponse.json(
    { user: toDTO(doc, role.name), temporaryPassword: body.password ? undefined : password },
    { status: 201 },
  );
});
