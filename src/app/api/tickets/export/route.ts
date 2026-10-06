import { NextResponse } from "next/server";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { connectDB } from "@/lib/db/mongoose";
import { Ticket } from "@/lib/models";
import { buildTicketFilter, buildTicketSort } from "@/lib/server/ticket-query";
import { toTicketRowDTO } from "@/lib/server/serialize";
import { toCsv } from "@/lib/shared/csv";
import { csvParam } from "@/lib/server/http";
import type { TicketListQuery } from "@/lib/server/ticket-query";

export const dynamic = "force-dynamic";

/**
 * CSV export.
 *
 * Streams the *entire* filtered result set (not one page) so the export
 * matches what the user is looking at, and reuses the exact same filter builder
 * as the list endpoint so RBAC scoping cannot diverge between the two.
 */
export const GET = withApiExport(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "exportCsv");
  await connectDB();

  const url = new URL(req.url);
  const query: TicketListQuery = {
    search: url.searchParams.get("search") ?? undefined,
    status: csvParam(url.searchParams.get("status")),
    priority: csvParam(url.searchParams.get("priority")),
    department: csvParam(url.searchParams.get("department")),
    technician: csvParam(url.searchParams.get("technician")),
    requestType: csvParam(url.searchParams.get("requestType")),
    site: csvParam(url.searchParams.get("site")),
    source: csvParam(url.searchParams.get("source")),
    openOnly: url.searchParams.get("openOnly") === "true",
    breachedOnly: url.searchParams.get("breachedOnly") === "true",
    sort: "newest",
    page: 1,
    // A generous ceiling keeps a single request from pulling the whole database.
    pageSize: 10_000,
  };

  const filter = buildTicketFilter(query, user);
  const docs = await Ticket.find(filter)
    .sort(buildTicketSort(query.sort))
    .limit(10_000)
    .populate([
      { path: "processedBy", select: "name" },
      { path: "technician", select: "name" },
      { path: "closedBy", select: "name" },
    ])
    .lean<Record<string, unknown>[]>();

  const rows = docs.map((doc) => {
    const dto = toTicketRowDTO(doc);
    return {
      ticketNumber: dto.ticketNumber,
      subject: dto.subject,
      description: dto.description,
      status: dto.statusLabel || dto.status,
      priority: dto.priority.label,
      slaHours: dto.priority.slaHours,
      department: dto.department,
      requestType: dto.requestType,
      typeOfConcern: dto.typeOfConcern,
      mode: dto.mode,
      servicesGroup: dto.servicesGroup,
      site: dto.site,
      requestorName: dto.requestorName,
      requestorEmployeeId: dto.requestorEmployeeId,
      requestorEmail: dto.requestorEmail,
      technician: dto.technicianName,
      processedBy: dto.processedByName,
      closedBy: dto.closedByName,
      source: dto.source,
      dateCreated: dto.dateCreated,
      dateClosed: dto.dateClosed ?? "",
      scheduledDate: dto.scheduledDate ?? "",
      durationSeconds: dto.durationSeconds ?? "",
      slaRemainingSeconds: dto.sla.remainingSeconds ?? "",
      slaBreached: dto.sla.breached ? "yes" : "no",
      isClosed: dto.isClosed ? "yes" : "no",
    };
  });

  const headers = [
    "ticketNumber", "subject", "description", "status", "priority", "slaHours",
    "department", "requestType", "typeOfConcern", "mode", "servicesGroup", "site",
    "requestorName", "requestorEmployeeId", "requestorEmail", "technician",
    "processedBy", "closedBy", "source", "dateCreated", "dateClosed",
    "scheduledDate", "durationSeconds", "slaRemainingSeconds", "slaBreached", "isClosed",
  ];

  const csv = toCsv(headers, rows);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tickets_${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});

/** Local wrapper so the export path returns clean JSON errors too. */
function withApiExport(
  handler: (req: Request) => Promise<NextResponse>,
): (req: Request) => Promise<NextResponse> {
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (error) {
      const { handleApiError } = await import("@/lib/server/http");
      return handleApiError(error);
    }
  };
}