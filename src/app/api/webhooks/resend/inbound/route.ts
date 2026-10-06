import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { EmailMessage, Requestor, Ticket, User } from "@/lib/models";
import { buildFullName } from "@/lib/models/requestor";
import { getSettings } from "@/lib/server/settings";
import { createTicket, appendRemark } from "@/lib/server/tickets";
import { reserveTicketNumber, extractTicketNumber } from "@/lib/server/ticket-number";
import { verifyInboundSignature, sendAutoAcknowledgement, send } from "@/lib/server/resend";
import { normalizeInboundBody } from "@/lib/server/sanitize";
import { payloadHash, enforce, webhookRule } from "@/lib/server/rate-limit";
import { storeBuffer } from "@/lib/server/gridfs";
import { writeAuditLog } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

/**
 * Resend inbound webhook.
 *
 * Forwarded Gmail -> Resend inbound address -> here. Four things matter:
 *  1. the signature is verified before anything is parsed or stored
 *  2. `messageId` dedupes, so a Resend retry cannot double-create a ticket
 *  3. replies that carry a ticket number in the subject thread onto that ticket
 *  4. anything unmatched becomes a new ticket and gets an auto-ack containing
 *     its ticket number, which is what makes the *next* reply match
 */
export const POST = async (req: Request) => {
  const limited = await enforce(await webhookRule(req));
  if (limited) return limited;
  return handleInbound(req);
};

