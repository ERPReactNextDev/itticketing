import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { buildFullName, mapRequestorRow, requestorFieldsToRow } from "@/lib/db/mappers";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";
import { DIRECTORY_STATUSES } from "@/lib/shared/constants";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Supabase ids are bigint, so a non-numeric id must fail cleanly. */
function parseRequestorId(id: string): number {
  const n = Number(id);
  if (!Number.isFinite(n) || String(n) !== id.trim()) {
    throw new ApiInputError("That requestor id is not valid.");
  }
  return n;
}

type UpdateBody = {
  employeeId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  department?: string;
  site?: string;
  phone?: string;
  status?: string;
  notes?: string;
};

export const PATCH = withApi(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  requirePermission(user, "manageRequestors");
  const { id } = await params;
  const requestorId = parseRequestorId(id);
  const body = await readJson<UpdateBody>(req);

  const supabase = await connectDB();
  const { data: row } = await supabase
    .from("requestors")
    .select("*")
    .eq("id", requestorId)
    .maybeSingle<Record<string, unknown>>();
  if (!row) {
    return NextResponse.json({ error: "not_found", message: "Requestor not found." }, { status: 404 });
  }
  const doc = mapRequestorRow(row);

  const set: Record<string, unknown> = {};

  if (body.employeeId !== undefined) {
    const employeeId = body.employeeId.trim();
    if (!employeeId) throw new ApiInputError("Employee ID cannot be empty.");
    const { data: clash } = await supabase
      .from("requestors")
      .select("id")
      .eq("employee_id", employeeId)
      .neq("id", requestorId)
      .maybeSingle<{ id: unknown }>();
    if (clash) {
      return NextResponse.json(
        { error: "duplicate", message: `Employee ID "${employeeId}" is already in use.` },
        { status: 409 },
      );
    }
    set.employeeId = employeeId;
  }

  if (body.firstName !== undefined) set.firstName = body.firstName.trim();
  if (body.lastName !== undefined) set.lastName = body.lastName.trim();
  if (body.email !== undefined) {
    const email = body.email.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiInputError("That email address is not valid.");
    }
    set.email = email;
  }
  if (body.department !== undefined) set.department = body.department.trim();
  if (body.site !== undefined) set.site = body.site.trim();
  if (body.phone !== undefined) set.phone = body.phone.trim();
  if (body.notes !== undefined) set.notes = body.notes;
  if (body.status !== undefined) {
    if (!DIRECTORY_STATUSES.includes(body.status as never)) {
      throw new ApiInputError("Status must be active or inactive.");
    }
    set.status = body.status;
  }

  // fullName is derived - never trust a client-supplied value.
  if (set.firstName !== undefined || set.lastName !== undefined) {
    set.fullName = buildFullName(
      String(set.firstName ?? doc.firstName),
      String(set.lastName ?? doc.lastName),
    );
  }

  if (Object.keys(set).length === 0) throw new ApiInputError("Nothing to update.");

  const { data: updated, error } = await supabase
    .from("requestors")
    .update(requestorFieldsToRow(set))
    .eq("id", requestorId)
    .select("*")
    .single<Record<string, unknown>>();
  if (error) throw new DatabaseError(error);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "requestor.update",
    entity: "Requestor",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { changed: Object.keys(set) },
  });

  return NextResponse.json({ requestor: mapRequestorRow(updated) });
});

export const DELETE = withApi(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  requirePermission(user, "manageRequestors");
  const { id } = await params;
  const requestorId = parseRequestorId(id);

  const supabase = await connectDB();

  // Deleting a requestor would orphan the historical tickets that reference
  // them. The ticket keeps its embedded snapshot, but the link is lost, so
  // block deletion while tickets exist and offer deactivation instead.
  const { count: ticketCount } = await supabase
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .eq("requestor_id", String(requestorId));
  if ((ticketCount ?? 0) > 0) {
    const count = ticketCount ?? 0;
    return NextResponse.json(
      {
        error: "has_tickets",
        message: `This requestor is linked to ${count} ticket${count === 1 ? "" : "s"}. Set them to Inactive instead of deleting so ticket history stays intact.`,
        ticketCount: count,
      },
      { status: 409 },
    );
  }

  const { error } = await supabase.from("requestors").delete().eq("id", requestorId);
  if (error) throw new DatabaseError(error);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "requestor.delete",
    entity: "Requestor",
    entityId: String(requestorId),
    ip: clientIp(req),
    userAgent: userAgent(req),
  });

  return NextResponse.json({ ok: true });
});
