import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { buildFullName, mapRequestorRow, requestorFieldsToRow, type RequestorDoc } from "@/lib/db/mappers";
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

type Row = Record<string, unknown>;

function toDTO(doc: RequestorDoc, ticketCount?: number): RequestorDTO {
  return {
    id: doc.id,
    employeeId: doc.employeeId,
    firstName: doc.firstName,
    lastName: doc.lastName,
    fullName: doc.fullName,
    email: doc.email,
    department: doc.department,
    site: doc.site,
    phone: doc.phone,
    status: doc.status,
    notes: doc.notes,
    isGuest: doc.isGuest,
    ticketCount,
    createdAt: doc.createdAt ?? "",
  };
}

/** Strips the characters PostgREST treats as filter delimiters / LIKE wildcards. */
function sanitizeTerm(value: string): string {
  return value.replace(/[(),%]/g, " ").trim();
}

/** `full_name / first_name / last_name / email / employee_id / phone` ILIKE. */
function searchClause(raw: string, columns: string[]): string | null {
  const term = sanitizeTerm(raw);
  if (!term) return null;
  return columns.map((column) => `${column}.ilike.%${term}%`).join(",");
}

export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  const supabase = await connectDB();

  const url = new URL(req.url);

  // CSV export of the whole directory (not just the current page).
  if (url.searchParams.get("format") === "csv") {
    requirePermission(user, "exportCsv");
    const statuses = csvParam(url.searchParams.get("status"));

    let query = supabase.from("requestors").select("*");
    if (statuses.length) query = query.in("status", statuses);
    const { data, error } = await query.order("full_name");
    if (error) throw new DatabaseError(error);

    const rows = ((data ?? []) as Row[]).map(mapRequestorRow);
    const csv = toCsv(
      ["employeeId", "firstName", "lastName", "email", "department", "site", "phone", "status", "notes"],
      rows.map((doc) => ({
        employeeId: doc.employeeId,
        firstName: doc.firstName,
        lastName: doc.lastName,
        email: doc.email,
        department: doc.department,
        site: doc.site,
        phone: doc.phone,
        status: doc.status,
        notes: doc.notes,
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
    let query = supabase.from("requestors").select("*").eq("status", "active");
    const clause = searchClause(search, ["full_name", "email", "employee_id"]);
    if (clause) query = query.or(clause);
    const { data, error } = await query.order("full_name").limit(25);
    if (error) throw new DatabaseError(error);
    return NextResponse.json({ requestors: ((data ?? []) as Row[]).map((row) => toDTO(mapRequestorRow(row))) });
  }

  const search = (url.searchParams.get("search") ?? "").trim();
  const statuses = csvParam(url.searchParams.get("status"));
  const departments = csvParam(url.searchParams.get("department"));

  const page = intParam(url.searchParams.get("page"), 1, { min: 1 });
  const pageSize = intParam(url.searchParams.get("pageSize"), 25, { min: 1, max: 200 });

  let query = supabase.from("requestors").select("*", { count: "exact" });
  const clause = searchClause(search, ["full_name", "first_name", "last_name", "email", "employee_id", "phone"]);
  if (clause) query = query.or(clause);
  if (statuses.length) query = query.in("status", statuses);
  if (departments.length) query = query.in("department", departments);

  const { data, count, error } = await query
    .order("full_name")
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new DatabaseError(error);

  const rows = (data ?? []) as Row[];
  const total = count ?? rows.length;

  return NextResponse.json({
    requestors: rows.map((row) => toDTO(mapRequestorRow(row))),
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

  const supabase = await connectDB();

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

  const { data: duplicate } = await supabase
    .from("requestors")
    .select("id")
    .eq("employee_id", employeeId)
    .maybeSingle<{ id: unknown }>();
  if (duplicate) {
    return NextResponse.json(
      { error: "duplicate", message: `Employee ID "${employeeId}" already exists.` },
      { status: 409 },
    );
  }

  const { data, error } = await supabase
    .from("requestors")
    .insert(
      requestorFieldsToRow({
        employeeId,
        firstName,
        lastName,
        fullName: buildFullName(firstName, lastName),
        email,
        department: (body.department ?? "").trim(),
        site: (body.site ?? "").trim(),
        phone: (body.phone ?? "").trim(),
        status: DIRECTORY_STATUSES.includes((body.status ?? "") as never) ? body.status : "active",
        notes: body.notes ?? "",
        createdBy: user.id,
      }),
    )
    .select("*")
    .single<Row>();
  if (error) throw new DatabaseError(error);

  const doc = mapRequestorRow(data);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "requestor.create",
    entity: "Requestor",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { employeeId },
  });

  return NextResponse.json({ requestor: toDTO(doc) }, { status: 201 });
});