async function handleInbound(req: Request): Promise<NextResponse> {
  // Raw body is required for signature verification, so read it once as text
  // and parse from that string.
  const rawBody = await req.text();
  const signature = req.headers.get("svix-signature") ?? req.headers.get("x-resend-signature");
  const timestamp =
    req.headers.get("svix-timestamp") ?? req.headers.get("x-resend-timestamp");

  const signatureValid = await verifyInboundSignature(rawBody, signature, timestamp);
  if (!signatureValid) {
    await writeAuditLog({
      action: "email.inbound.rejected",
      entity: "EmailMessage",
      ip: req.headers.get("x-forwarded-for") ?? "",
      meta: { reason: "bad_signature" },
    });
    return NextResponse.json(
      { error: "invalid_signature", message: "Webhook signature verification failed." },
      { status: 401 },
    );
  }

  let payload: InboundPayload;
  try {
    payload = JSON.parse(rawBody) as InboundPayload;
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Body must be valid JSON." },
      { status: 400 },
    );
  }

  const messageId = (payload.messageId ?? payload.message_id ?? "").trim();
  if (!messageId) {
    return NextResponse.json(
      { error: "bad_request", message: "Payload is missing a messageId." },
      { status: 400 },
    );
  }

  await connectDB();

  // ── Dedupe ────────────────────────────────────────────────────────────────
  const existing = await EmailMessage.findOne({ messageId }).lean<{
    ticket: unknown;
    autoCreatedTicket: boolean;
  }>();
  if (existing) {
    return NextResponse.json({
      ok: true,
      deduplicated: true,
      ticketId: existing.ticket ? String(existing.ticket) : null,
    });
  }

  const settings = await getSettings();

  const from = firstAddress(payload.from);
  const to = toList(payload.to);
  const subject = (payload.subject ?? "").trim();
  const { textBody, htmlBody } = normalizeInboundBody({
    text: payload.text ?? payload.textBody,
    html: payload.html ?? payload.htmlBody,
  });

  const body = textBody || htmlBody || "(no message body)";
  const threadId = payload.threadId ?? payload.thread_id ?? payload.inReplyTo ?? undefined;

  // Store attachments first so the ticket can reference them.
  const attachmentIds: string[] = [];
  for (const attachment of payload.attachments ?? []) {
    try {
      const buffer = Buffer.from(attachment.content ?? "", "base64");
      if (buffer.length === 0) continue;
      const stored = await storeBuffer({
        buffer,
        filename: attachment.filename ?? "attachment",
        contentType: attachment.contentType ?? "application/octet-stream",
        tags: { kind: "email-attachment", messageId },
      });
      attachmentIds.push(stored.fileId);
    } catch (error) {
      console.error("[webhook] attachment skipped:", error);
    }
  }

  // ── Find an existing ticket ───────────────────────────────────────────────
  const matched = await findTargetTicket({
    subject,
    threadId,
    messageId,
    // Our own outbound replies carry this header, so a reply from the help desk
    // itself still threads back onto the ticket.
    headerTicketId: ticketIdFromHeaders(req.headers),
  });

  if (matched) {
    const messageDoc = await EmailMessage.create({
      ticket: matched._id,
      direction: "in",
      provider: "resend",
      resendId: payload.id,
      messageId,
      threadId,
      from,
      to,
      cc: toList(payload.cc),
      subject,
      textBody,
      htmlBody,
      attachments: attachmentIds,
      rawPayloadHash: payloadHash(rawBody),
      processedAt: new Date(),
      autoCreatedTicket: false,
    });

    // Record the sender as an author even when they are an agent replying from
    // Gmail - the rule is that agent replies must still enter the ticket.
    const senderIsStaff = await findStaffByEmail(from);
    const authorName = await displayNameFor(from);

    await appendRemark(matched, {
      type: "email-in",
      content: body,
      authorName,
      authorRef: senderIsStaff?._id ? String(senderIsStaff._id) : null,
      attachments: attachmentIds,
      emailMessageId: messageId,
    });

    await Ticket.updateOne(
      { _id: matched._id },
      {
        $addToSet: { emailMessageIds: messageId },
        $set: { lastActivityAt: new Date() },
      },
    );

    // Keep the thread linked even if the first message had no thread id.
    if (!matched.emailThreadId && threadId) {
      await Ticket.updateOne({ _id: matched._id }, { $set: { emailThreadId: threadId } });
    }

    await notifyAssignedTechnician(matched, authorName, subject);

    await writeAuditLog({
      action: "email.inbound.threaded",
      entity: "Ticket",
      entityId: String(matched._id),
      meta: { messageId, ticketNumber: matched.ticketNumber, from },
    });

    return NextResponse.json({
      ok: true,
      threaded: true,
      ticketId: String(matched._id),
      ticketNumber: matched.ticketNumber,
      emailMessageId: String(messageDoc._id),
    });
  }

  // ── No match: create a ticket ─────────────────────────────────────────────
  const requestor = await findOrCreateRequestor(from, payload.fromName);

  const reserved = await reserveTicketNumber(settings);

  const ticket = await createTicket(
    {
      ticketNumber: reserved.ticketNumber,
      patternVersion: reserved.patternVersion,
      subject: subject || "(no subject)",
      description: body,
      requestorId: requestor ? String(requestor._id) : null,
      mode: settings.email.autoTicketMode || "Email",
      servicesGroup: settings.email.autoTicketServicesGroup,
      priority: settings.email.autoTicketPriority || undefined,
      status: settings.email.autoTicketStatus || "Pending",
      source: "email",
      emailThreadId: threadId,
      emailMessageIds: [messageId],
      attachments: attachmentIds,
      remarks: `Auto-created from inbound email sent by ${from}.`,
    },
    null,
  );

  await EmailMessage.create({
    ticket: ticket._id,
    direction: "in",
    provider: "resend",
    resendId: payload.id,
    messageId,
    threadId,
    from,
    to,
    cc: toList(payload.cc),
    subject,
    textBody,
    htmlBody,
    attachments: attachmentIds,
    rawPayloadHash: payloadHash(rawBody),
    processedAt: new Date(),
    autoCreatedTicket: true,
  });

  // The auto-ack carries the ticket number in its subject, which is what lets
  // the requestor's next reply thread back onto this ticket.
  let ackSent = false;
  if (settings.email.sendAutoAcknowledgement) {
    const ack = await sendAutoAcknowledgement({
      ticketNumber: ticket.ticketNumber,
      to: from,
      subject: ticket.subject,
      ticketId: String(ticket._id),
    });
    ackSent = ack.ok;

    if (ack.ok) {
      await EmailMessage.create({
        ticket: ticket._id,
        direction: "out",
        provider: "resend",
        resendId: ack.resendId,
        messageId: ack.messageId ?? `ack-${ticket.ticketNumber}`,
        threadId,
        from: settings.resendFromEmail || process.env.EMAIL_FROM || "",
        to: [from],
        subject: `[${ticket.ticketNumber}] ${ticket.subject}`,
        textBody: `Your ticket ${ticket.ticketNumber} has been received.`,
        processedAt: new Date(),
        autoCreatedTicket: false,
      });

      await appendRemark(ticket, {
        type: "system",
        content: `Auto-acknowledgement sent to ${from}`,
        authorName: "System",
      });
    } else if (ack.error) {
      await appendRemark(ticket, {
        type: "system",
        content: `Auto-acknowledgement failed: ${ack.error}`,
        authorName: "System",
      });
    }
  }

  await writeAuditLog({
    action: "email.inbound.created",
    entity: "Ticket",
    entityId: String(ticket._id),
    meta: {
      messageId,
      ticketNumber: ticket.ticketNumber,
      from,
      autoAckSent: ackSent,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      created: true,
      ticketId: String(ticket._id),
      ticketNumber: ticket.ticketNumber,
      autoAcknowledged: ackSent,
    },
    { status: 201 },
  );
}

