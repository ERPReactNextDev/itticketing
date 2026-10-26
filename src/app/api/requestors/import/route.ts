import { NextResponse } from "next/server";
import { connectDB, DatabaseError, UNIQUE_VIOLATION, type SupabaseClient } from "@/lib/db/supabase";
import { buildFullName, requestorFieldsToRow } from "@/lib/db/mappers";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson } from "@/lib/server/http";
import { parseCsvObjects } from "@/lib/shared/csv";

export const dynamic = "force-dynamic";

type ImportBody = {
  /** Raw CSV text. */
  csv?: string;
  /**
   * When true an existing employeeId is updated instead of skipped. Off by
   * default so a re-import cannot silently overwrite curated data.
   */
  updateExisting?: boolean;
};

type ImportReport = {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; employeeId: string; message: string }>;
};

/**
 * Inserts requestor rows, degrading to one-at-a-time on a unique collision.
 *
 * The directory has two unique keys (`employee_id` and lower-cased `email`), so
 * a single clashing row would otherwise abort the whole batch. The retry keeps
 * a 900-row import resilient while the common case still uses one statement.
 */
async function insertRequestors(
  supabase: SupabaseClient,
  rows: Array<Record<string, unknown>>,
  report: ImportReport,
): Promise<void> {
  const { data, error } = await supabase.from("requestors").insert(rows).select("id");
  if (!error) {
    report.created += data?.length ?? rows.length;
    return;
  }
  if (error.code !== UNIQUE_VIOLATION) throw new DatabaseError(error);

  for (const row of rows) {
    const { error: rowError } = await supabase.from("requestors").insert(row);
    if (!rowError) report.created += 1;
    else if (rowError.code === UNIQUE_VIOLATION) report.skipped += 1;
    else throw new DatabaseError(rowError);
  }
}

/**
 * CSV import for the requestor directory.
 *
 * Accepts `employeeId, firstName, lastName, email, department, site, phone`
 * in any column order, with headers matched case-insensitively. Rows that fail
 * validation are reported individually instead of aborting the whole file, so
 * a single bad line cannot block a 900-row import.
 */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageRequestors");

  const body = await readJson<ImportBody>(req);
  const csv = body.csv ?? "";
  if (!csv.trim()) {
    return NextResponse.json(
      { error: "bad_request", message: "The CSV file is empty." },
      { status: 400 },
    );
  }

  const rows = parseCsvObjects(csv);
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "bad_request", message: "No data rows found. The first line must be a header row." },
      { status: 400 },
    );
  }

  const supabase = await connectDB();

  const report: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [] };
  const operations: Array<Record<string, unknown>> = [];

  rows.forEach((row, index) => {
    // Row numbers are 1-based and include the header, matching what a
    // spreadsheet shows the user.
    const rowNumber = index + 2;

    const employeeId = (row.employeeid ?? row.id ?? "").trim();
    const firstName = (row.firstname ?? row.first ?? "").trim();
    const lastName = (row.lastname ?? row.last ?? "").trim();

    if (!employeeId) {
      report.errors.push({ row: rowNumber, employeeId: "", message: "Employee ID is missing." });
      return;
    }
    if (!firstName || !lastName) {
      report.errors.push({
        row: rowNumber,
        employeeId,
        message: "First name and last name are both required.",
      });
      return;
    }

    const email = (row.email ?? "").trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      report.errors.push({ row: rowNumber, employeeId, message: `"${email}" is not a valid email.` });
      return;
    }

    const status = (row.status ?? "").trim().toLowerCase() === "inactive" ? "inactive" : "active";

    operations.push({
      employeeId,
      firstName,
      lastName,
      fullName: buildFullName(firstName, lastName),
      email,
      department: (row.department ?? "").trim(),
      site: (row.site ?? "").trim(),
      phone: (row.phone ?? "").trim(),
      status,
      notes: (row.notes ?? "").trim(),
    });
  });

  const employeeIds = operations.map((op) => String(op.employeeId));
  const { data: existing } = await supabase
    .from("requestors")
    .select("employee_id")
    .in("employee_id", employeeIds);
  const existingIds = new Set(
    ((existing ?? []) as Array<{ employee_id: string }>).map((doc) => doc.employee_id),
  );

  const toInsert: Array<Record<string, unknown>> = [];
  const toUpdate: Array<Record<string, unknown>> = [];
  const seenIds = new Set<string>();

  for (const op of operations) {
    const employeeId = String(op.employeeId);
    if (existingIds.has(employeeId)) {
      if (body.updateExisting) toUpdate.push(op);
      else report.skipped += 1;
      continue;
    }
    // The same file can list an employeeId twice; keep the first and skip the
    // rest so a duplicate cannot abort the batch.
    if (seenIds.has(employeeId)) {
      report.skipped += 1;
      continue;
    }
    seenIds.add(employeeId);
    toInsert.push(op);
  }

  if (toInsert.length > 0) {
    const insertRows = toInsert.map((op) => requestorFieldsToRow({ ...op, createdBy: user.id }));
    await insertRequestors(supabase, insertRows, report);
  }

  for (const op of toUpdate) {
    const { error } = await supabase
      .from("requestors")
      .update(requestorFieldsToRow(op))
      .eq("employee_id", String(op.employeeId));
    if (error) throw new DatabaseError(error);
    report.updated += 1;
  }

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "requestor.import",
    entity: "Requestor",
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { created: report.created, updated: report.updated, skipped: report.skipped },
  });

  return NextResponse.json({ report });
});
