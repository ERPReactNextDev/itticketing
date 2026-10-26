import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/supabase";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { loadTicketDTO } from "@/lib/server/ticket-query";
import { patchTicket, appendRemark, TicketValidationError } from "@/lib/server/tickets";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";
import { deleteFile } from "@/lib/server/storage";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = withApi(async (_req: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;

  const ticket = await loadTicketDTO(id, user);
  if (!ticket) {
    return NextResponse.json(
      { error: "not_found", message: "Ticket not found, or you do not have access to it." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ticket });
});

type PatchBody = {
  subject?: string;
  description?: string;
  department?: string;
  requestType?: string;
  typeOfConcern?: string;
  mode?: string;
  servicesGroup?: string;
  site?: string;
  priority?: string;
  status?: string;
  scheduledDate?: string | null;
  technician?: string | null;
  requestorId?: string | null;
  attachments?: string[];
  /** Optional note appended alongside the change. */
  note?: string;
};

/** Fields each permission unlocks on a single ticket. */
function allowedFields(user: Awaited<ReturnType<typeof requireUser>>): Set<string> {
  const allowed = new Set<string>(["subject", "description", "requestorId", "attachments"]);
  if (user.permissions.changeStatus) allowed.add("status");
  if (user.permissions.assignTechnician) allowed.add("technician");
  if (user.permissions.closeTicket) allowed.add("priority");
  return allowed;
}

export const PATCH = withApi(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;
  const body = await readJson<PatchBody>(req);

  await connectDB();
  const ticket = await loadTicketDTO(id, user);
  if (!ticket) {
    return NextResponse.json({ error: "not_found", message: "Ticket not found." }, { status: 404 });
  }

  // An agent without editAnyTicket may only edit tickets they own.
  if (!user.permissions.editAnyTicket) {
    const owns =
      (ticket.technician ?? "") === user.id || (ticket.processedBy ?? "") === user.id;
    if (!owns) {
      return NextResponse.json(
        { error: "forbidden", message: "You can only edit tickets assigned to you." },
        { status: 403 },
      );
    }
  }

  const { note, ...patch } = body;
  const changes = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );

  if (Object.keys(changes).length === 0 && !note) {
    throw new ApiInputError("Nothing to update.");
  }

  try {
    await patchTicket(ticket, changes, user, { allowed: allowedFields(user) });

    if (note?.trim()) {
      await appendRemark(ticket, {
        type: "note",
        content: note.trim(),
        authorName: user.name,
        authorRef: user.id,
      });
    }

    await writeAuditLog({
      actorId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      action: "ticket.update",
      entity: "Ticket",
      entityId: String(ticket.id),
      ip: clientIp(req),
      userAgent: userAgent(req),
      meta: { changed: Object.keys(changes) },
    });

    const dto = await loadTicketDTO(String(ticket.id), user);
    return NextResponse.json({ ticket: dto });
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

export const DELETE = withApi(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  requirePermission(user, "deleteTicket");
  const { id } = await params;

  const numericId = Number(id);
  if (!Number.isFinite(numericId)) {
    return NextResponse.json({ error: "not_found", message: "Ticket not found." }, { status: 404 });
  }

  const supabase = await connectDB();
  const { data: row } = await supabase
    .from("tickets")
    .select("id, ticket_id, attachments")
    .eq("id", numericId)
    .maybeSingle<{ id: number; ticket_id: string | null; attachments: string[] | null }>();
  if (!row) {
    return NextResponse.json({ error: "not_found", message: "Ticket not found." }, { status: 404 });
  }

  // Remove stored attachments so orphaned objects do not accumulate.
  const attachmentIds = (row.attachments ?? []).map(String);
  await supabase.from("tickets").delete().eq("id", numericId);
  for (const fileId of attachmentIds) {
    await deleteFile(fileId);
  }

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "ticket.delete",
    entity: "Ticket",
    entityId: String(numericId),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { ticketNumber: row.ticket_id ?? "" },
  });

  return NextResponse.json({ ok: true });
});