type InboundPayload = {
  id?: string;
  messageId?: string;
  message_id?: string;
  threadId?: string;
  thread_id?: string;
  inReplyTo?: string;
  from?: string;
  fromName?: string;
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  text?: string;
  textBody?: string;
  html?: string;
  htmlBody?: string;
  attachments?: Array<{ filename?: string; contentType?: string; content?: string }>;
};

function firstAddress(value: string | undefined): string {
  if (!value) return "";
  // "Name <a@b.c>" -> "a@b.c"
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim().toLowerCase();
}

function toList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(firstAddress).filter(Boolean);
}

/**
 * Locates the ticket an inbound message belongs to, in priority order:
 *   1. an `X-Ticket-Id` header (our own outbound replies)
 *   2. a ticket number embedded in the subject, per the configured pattern
 *   3. an existing email thread
 *   4. an `In-Reply-To` message id we have already stored
 */
/** Reads the X-Ticket-Id header our outbound replies set. */
function ticketIdFromHeaders(headers: Headers): string | undefined {
  const value = headers.get("x-ticket-id");
  return value ? value.trim() : undefined;
}

/** Minimal ticket shape this handler needs, avoiding `any`. */
type InboundTicket = {
  _id: unknown;
  ticketNumber: string;
  subject: string;
  emailThreadId?: string;
  emailMessageIds?: string[];
  technician?: unknown;
};

async function findTargetTicket(params: {
  subject: string;
  threadId?: string;
  messageId: string;
  headerTicketId?: string;
}): Promise<InboundTicket | null> {
  const asTicket = (doc: Record<string, unknown> | null): InboundTicket | null =>
    doc
      ? {
          _id: doc._id,
          ticketNumber: String(doc.ticketNumber ?? ""),
          subject: String(doc.subject ?? ""),
          emailThreadId: doc.emailThreadId ? String(doc.emailThreadId) : undefined,
          emailMessageIds: ((doc.emailMessageIds ?? []) as unknown[]).map(String),
          technician: doc.technician ?? null,
        }
      : null;

  if (params.headerTicketId) {
    const byHeader = asTicket(await Ticket.findById(params.headerTicketId).lean<Record<string, unknown>>());
    if (byHeader) return byHeader;
  }

  const settings = await getSettings();
  const ticketNumber = extractTicketNumber(params.subject, settings);
  if (ticketNumber) {
    const byNumber = asTicket(
      await Ticket.findOne({ ticketNumber }).lean<Record<string, unknown>>(),
    );
    if (byNumber) return byNumber;
  }

  if (params.threadId) {
    const byThread = asTicket(
      await Ticket.findOne({ emailThreadId: params.threadId })
        .sort({ dateCreated: -1 })
        .lean<Record<string, unknown>>(),
    );
    if (byThread) return byThread;
  }

  // Reply-to a message we already handled.
  const byMessageId = await EmailMessage.findOne({
    messageId: params.messageId,
    ticket: { $ne: null },
  }).lean<{ ticket?: unknown }>();
  if (byMessageId?.ticket) {
    const byReply = asTicket(
      await Ticket.findById(byMessageId.ticket as string).lean<Record<string, unknown>>(),
    );
    if (byReply) return byReply;
  }

  return null;
}

