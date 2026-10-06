import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { User, Role } from "@/lib/models";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, intParam, csvParam, ApiInputError } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Lean = Record<string, unknown>;

/** Guards against a Mongoose CastError on a malformed id. */
function isObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

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

function toDTO(doc: Lean, roleName: string): UserDTO {
  const lockUntil = doc.lockUntil ? new Date(doc.lockUntil as string) : null;
  return {
    id: String(doc._id),
    name: String(doc.name ?? ""),
    email: String(doc.email ?? ""),
    employeeId: String(doc.employeeId ?? ""),
    roleId: String(doc.role ?? ""),
    roleName,
    department: String(doc.department ?? ""),
    site: String(doc.site ?? ""),
    position: String(doc.position ?? ""),
    phone: String(doc.phone ?? ""),
    status: String(doc.status ?? "active"),
    avatarUrl: String(doc.avatarUrl ?? ""),
    lastLoginAt: doc.lastLoginAt ? String(doc.lastLoginAt) : null,
    mustChangePassword: Boolean(doc.mustChangePassword),
    locked: Boolean(lockUntil && lockUntil.getTime() > Date.now()),
    createdAt: String(doc.createdAt ?? ""),
  };
}

export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  await connectDB();

  const url = new URL(req.url);
  const search = (url.searchParams.get("search") ?? "").trim();
  const statuses = csvParam(url.searchParams.get("status"));
  const roleIds = csvParam(url.searchParams.get("roleId"));

  const filter: Record<string, unknown> = {};
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    filter.$or = [{ name: rx }, { email: rx }, { employeeId: rx }];
  }
  if (statuses.length) filter.status = { $in: statuses };
  if (roleIds.length) filter.role = { $in: roleIds };

  const page = intParam(url.searchParams.get("page"), 1, { min: 1 });
  const pageSize = intParam(url.searchParams.get("pageSize"), 25, { min: 1, max: 200 });

  // Viewer / Agent roles do not get the full staff list - only Super Admin and
  // Admin can browse the directory. Agents see only themselves.
  const canBrowse = user.permissions.manageUsers;
  if (!canBrowse) filter._id = user.id;

  const [rows, total] = await Promise.all([
    User.find(filter)
      .sort({ name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<Lean[]>(),
    User.countDocuments(filter),
  ]);

  const roles = await Role.find().lean<Array<{ _id: unknown; name: string }>>();
  const roleNameById = new Map(roles.map((role) => [String(role._id), role.name]));

  return NextResponse.json({
    users: rows.map((doc) =>
      toDTO(doc, roleNameById.get(String(doc.role ?? "")) ?? "Unassigned"),
    ),
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
  await connectDB();

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();

  if (!name) throw new ApiInputError("Name is required.");
  if (!email) throw new ApiInputError("Email is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiInputError("That email address is not valid.");
  }
  if (!body.roleId) throw new ApiInputError("A role must be assigned.");
  if (!isObjectId(body.roleId)) throw new ApiInputError("That role id is not valid.");

  const role = await Role.findById(body.roleId);
  if (!role) throw new ApiInputError("That role does not exist.");

  const existing = await User.findOne({ email });
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

  const doc = await User.create({
    name,
    email,
    employeeId: (body.employeeId ?? "").trim(),
    passwordHash: await hashPassword(password),
    mustChangePassword: true,
    role: role._id,
    department: (body.department ?? "").trim(),
    site: (body.site ?? "").trim(),
    position: (body.position ?? "").trim(),
    phone: (body.phone ?? "").trim(),
    status: body.status === "suspended" ? "suspended" : "active",
  });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "user.create",
    entity: "User",
    entityId: String(doc._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { email, roleId: String(role._id) },
  });

  const created = await User.findById(doc._id).lean<Lean>();
  if (!created) {
    return NextResponse.json({ error: "not_found", message: "Account created but could not be read back." }, { status: 500 });
  }
  return NextResponse.json(
    { user: toDTO(created, role.name), temporaryPassword: body.password ? undefined : password },
    { status: 201 },
  );
});