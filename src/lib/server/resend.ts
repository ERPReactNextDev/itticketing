import "server-only";
import { Resend } from "resend";
import { getSettings } from "./settings";

let cachedKey: string | null = null;
let cachedClient: Resend | null = null;

function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedKey = key;
  cachedClient = new Resend(key);
  return cachedClient;
}

export type EmailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

export type SendResult = {
  ok: boolean;
  messageId?: string;
  resendId?: string;
  error?: string;
};

async function send(params: {
  from: string;
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  cc?: string[];
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
}): Promise<SendResult> {
  const client = getClient();
  if (!client) {
    return { ok: false, error: "RESEND_API_KEY is not configured." };
  }

  try {
    const response = await client.emails.send({
      from: params.from,
      to: Array.isArray(params.to) ? params.to : [params.to],
      subject: params.subject,
      text: params.text,
      html: params.html,
      replyTo: params.replyTo,
      cc: params.cc,
      headers: params.headers,
      attachments: params.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });

    if (response.error) {
      return { ok: false, error: response.error.message };
    }
    const data = response.data as { id?: string } | undefined;
    return { ok: true, resendId: data?.id, messageId: data?.id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown Resend error.",
    };
  }
}

/** From address, preferring the live setting over the env default. */
export async function fromAddress(): Promise<string> {
  const settings = await getSettings();
  return settings.resendFromEmail || process.env.EMAIL_FROM || "support@example.com";
}

export async function inboundAddress(): Promise<string> {
  const settings = await getSettings();
  return settings.inboundEmail || process.env.INBOUND_EMAIL || "";
}

/** Reject a replayed capture after this many seconds. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies the Resend (Svix) inbound webhook signature.
 *
 * Svix signs `${svix-timestamp}.${rawBody}` and sends the timestamp in its own
 * header, with one or more `v1,<base64>` signatures space-separated in
 * `svix-signature`. A comma-joined `t=…,v1=…` form is also accepted.
 *
 * Any listed signature may match, which is how signing-key rotation is meant
 * to work.
 */
