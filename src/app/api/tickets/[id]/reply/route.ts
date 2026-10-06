import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { Ticket, EmailMessage } from "@/lib/models";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { appendRemark } from "@/lib/server/tickets";
import { sendTicketReply, buildTicketSubject } from "@/lib/server/resend";
import { getSettings } from "@/lib/server/settings";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type ReplyBody = {
  body?: string;
  /** Defaults to the ticket requestor's snapshot email. */
  to?: string | string[];
  cc?: string[];
  subject?: string;
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
};

/**
 * Sends an agent reply through Resend.
 *
 * The subject is always prefixed with `[ticketNumber]` so the reply threads back
 * onto the ticket when the recipient replies, and `Reply-To` points at the
 * inbound address so the conversation keeps flowing into the ticketing system.
 */
export const POST = withApi(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  requirePermission(user, "sendEmailReply");

  const { id } = await params;
  const body = await readJson<ReplyBody>(req);
  const text = (body.body ?? "").trim();

  if (!text) throw new ApiInputError("Write a message before sending.");

  await connectDB();

  const ticket = await Ticket.findById(id);
  if (!ticket) {
    return NextResponse.json({ error: "not_found", message: "Ticket not found." }, { status: 404 });
  }

  if (!user.permissions.editAnyTicket) {
    const owns =
      (ticket.technician ? String(ticket.technician) : "") === user.id ||
      (ticket.processedBy ? String(ticket.processedBy) : "") === user.id;
    if (!owns) {
      return NextResponse.json(
        { error: "forbidden", message: "You can only reply to tickets assigned to you." },
        { status: 403 },
      );
    }
  }

  const settings = await getSettings();

  // Prefer the live requestor email; fall back to the snapshot for old tickets.
  const snapshotEmail = ticket.requestorSnapshot?.email ?? "";
  const to = normalizeRecipients(body.to ?? snapshotEmail);
  if (to.length === 0) {
    return NextResponse.json(
      {
        error: "no_recipient",
        message: "This ticket has no email address. Add a recipient manually.",
      },
      { status: 400 },
    );
  }

  const originalSubject = body.subject ?? ticket.subject ?? "";
  const subject = buildTicketSubject(ticket.ticketNumber, originalSubject);

  const result = await sendTicketReply({
    ticketNumber: ticket.ticketNumber,
    subject: originalSubject,
    body: text,
    to,
    ticketId: String(ticket._id),
    threadId: ticket.emailThreadId ?? undefined,
    cc: body.cc ?? [],
  });

  if (!result.ok) {
    await writeAuditLog({
      actorId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      action: "ticket.reply.failed",
      entity: "Ticket",
      entityId: String(ticket._id),
      ip: clientIp(req),
      userAgent: userAgent(req),
      meta: { ticketNumber: ticket.ticketNumber, error: result.error },
    });
    return NextResponse.json(
      { error: "send_failed", message: result.error ?? "Could not send the email." },
      { status: 502 },
    );
  }

  const messageId = result.messageId ?? `out-${ticket.ticketNumber}-${Date.now()}`;

  await EmailMessage.create({
    ticket: ticket._id,
    direction: "out",
    provider: "resend",
    resendId: result.resendId,
    messageId,
    threadId: ticket.emailThreadId ?? undefined,
    from: settings.resendFromEmail || process.env.EMAIL_FROM || "",
    to,
    cc: body.cc ?? [],
    subject,
    textBody: text,
    processedAt: new Date(),
    autoCreatedTicket: false,
  });

  // The outbound email appears in the timeline as a remark, so the ticket
  // history reads as one conversation regardless of which channel it came from.
  await appendRemark(ticket, {
    type: "email-out",
    content: text,
    authorName: user.name,
    authorRef: user.id,
    emailMessageId: messageId,
  });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "ticket.reply.sent",
    entity: "Ticket",
    entityId: String(ticket._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { ticketNumber: ticket.ticketNumber, to },
  });

  return NextResponse.json({
    ok: true,
    messageId,
    subject,
    message: `Reply sent to ${to.join(", ")}.`,
  });
});

function normalizeRecipients(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : value.split(/[,;]/);
  return list
    .map((entry) => {
      const match = /<([^>]+)>/.exec(entry);
      return (match ? match[1] : entry).trim().toLowerCase();
    })
    .filter((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry));
}