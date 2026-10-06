import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { Requestor, buildFullName } from "@/lib/models";
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

  await connectDB();

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

  const employeeIds = operations.map((op) => op.employeeId as string);
  const existing = await Requestor.find({ employeeId: { $in: employeeIds } })
    .select("employeeId")
    .lean<Array<{ employeeId: string }>>();
  const existingIds = new Set(existing.map((doc) => doc.employeeId));

  const toInsert: Array<Record<string, unknown>> = [];
  const toUpdate: Array<Record<string, unknown>> = [];

  for (const op of operations) {
    if (existingIds.has(op.employeeId as string)) {
      if (body.updateExisting) {
        toUpdate.push(op);
      } else {
        report.skipped += 1;
      }
      continue;
    }
    toInsert.push({ ...op, createdBy: user.id });
  }

  if (toInsert.length > 0) {
    // ordered:false keeps the import resilient when the same file lists a
    // duplicate employeeId twice - the second is skipped, not an error.
    await Requestor.insertMany(toInsert, { ordered: false }).catch((error: unknown) => {
      // Bulk write errors are per-document; surface the duplicate-key count.
      const writeErrors = (error as { writeErrors?: unknown[] })?.writeErrors ?? [];
      const duplicates = writeErrors.filter(
        (we) => (we as { code?: number })?.code === 11000,
      ).length;
      if (duplicates > 0) {
        report.skipped += duplicates;
        const inserted = toInsert.length - duplicates;
        report.created += inserted;
        return;
      }
      throw error;
    });
    if (report.created === 0 && toInsert.length > 0) {
      report.created += toInsert.length;
    }
  }

  for (const op of toUpdate) {
    await Requestor.updateOne(
      { employeeId: op.employeeId },
      {
        $set: {
          firstName: op.firstName,
          lastName: op.lastName,
          fullName: op.fullName,
          email: op.email,
          department: op.department,
          site: op.site,
          phone: op.phone,
          status: op.status,
          notes: op.notes,
        },
      },
    );
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