import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { queryTickets, type TicketListQuery } from "@/lib/server/ticket-query";
import { createTicket, TicketValidationError } from "@/lib/server/tickets";
import { reserveTicketNumber } from "@/lib/server/ticket-number";
import { ticketCreateRule, enforce, clientIp, userAgent } from "@/lib/server/rate-limit";
import { writeAuditLog } from "@/lib/server/audit";
import { withApi, readJson, intParam, boolParam, csvParam } from "@/lib/server/http";
import { storeBuffer } from "@/lib/server/gridfs";

export const dynamic = "force-dynamic";

export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  // Any role that can see tickets may list them; scoping happens in the query.
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
    openOnly: boolParam(url.searchParams.get("openOnly")),
    breachedOnly: boolParam(url.searchParams.get("breachedOnly")),
    assignedTo: url.searchParams.get("assignedTo") ?? undefined,
    from: parseDateParam(url.searchParams.get("from")),
    to: parseDateParam(url.searchParams.get("to")),
    sort: (url.searchParams.get("sort") as TicketListQuery["sort"]) ?? "newest",
    page: intParam(url.searchParams.get("page"), 1, { min: 1 }),
    pageSize: intParam(url.searchParams.get("pageSize"), 25, { min: 1, max: 200 }),
  };

  const result = await queryTickets(query, user);
  return NextResponse.json(result);
});

function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type CreateBody = {
  subject?: string;
  description?: string;
  requestorId?: string | null;
  department?: string;
  requestType?: string;
  typeOfConcern?: string;
  mode?: string;
  servicesGroup?: string;
  site?: string;
  priority?: string;
  status?: string;
  scheduledDate?: string | null;
  remarks?: string;
  source?: "manual" | "email" | "webform";
  /** base64 payloads, uploaded to GridFS before the ticket is created. */
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
};

export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "createTicket");

  const body = await readJson<CreateBody>(req);

  const limited = await enforce(await ticketCreateRule(req, user.id));
  if (limited) return limited;

  await connectDB();

  // Store attachments first so the ticket never references a partial upload.
  const storedIds: string[] = [];
  for (const attachment of body.attachments ?? []) {
    try {
      const buffer = Buffer.from(attachment.content, "base64");
      const stored = await storeBuffer({
        buffer,
        filename: attachment.filename || "attachment",
        contentType: attachment.contentType,
        tags: { kind: "ticket-attachment", uploadedBy: user.id },
      });
      storedIds.push(stored.fileId);
    } catch (error) {
      return NextResponse.json(
        {
          error: "invalid_attachment",
          message: error instanceof Error ? error.message : "Attachment upload failed.",
        },
        { status: 400 },
      );
    }
  }

  // Reserve the number immediately before insert. Concurrent creates each get a
  // distinct sequence because the counter uses an atomic $inc.
  const reserved = await reserveTicketNumber();

  try {
    const ticket = await createTicket(
      {
        ticketNumber: reserved.ticketNumber,
        patternVersion: reserved.patternVersion,
        subject: body.subject ?? "",
        description: body.description ?? "",
        requestorId: body.requestorId ?? null,
        department: body.department,
        requestType: body.requestType,
        typeOfConcern: body.typeOfConcern,
        mode: body.mode,
        servicesGroup: body.servicesGroup,
        site: body.site,
        priority: body.priority,
        status: body.status,
        scheduledDate: body.scheduledDate ? new Date(body.scheduledDate) : null,
        remarks: body.remarks,
        source: body.source ?? "manual",
        attachments: storedIds,
      },
      user,
    );

    await writeAuditLog({
      actorId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      action: "ticket.create",
      entity: "Ticket",
      entityId: String(ticket._id),
      ip: clientIp(req),
      userAgent: userAgent(req),
      meta: { ticketNumber: ticket.ticketNumber, subject: ticket.subject },
    });

    const { loadTicketDTO } = await import("@/lib/server/ticket-query");
    const dto = await loadTicketDTO(String(ticket._id), user);

    return NextResponse.json({ ticket: dto }, { status: 201 });
  } catch (error) {
    if (error instanceof TicketValidationError) {
      return NextResponse.json(
        { error: "validation_error", message: error.message, field: error.field },
        { status: 400 },
      );
    }
    throw error;
  }
});