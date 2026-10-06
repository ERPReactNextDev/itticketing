import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { Requestor, Ticket, buildFullName } from "@/lib/models";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";
import { DIRECTORY_STATUSES } from "@/lib/shared/constants";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Guards against a Mongoose CastError on a malformed id. */
function assertObjectId(id: string): void {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) {
    throw new ApiInputError("That requestor id is not valid.");
  }
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
  assertObjectId(id);
  const body = await readJson<UpdateBody>(req);

  await connectDB();
  const doc = await Requestor.findById(id);
  if (!doc) {
    return NextResponse.json({ error: "not_found", message: "Requestor not found." }, { status: 404 });
  }

  const set: Record<string, unknown> = {};

  if (body.employeeId !== undefined) {
    const employeeId = body.employeeId.trim();
    if (!employeeId) throw new ApiInputError("Employee ID cannot be empty.");
    const clash = await Requestor.findOne({ employeeId, _id: { $ne: doc._id } });
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

  await Requestor.updateOne({ _id: doc._id }, { $set: set });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "requestor.update",
    entity: "Requestor",
    entityId: String(doc._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { changed: Object.keys(set) },
  });

  const updated = await Requestor.findById(doc._id).lean<Record<string, unknown>>();
  return NextResponse.json({ requestor: updated });
});

export const DELETE = withApi(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  requirePermission(user, "manageRequestors");
  const { id } = await params;
  assertObjectId(id);

  await connectDB();

  // Deleting a requestor would orphan the historical tickets that reference
  // them. The ticket keeps its embedded snapshot, but the link is lost, so
  // block deletion while tickets exist and offer deactivation instead.
  const ticketCount = await Ticket.countDocuments({ requestor: id });
  if (ticketCount > 0) {
    return NextResponse.json(
      {
        error: "has_tickets",
        message: `This requestor is linked to ${ticketCount} ticket${ticketCount === 1 ? "" : "s"}. Set them to Inactive instead of deleting so ticket history stays intact.`,
        ticketCount,
      },
      { status: 409 },
    );
  }

  await Requestor.deleteOne({ _id: id });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "requestor.delete",
    entity: "Requestor",
    entityId: id,
    ip: clientIp(req),
    userAgent: userAgent(req),
  });

  return NextResponse.json({ ok: true });
});