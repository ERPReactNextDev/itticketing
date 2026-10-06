import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { Requestor, buildFullName } from "@/lib/models";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, intParam, csvParam, ApiInputError } from "@/lib/server/http";
import { toCsv } from "@/lib/shared/csv";
import { DIRECTORY_STATUSES } from "@/lib/shared/constants";

export const dynamic = "force-dynamic";

export type RequestorDTO = {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  department: string;
  site: string;
  phone: string;
  status: string;
  notes: string;
  isGuest: boolean;
  ticketCount?: number;
  createdAt: string;
};

type Lean = Record<string, unknown>;

function toDTO(doc: Lean): RequestorDTO {
  return {
    id: String(doc._id),
    employeeId: String(doc.employeeId ?? ""),
    firstName: String(doc.firstName ?? ""),
    lastName: String(doc.lastName ?? ""),
    fullName: String(doc.fullName ?? ""),
    email: String(doc.email ?? ""),
    department: String(doc.department ?? ""),
    site: String(doc.site ?? ""),
    phone: String(doc.phone ?? ""),
    status: String(doc.status ?? "active"),
    notes: String(doc.notes ?? ""),
    isGuest: Boolean(doc.isGuest),
    ticketCount: typeof doc.ticketCount === "number" ? doc.ticketCount : undefined,
    createdAt: String(doc.createdAt ?? ""),
  };
}

export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  await connectDB();

  const url = new URL(req.url);

  // CSV export of the whole directory (not just the current page).
  if (url.searchParams.get("format") === "csv") {
    requirePermission(user, "exportCsv");
    const statuses = csvParam(url.searchParams.get("status"));
    const filter: Record<string, unknown> = {};
    if (statuses.length) filter.status = { $in: statuses };

    const rows = await Requestor.find(filter).sort({ fullName: 1 }).lean<Lean[]>();
    const csv = toCsv(
      ["employeeId", "firstName", "lastName", "email", "department", "site", "phone", "status", "notes"],
      rows.map((doc) => ({
        employeeId: doc.employeeId ?? "",
        firstName: doc.firstName ?? "",
        lastName: doc.lastName ?? "",
        email: doc.email ?? "",
        department: doc.department ?? "",
        site: doc.site ?? "",
        phone: doc.phone ?? "",
        status: doc.status ?? "",
        notes: doc.notes ?? "",
      })),
    );

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="requestors_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  // Lightweight mode for the New Ticket requestor picker.
  if (url.searchParams.get("picker") === "1") {
    if (!user.permissions.createTicket) {
      return NextResponse.json({ error: "forbidden", message: "You cannot create tickets." }, { status: 403 });
    }
    const search = (url.searchParams.get("search") ?? "").trim();
    const filter: Record<string, unknown> = { status: "active" };
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      filter.$or = [{ fullName: rx }, { email: rx }, { employeeId: rx }];
    }
    const rows = await Requestor.find(filter)
      .sort({ fullName: 1 })
      .limit(25)
      .lean<Lean[]>();
    return NextResponse.json({ requestors: rows.map(toDTO) });
  }

  const search = (url.searchParams.get("search") ?? "").trim();
  const statuses = csvParam(url.searchParams.get("status"));
  const departments = csvParam(url.searchParams.get("department"));

  const filter: Record<string, unknown> = {};
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    filter.$or = [
      { fullName: rx },
      { firstName: rx },
      { lastName: rx },
      { email: rx },
      { employeeId: rx },
      { phone: rx },
    ];
  }
  if (statuses.length) filter.status = { $in: statuses };
  if (departments.length) filter.department = { $in: departments };

  const page = intParam(url.searchParams.get("page"), 1, { min: 1 });
  const pageSize = intParam(url.searchParams.get("pageSize"), 25, { min: 1, max: 200 });

  const [rows, total] = await Promise.all([
    Requestor.find(filter)
      .sort({ fullName: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<Lean[]>(),
    Requestor.countDocuments(filter),
  ]);

  return NextResponse.json({
    requestors: rows.map(toDTO),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

type CreateBody = {
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

export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageRequestors");
  const body = await readJson<CreateBody>(req);

  await connectDB();

  const employeeId = (body.employeeId ?? "").trim();
  const firstName = (body.firstName ?? "").trim();
  const lastName = (body.lastName ?? "").trim();

  if (!employeeId) throw new ApiInputError("Employee ID is required.");
  if (!firstName) throw new ApiInputError("First name is required.");
  if (!lastName) throw new ApiInputError("Last name is required.");

  const email = (body.email ?? "").trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiInputError("That email address is not valid.");
  }

  const duplicate = await Requestor.findOne({ employeeId });
  if (duplicate) {
    return NextResponse.json(
      { error: "duplicate", message: `Employee ID "${employeeId}" already exists.` },
      { status: 409 },
    );
  }

  const doc = await Requestor.create({
    employeeId,
    firstName,
    lastName,
    fullName: buildFullName(firstName, lastName),
    email,
    department: (body.department ?? "").trim(),
    site: (body.site ?? "").trim(),
    phone: (body.phone ?? "").trim(),
    status: DIRECTORY_STATUSES.includes((body.status ?? "") as never)
      ? body.status
      : "active",
    notes: body.notes ?? "",
    createdBy: user.id,
  });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "requestor.create",
    entity: "Requestor",
    entityId: String(doc._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { employeeId },
  });

  return NextResponse.json({ requestor: toDTO(doc.toObject()) }, { status: 201 });
});