export async function verifyInboundSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader?: string | null,
): Promise<boolean> {
  const secret = (await getSettings()).resendInboundSecret || process.env.RESEND_INBOUND_SECRET;
  if (!secret) {
    // Fail closed: without a configured secret we cannot authenticate the
    // caller, and accepting unsigned mail would let anyone create tickets.
    return false;
  }
  if (!signatureHeader) return false;

  let timestamp = (timestampHeader ?? "").trim();
  const signatures: string[] = [];

  // Split on whitespace only: the `v1,` prefix uses a comma as its separator, so
  // splitting on commas would tear the key from its value. Base64 padding may
  // contain `=` too, so only the first separator is consumed.
  for (const part of signatureHeader.split(/\s+/).filter(Boolean)) {
    if (part.startsWith("v1,")) {
      signatures.push(part.slice(3));
    } else if (part.startsWith("v1=")) {
      signatures.push(part.slice(3));
    } else if (part.startsWith("t=")) {
      timestamp = part.slice(2);
    } else if (part.startsWith("t,")) {
      timestamp = part.slice(2);
    }
  }

  if (!timestamp || signatures.length === 0) return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;

  // Reject stale requests so a captured signature cannot be replayed.
  const age = Math.abs(Date.now() / 1000 - timestampNumber);
  if (age > SIGNATURE_TOLERANCE_SECONDS) return false;

  const { createHmac, timingSafeEqual } = await import("crypto");
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("base64"),
  );

  return signatures.some((provided) => {
    const candidate = Buffer.from(provided);
    // timingSafeEqual throws on a length mismatch, so compare lengths first.
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

export function buildTicketSubject(ticketNumber: string, originalSubject: string): string {
  const base = (originalSubject ?? "").trim();
  // Already-prefixed subjects must not accumulate repeated ticket numbers.
  if (base.startsWith(`[${ticketNumber}]`)) return base;
  return `[${ticketNumber}] ${base}`.trim();
}

/** Sends an agent reply on a ticket thread. */
export async function sendTicketReply(params: {
  ticketNumber: string;
  subject: string;
  body: string;
  to: string | string[];
  ticketId: string;
  threadId?: string;
  cc?: string[];
  attachments?: EmailAttachment[];
}): Promise<SendResult> {
  const settings = await getSettings();
  const replyTo = settings.inboundEmail || process.env.INBOUND_EMAIL;

  return send({
    from: await fromAddress(),
    to: params.to,
    subject: buildTicketSubject(params.ticketNumber, params.subject),
    text: params.body,
    // Replies land in the ticketing inbox so the thread keeps flowing.
    replyTo,
    cc: params.cc,
    // Lets the inbound webhook thread the response even if the subject is edited.
    headers: {
      "X-Ticket-Id": params.ticketId,
      "X-Ticket-Number": params.ticketNumber,
      ...(params.threadId ? { "X-Thread-Id": params.threadId } : {}),
    },
    attachments: params.attachments,
  });
}

/** Auto-acknowledgement for an inbound email that created a new ticket. */
export async function sendAutoAcknowledgement(params: {
  ticketNumber: string;
  to: string;
  subject: string;
  ticketId: string;
}): Promise<SendResult> {
  const settings = await getSettings();
  const replyTo = settings.inboundEmail || process.env.INBOUND_EMAIL;

  const text = [
    `Hello,`,
    ``,
    `Thank you for contacting the IT Help Desk. We have received your concern and`,
    `logged it as ticket ${params.ticketNumber}.`,
    ``,
    `Ticket:    ${params.ticketNumber}`,
    `Subject:   ${params.subject}`,
    `Status:    An agent will review this shortly.`,
    ``,
    `Please reply to this email to add more details. Your reply will be added`,
    `directly to the ticket, so there is no need to open a new one.`,
    ``,
    `— IT Help Desk`,
  ].join("\n");

  return send({
    from: await fromAddress(),
    to: params.to,
    // The ticket number in the subject is what threads future replies.
    subject: buildTicketSubject(params.ticketNumber, params.subject),
    text,
    replyTo,
    headers: {
      "X-Ticket-Id": params.ticketId,
      "X-Ticket-Number": params.ticketNumber,
      "X-Auto-Acknowledgement": "true",
    },
  });
}

/** Resend connection probe used by the Settings page status card. */
export async function checkResendConnection(): Promise<{
  configured: boolean;
  reachable: boolean;
  fromEmail: string;
  inboundEmail: string;
  message: string;
}> {
  const settings = await getSettings();
  const from = await fromAddress();
  const hasKey = Boolean(process.env.RESEND_API_KEY);

  if (!hasKey) {
    return {
      configured: false,
      reachable: false,
      fromEmail: from,
      inboundEmail: await inboundAddress(),
      message: "RESEND_API_KEY is not set.",
    };
  }

  const client = getClient();

  // The SDK returns { data, error } rather than throwing, so an in-band error
  // must be inspected explicitly - otherwise a rejected key looks like an empty
  // (and therefore "unverified") domain list.
  let response: Awaited<ReturnType<NonNullable<typeof client>["domains"]["list"]>>;
  try {
    response = await client!.domains.list();
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      fromEmail: from,
      inboundEmail: await inboundAddress(),
      message:
        error instanceof Error
          ? `Resend API error: ${error.message}`
          : "Could not reach the Resend API.",
    };
  }

  if (response.error) {
    // Resend returns { statusCode, message, name } here. `restricted_api_key`
    // is a real runtime value that the SDK's type union does not model, so it
    // is read through a cast rather than trusted to the declared type.
    const detail = response.error as unknown as { name?: string; message?: string };
    const restricted =
      detail.name === "restricted_api_key" ||
      detail.message?.toLowerCase().includes("restricted") === true;

    return {
      configured: true,
      // A send-only key can still deliver mail; it just cannot read domains.
      reachable: true,
      fromEmail: from,
      inboundEmail: await inboundAddress(),
      message: restricted
        ? "Connected with a send-only API key. Sending works, but this key cannot read " +
          "domain status. Use a full-access key if you want this check to verify the domain."
        : `Resend API error: ${response.error.message ?? "unknown"}`,
    };
  }

  const domain = from.split("@")[1] ?? "";
  const record = (response.data as unknown as Array<{ name?: string; status?: string }>) ?? [];
  const match = record.find((entry) => entry.name === domain);
  const isVerified = Boolean(match) && match?.status === "verified";

  return {
    configured: true,
    reachable: true,
    fromEmail: from,
    inboundEmail: await inboundAddress(),
    message: isVerified
      ? `Connected. Sending domain "${domain}" is verified.`
      : match
        ? `Sending domain "${domain}" is ${match.status}. Add the DNS records Resend lists, then verify it.`
        : `"${domain}" is not added in Resend yet. Add it under Domains, then add the DNS records it shows.`,
  };
}

/** Sends the "send test email" button on the Settings page. */
export async function sendTestEmail(to: string): Promise<SendResult> {
  const settings = await getSettings();
  const result = await send({
    from: await fromAddress(),
    to,
    subject: `[TEST] IT Help Desk email configuration`,
    text: [
      `This is a test message from your IT Help Desk ticketing system.`,
      ``,
      `Sent at: ${new Date().toISOString()}`,
      `From:    ${settings.resendFromEmail || process.env.EMAIL_FROM}`,
      `Reply-To: ${settings.inboundEmail || process.env.INBOUND_EMAIL}`,
      ``,
      `If you received this, outbound email is configured correctly.`,
    ].join("\n"),
    replyTo: settings.inboundEmail || process.env.INBOUND_EMAIL,
  });
  return result;
}

export { send };