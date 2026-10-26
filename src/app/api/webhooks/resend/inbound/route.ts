import { NextResponse } from "next/server";
import { connectDB, DatabaseError, UNIQUE_VIOLATION } from "@/lib/db/supabase";
import {
  asStringArray,
  buildFullName,
  composeUserName,
  normalizeUserStatus,
  requestorFieldsToRow,
  str,
} from "@/lib/db/mappers";
import { getSettings } from "@/lib/server/settings";
import { createTicket, appendRemark } from "@/lib/server/tickets";
import { reserveTicketNumber, extractTicketNumber } from "@/lib/server/ticket-number";
import { verifyInboundSignature, sendAutoAcknowledgement, send } from "@/lib/server/resend";
import { normalizeInboundBody } from "@/lib/server/sanitize";
import { payloadHash, enforce, webhookRule } from "@/lib/server/rate-limit";
import { storeBuffer } from "@/lib/server/storage";
import { writeAuditLog } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

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

  const supabase = await connectDB();

  // ── Dedupe ────────────────────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from("email_messages")
    .select("ticket_id")
    .eq("message_id", messageId)
    .maybeSingle<{ ticket_id: string | null }>();
  if (existing) {
    return NextResponse.json({
      ok: true,
      deduplicated: true,
      ticketId: existing.ticket_id ? String(existing.ticket_id) : null,
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
        tags: { kind: "email-attachment", folder: messageId },
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
    const messageRowId = await insertEmailMessage({
      ticketId: String(matched.id),
      direction: "in",
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
      autoCreatedTicket: false,
    });

    // Record the sender as an author even when they are an agent replying from
    // Gmail - the rule is that agent replies must still enter the ticket.
    const senderIsStaff = await findStaffByEmail(from);
    const authorName = await displayNameFor(from);

    await appendRemark({ id: matched.id }, {
      type: "email-in",
      content: body,
      authorName,
      authorRef: senderIsStaff?.id ?? null,
      attachments: attachmentIds,
      emailMessageId: messageId,
    });

    // Appends the message id and links the thread only while it is empty - one
    // statement, so a concurrent inbound message cannot clobber the other.
    const { error: threadError } = await supabase.rpc("thread_ticket_email", {
      p_ticket_id: matched.id,
      p_message_id: messageId,
      p_thread_id: threadId ?? null,
    });
    if (threadError) throw new DatabaseError(threadError);

    await notifyAssignedTechnician(matched, authorName, subject);

    await writeAuditLog({
      action: "email.inbound.threaded",
      entity: "Ticket",
      entityId: String(matched.id),
      meta: { messageId, ticketNumber: matched.ticketNumber, from },
    });

    return NextResponse.json({
      ok: true,
      threaded: true,
      ticketId: String(matched.id),
      ticketNumber: matched.ticketNumber,
      emailMessageId: String(messageRowId),
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
      requestorId: requestor ? requestor.id : null,
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

  const ticketId = Number(ticket._id);
  const ticketNumber = str(ticket.ticketNumber);
  const ticketSubject = str(ticket.subject);

  await insertEmailMessage({
    ticketId: String(ticketId),
    direction: "in",
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
    autoCreatedTicket: true,
  });

  // The auto-ack carries the ticket number in its subject, which is what lets
  // the requestor's next reply thread back onto this ticket.
  let ackSent = false;
  if (settings.email.sendAutoAcknowledgement) {
    const ack = await sendAutoAcknowledgement({
      ticketNumber,
      to: from,
      subject: ticketSubject,
      ticketId: String(ticketId),
    });
    ackSent = ack.ok;

    if (ack.ok) {
      await insertEmailMessage({
        ticketId: String(ticketId),
        direction: "out",
        resendId: ack.resendId,
        messageId: ack.messageId ?? `ack-${ticketNumber}`,
        threadId,
        from: settings.resendFromEmail || process.env.EMAIL_FROM || "",
        to: [from],
        subject: `[${ticketNumber}] ${ticketSubject}`,
        textBody: `Your ticket ${ticketNumber} has been received.`,
        autoCreatedTicket: false,
      });

      await appendRemark({ id: ticketId }, {
        type: "system",
        content: `Auto-acknowledgement sent to ${from}`,
        authorName: "System",
      });
    } else if (ack.error) {
      await appendRemark({ id: ticketId }, {
        type: "system",
        content: `Auto-acknowledgement failed: ${ack.error}`,
        authorName: "System",
      });
    }
  }

  await writeAuditLog({
    action: "email.inbound.created",
    entity: "Ticket",
    entityId: String(ticketId),
    meta: {
      messageId,
      ticketNumber,
      from,
      autoAckSent: ackSent,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      created: true,
      ticketId: String(ticketId),
      ticketNumber,
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

/** Reads the X-Ticket-Id header our outbound replies set. */
function ticketIdFromHeaders(headers: Headers): string | undefined {
  const value = headers.get("x-ticket-id");
  return value ? value.trim() : undefined;
}

/** Minimal ticket shape this handler needs, avoiding `any`. */
type InboundTicket = {
  id: number;
  ticketNumber: string;
  subject: string;
  emailThreadId: string | null;
  emailMessageIds: string[];
  technicianId: string | null;
};

function asTicket(row: Row | null): InboundTicket | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    ticketNumber: str(row.ticket_id),
    subject: str(row.ticket_subject),
    emailThreadId: row.email_thread_id ? String(row.email_thread_id) : null,
    emailMessageIds: asStringArray(row.email_message_ids),
    technicianId: row.technician_id ? String(row.technician_id) : null,
  };
}

/**
 * Locates the ticket an inbound message belongs to, in priority order:
 *   1. an `X-Ticket-Id` header (our own outbound replies)
 *   2. a ticket number embedded in the subject, per the configured pattern
 *   3. an existing email thread
 *   4. an `In-Reply-To` message id we have already stored
 */
async function findTargetTicket(params: {
  subject: string;
  threadId?: string;
  messageId: string;
  headerTicketId?: string;
}): Promise<InboundTicket | null> {
  const supabase = await connectDB();

  const byId = async (raw: unknown): Promise<InboundTicket | null> => {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const { data } = await supabase
      .from("tickets")
      .select("*")
      .eq("id", numeric)
      .maybeSingle<Row>();
    return asTicket(data);
  };

  if (params.headerTicketId) {
    const byHeader = await byId(params.headerTicketId);
    if (byHeader) return byHeader;
  }

  const settings = await getSettings();
  const ticketNumber = extractTicketNumber(params.subject, settings);
  if (ticketNumber) {
    const { data } = await supabase
      .from("tickets")
      .select("*")
      .eq("ticket_id", ticketNumber)
      .maybeSingle<Row>();
    const byNumber = asTicket(data);
    if (byNumber) return byNumber;
  }

  if (params.threadId) {
    const { data } = await supabase
      .from("tickets")
      .select("*")
      .eq("email_thread_id", params.threadId)
      .order("date_created", { ascending: false })
      .limit(1)
      .maybeSingle<Row>();
    const byThread = asTicket(data);
    if (byThread) return byThread;
  }

  // Reply-to a message we already handled.
  const { data: stored } = await supabase
    .from("email_messages")
    .select("ticket_id")
    .eq("message_id", params.messageId)
    .not("ticket_id", "is", null)
    .maybeSingle<{ ticket_id: string | null }>();
  if (stored?.ticket_id) {
    const byReply = await byId(stored.ticket_id);
    if (byReply) return byReply;
  }

  return null;
}

type EmailInsert = {
  ticketId: string | null;
  direction: "in" | "out";
  resendId?: string;
  messageId: string;
  threadId?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: string[];
  rawPayloadHash?: string;
  autoCreatedTicket: boolean;
};

/** Inserts one row into `email_messages` and returns its numeric id. */
async function insertEmailMessage(input: EmailInsert): Promise<number> {
  const supabase = await connectDB();
  const { data, error } = await supabase
    .from("email_messages")
    .insert({
      ticket_id: input.ticketId,
      direction: input.direction,
      provider: "resend",
      resend_id: input.resendId ?? null,
      message_id: input.messageId,
      thread_id: input.threadId ?? null,
      from_address: input.from,
      to_addresses: input.to,
      cc_addresses: input.cc ?? [],
      subject: input.subject,
      text_body: input.textBody ?? "",
      html_body: input.htmlBody ?? "",
      attachments: input.attachments ?? [],
      raw_payload_hash: input.rawPayloadHash ?? "",
      processed_at: new Date().toISOString(),
      auto_created_ticket: input.autoCreatedTicket,
    })
    .select("id")
    .single<{ id: number }>();
  if (error) throw new DatabaseError(error);
  return data.id;
}

/** Active staff member for an address, or null. */
async function findStaffByEmail(
  email: string,
): Promise<{ id: string; name: string } | null> {
  if (!email) return null;
  const supabase = await connectDB();
  const { data } = await supabase
    .from("users")
    .select("id, Firstname, Lastname, Email, Status")
    .eq("Email", email)
    .maybeSingle<Row>();
  if (!data) return null;
  // The legacy Status column carries several spellings of "inactive", so the
  // same normaliser the session uses decides whether this account is active.
  if (normalizeUserStatus(data.Status) !== "active") return null;
  return { id: String(data.id), name: composeUserName(data) };
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
  const supabase = await connectDB();
  const { data } = await supabase
    .from("requestors")
    .select("full_name")
    .eq("email", email)
    .maybeSingle<{ full_name: string | null }>();
  return data?.full_name ?? null;
}

/**
 * Finds the requestor by sender address, creating a guest record when the
 * sender is unknown. Guests are flagged so the directory can be reviewed later.
 */
async function findOrCreateRequestor(
  email: string,
  displayName?: string,
): Promise<{ id: string } | null> {
  if (!email) return null;

  const supabase = await connectDB();

  const { data: existing } = await supabase
    .from("requestors")
    .select("id")
    .eq("email", email)
    .maybeSingle<{ id: unknown }>();
  if (existing) return { id: String(existing.id) };

  const name = (displayName ?? "").trim() || email.split("@")[0] || "Unknown";
  const parts = name.split(/\s+/);
  const firstName = parts[0] ?? name;
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "-";

  // Generated employee id for a guest; the real one can be filled in later.
  const employeeId = `GUEST-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  const { data, error } = await supabase
    .from("requestors")
    .insert(
      requestorFieldsToRow({
        employeeId,
        firstName,
        lastName,
        fullName: buildFullName(firstName, lastName === "-" ? "" : lastName),
        email,
        status: "active",
        isGuest: true,
        notes: `Auto-created from inbound email on ${new Date().toISOString()}.`,
      }),
    )
    .select("id")
    .single<{ id: unknown }>();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      // Duplicate email race: fall back to the record that won.
      const { data: winner } = await supabase
        .from("requestors")
        .select("id")
        .eq("email", email)
        .maybeSingle<{ id: unknown }>();
      return winner ? { id: String(winner.id) } : null;
    }
    throw new DatabaseError(error);
  }

  return { id: String(data.id) };
}

/** Emails the assigned technician about a new inbound reply. */
async function notifyAssignedTechnician(
  ticket: InboundTicket,
  fromName: string,
  subject: string,
) {
  const settings = await getSettings();
  if (!settings.email.notifyTechnicianOnInbound) return;
  if (!ticket.technicianId) return;

  const technicianId = Number(ticket.technicianId);
  if (!Number.isFinite(technicianId)) return;

  const supabase = await connectDB();
  const { data: technician } = await supabase
    .from("users")
    .select("Email")
    .eq("id", technicianId)
    .maybeSingle<{ Email: string | null }>();
  const technicianEmail = str(technician?.Email).trim();
  if (!technicianEmail) return;

  const from = settings.resendFromEmail || String(process.env.EMAIL_FROM ?? "");
  if (!from) return;

  await send({
    from,
    to: technicianEmail,
    subject: `New reply on ${ticket.ticketNumber}: ${subject}`.slice(0, 200),
    text: [
      `${fromName} replied to ticket ${ticket.ticketNumber}.`,
      ``,
      `Subject: ${subject}`,
      ``,
      `Open the ticket: /tickets/${ticket.id}`,
    ].join("\n"),
    replyTo: settings.inboundEmail || process.env.INBOUND_EMAIL,
    headers: { "X-Ticket-Number": ticket.ticketNumber },
  });
}

export { payloadHash };