async function findStaffByEmail(email: string) {
  if (!email) return null;
  const staff = await User.findOne({ email: email.toLowerCase(), status: "active" })
    .select("name _id")
    .lean<{ name?: string; _id?: unknown }>();
  return staff;
}

/** Best-effort display name for an inbound sender. */
async function displayNameFor(email: string): Promise<string> {
  if (!email) return "";
  const staff = await findStaffByEmail(email);
  if (staff?.name) return staff.name;
  const requestorName = await resolveSenderName(email);
  return requestorName ?? email;
}

async function resolveSenderName(email: string): Promise<string | null> {
  if (!email) return null;
  const requestor = await Requestor.findOne({ email: email.toLowerCase() })
    .select("fullName")
    .lean<{ fullName?: string }>();
  return requestor?.fullName ?? null;
}

/**
 * Finds the requestor by sender address, creating a guest record when the
 * sender is unknown. Guests are flagged so the directory can be reviewed later.
 */
async function findOrCreateRequestor(email: string, displayName?: string) {
  if (!email) return null;

  const existing = await Requestor.findOne({ email: email.toLowerCase() });
  if (existing) return existing;

  const name = (displayName ?? "").trim() || email.split("@")[0] || "Unknown";
  const parts = name.split(/\s+/);
  const firstName = parts[0] ?? name;
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "-";

  // Generated employee id for a guest; the real one can be filled in later.
  const employeeId = `GUEST-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  try {
    return await Requestor.create({
      employeeId,
      firstName,
      lastName,
      fullName: buildFullName(firstName, lastName === "-" ? "" : lastName),
      email: email.toLowerCase(),
      status: "active",
      isGuest: true,
      notes: `Auto-created from inbound email on ${new Date().toISOString()}.`,
    });
  } catch {
    // Duplicate email race: fall back to the record that won.
    return Requestor.findOne({ email: email.toLowerCase() });
  }
}

/** Emails the assigned technician about a new inbound reply. */
async function notifyAssignedTechnician(
  ticket: InboundTicket,
  fromName: string,
  subject: string,
) {
  const settings = await getSettings();
  if (!settings.email.notifyTechnicianOnInbound) return;
  if (!ticket.technician) return;

  const technician = await User.findById(String(ticket.technician))
    .select("email name")
    .lean<{ email?: string; name?: string }>();
  if (!technician?.email) return;

  const from = settings.resendFromEmail || String(process.env.EMAIL_FROM ?? "");
  if (!from) return;

  await send({
    from,
    to: technician.email,
    subject: `New reply on ${ticket.ticketNumber}: ${subject}`.slice(0, 200),
    text: [
      `${fromName} replied to ticket ${ticket.ticketNumber}.`,
      ``,
      `Subject: ${subject}`,
      ``,
      `Open the ticket: /tickets/${String(ticket._id)}`,
    ].join("\n"),
    replyTo: settings.inboundEmail || process.env.INBOUND_EMAIL,
    headers: { "X-Ticket-Number": ticket.ticketNumber },
  });
}

export { payloadHash };