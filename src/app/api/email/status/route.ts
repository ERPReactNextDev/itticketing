import { NextResponse } from "next/server";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { getSettings } from "@/lib/server/settings";
import { checkResendConnection, sendTestEmail } from "@/lib/server/resend";
import { connectDB } from "@/lib/db/mongoose";
import { EmailMessage } from "@/lib/models";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Resend connection status + last inbound processing snapshot. */
export const GET = withApi(async () => {
  await requireUser();
  requirePermission(await requireUser(), "manageSettings");

  const settings = await getSettings();
  const connection = await checkResendConnection();

  await connectDB();
  const lastInbound = await EmailMessage.findOne({ direction: "in" })
    .sort({ createdAt: -1 })
    .select("messageId subject from ticket processedAt autoCreatedTicket")
    .lean<Record<string, unknown>>();

  const lastOutbound = await EmailMessage.findOne({ direction: "out" })
    .sort({ createdAt: -1 })
    .select("messageId subject to sentAt")
    .lean<Record<string, unknown>>();

  const webhookUrl = process.env.APP_URL
    ? `${process.env.APP_URL}/api/webhooks/resend/inbound`
    : "/api/webhooks/resend/inbound";

  return NextResponse.json({
    connection: {
      configured: connection.configured,
      reachable: connection.reachable,
      fromEmail: connection.fromEmail,
      inboundEmail: connection.inboundEmail,
      message: connection.message,
      // Never send the secret value to the browser.
      hasWebhookSecret: Boolean(settings.resendInboundSecret),
    },
    webhookUrl,
    lastInbound: lastInbound
      ? {
          subject: String(lastInbound.subject ?? ""),
          from: String(lastInbound.from ?? ""),
          ticketId: lastInbound.ticket ? String(lastInbound.ticket) : null,
          processedAt: lastInbound.processedAt
            ? String(lastInbound.processedAt)
            : String(lastInbound.createdAt ?? ""),
          autoCreatedTicket: Boolean(lastInbound.autoCreatedTicket),
        }
      : null,
    lastOutbound: lastOutbound
      ? {
          subject: String(lastOutbound.subject ?? ""),
          to: ((lastOutbound.to ?? []) as unknown[]).map(String),
          processedAt: String(lastOutbound.sentAt ?? lastOutbound.createdAt ?? ""),
        }
      : null,
  });
});

/** Sends a test email to verify outbound configuration. */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageSettings");

  const body = await readJson<{ to?: string }>(req);
  const to = (body.to ?? "").trim();
  if (!to) throw new ApiInputError("Enter an email address to send the test message to.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new ApiInputError("That is not a valid email address.");
  }

  const result = await sendTestEmail(to);
  if (!result.ok) {
    return NextResponse.json(
      { error: "send_failed", message: result.error ?? "Could not send the test email." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, message: `Test email sent to ${to}.`, messageId: result.messageId });
});