import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { loadTicketDTO } from "@/lib/server/ticket-query";
import { appendRemark } from "@/lib/server/tickets";
import { sendTicketReply, buildTicketSubject, type EmailAttachment } from "@/lib/server/resend";
import { storeBuffer, deleteFile } from "@/lib/server/storage";
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

  const ticket = await loadTicketDTO(id, user);
  if (!ticket) {
    return NextResponse.json(
      { error: "not_found", message: "Ticket not found, or you do not have access to it." },
      { status: 404 },
    );
  }

  const settings = await getSettings();

  // Prefer the live requestor email; fall back to the snapshot for old tickets.
  const to = normalizeRecipients(body.to ?? ticket.requestorEmail);
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

  // Attachments are stored first so the same file both goes out with the email
  // and stays attached to the ticket afterwards. A rejected upload (wrong type
  // or too large) fails the request before anything is sent.
  const storedIds: string[] = [];
  const outgoing: EmailAttachment[] = [];
  for (const attachment of body.attachments ?? []) {
    if (!attachment?.content) continue;
    try {
      const buffer = Buffer.from(attachment.content, "base64");
      const stored = await storeBuffer({
        buffer,
        filename: attachment.filename || "attachment",
        contentType: attachment.contentType || "application/octet-stream",
        tags: { ticket: String(ticket.id) },
      });
      storedIds.push(stored.fileId);
      outgoing.push({
        filename: stored.filename,
        content: buffer,
        contentType: stored.contentType,
      });
    } catch (error) {
      await Promise.all(storedIds.map((fileId) => deleteFile(fileId)));
      return NextResponse.json(
        {
          error: "invalid_attachment",
          message: error instanceof Error ? error.message : "Attachment upload failed.",
        },
        { status: 400 },
      );
    }
  }

  const result = await sendTicketReply({
    ticketNumber: ticket.ticketNumber,
    subject: originalSubject,
    body: text,
    to,
    ticketId: String(ticket.id),
    threadId: ticket.emailThreadId,
    cc: body.cc ?? [],
    attachments: outgoing,
  });

  if (!result.ok) {
    // The email never left, so the stored copies would only become orphans.
    await Promise.all(storedIds.map((fileId) => deleteFile(fileId)));
    await writeAuditLog({
      actorId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      action: "ticket.reply.failed",
      entity: "Ticket",
      entityId: String(ticket.id),
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

  const supabase = await connectDB();
  const { error: insertError } = await supabase.from("email_messages").insert({
    ticket_id: String(ticket.id),
    direction: "out",
    provider: "resend",
    resend_id: result.resendId ?? null,
    message_id: messageId,
    thread_id: ticket.emailThreadId ?? null,
    from_address: settings.resendFromEmail || process.env.EMAIL_FROM || "",
    to_addresses: to,
    cc_addresses: body.cc ?? [],
    subject,
    text_body: text,
    attachments: storedIds,
    processed_at: new Date().toISOString(),
    auto_created_ticket: false,
  });
  if (insertError) throw new DatabaseError(insertError);

  // The outbound email appears in the timeline as a remark, so the ticket
  // history reads as one conversation regardless of which channel it came from.
  await appendRemark(ticket, {
    type: "email-out",
    content: text,
    authorName: user.name,
    authorRef: user.id,
    attachments: storedIds,
    emailMessageId: messageId,
  });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "ticket.reply.sent",
    entity: "Ticket",
    entityId: String(ticket.id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { ticketNumber: ticket.ticketNumber, to, attachments: storedIds.length },
  });

  return NextResponse.json({
    ok: true,
    messageId,
    subject,
    attachments: storedIds.length,
    message: `Reply sent to ${to.join(", ")}${
      storedIds.length > 0 ? ` with ${storedIds.length} attachment(s)` : ""
    }.`,
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