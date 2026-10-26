import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { mapRoleRow, mapUserRow, userFieldsToRow } from "@/lib/db/mappers";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { createSessionCookie } from "@/lib/auth/session";
import { getSettings } from "@/lib/server/settings";
import { setSessionCookie } from "@/lib/server/session-actions";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { writeAuditLog } from "@/lib/server/audit";
import { normalizePermissions } from "@/lib/shared/permissions";
import {
  withApi,
  readJson,
  ApiInputError,
  ServerConfigError,
} from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Bootstrap registration for the first SuperAdmin account.
 *
 * Unlike `/api/auth/login` this route is *anonymous*, so it is gated on a
 * shared setup secret (`REGISTER_SECRET`) rather than a rate-limit rule: the
 * token is what stops the public URL from becoming an open SuperAdmin factory.
 * It only ever creates the `SuperAdmin` role - every other account still comes
 * from an administrator through `/api/users`.
 */
const MIN_SECRET_LENGTH = 16;

type RegisterBody = {
  name?: string;
  email?: string;
  password?: string;
  setupToken?: string;
};

export const POST = withApi(async (req: Request) => {
  const secret = process.env.REGISTER_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new ServerConfigError(
      "The server is not configured: REGISTER_SECRET is missing or shorter than " +
        `${MIN_SECRET_LENGTH} characters. Add it to .env.local and restart to enable registration.`,
    );
  }

  const body = await readJson<RegisterBody>(req);

  // Check the setup token before any database work, so a wrong token cannot be
  // used to probe for existing accounts.
  if ((body.setupToken ?? "").trim() !== secret) {
    return NextResponse.json(
      { error: "forbidden", message: "That setup token is not valid." },
      { status: 403 },
    );
  }

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  if (!name) throw new ApiInputError("Name is required.");
  if (!email) throw new ApiInputError("Email is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiInputError("That email address is not valid.");
  }

  const strength = validatePasswordStrength(password);
  if (!strength.ok) throw new ApiInputError(strength.message);

  const supabase = await connectDB();
  const settings = await getSettings();

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

  const { data: roleRow, error: roleError } = await supabase
    .from("roles")
    .select("*")
    .eq("name", "SuperAdmin")
    .maybeSingle<Record<string, unknown>>();
  if (roleError) throw new DatabaseError(roleError);
  if (!roleRow) {
    throw new ServerConfigError(
      "The SuperAdmin role is missing from the database. Run `npm run seed` first, then try again.",
    );
  }
  const role = mapRoleRow(roleRow);

  const { data: created, error: insertError } = await supabase
    .from("users")
    .insert(
      userFieldsToRow({
        name,
        email,
        // `ReferenceID` is NOT NULL + UNIQUE on the legacy table, so a blank
        // employee id would collide - the already-unique email stands in.
        employeeId: email,
        passwordHash: await hashPassword(password),
        // The registrant chose this password themselves, so there is nothing
        // to force a change of.
        mustChangePassword: false,
        roleId: role.id,
        department: "Information Technology",
        position: "System Administrator",
        status: "active",
      }),
    )
    .select("*")
    .single<Record<string, unknown>>();
  if (insertError) throw new DatabaseError(insertError);

  const doc = mapUserRow(created);

  // Sign the new administrator straight in - re-typing the password they just
  // set would add nothing.
  const token = await createSessionCookie(
    { id: doc.id, email: doc.email, name: doc.name, roleId: role.id, roleName: role.name },
    settings.sessionTimeoutMin,
  );
  await setSessionCookie(token);

  await writeAuditLog({
    actorId: doc.id,
    actorName: doc.name,
    actorEmail: doc.email,
    action: "user.register",
    entity: "User",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { roleName: role.name, via: "register" },
  });

  return NextResponse.json(
    {
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
    },
    { status: 201 },
  );
});
