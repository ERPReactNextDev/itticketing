import { NextResponse } from "next/server";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { getSettings } from "@/lib/server/settings";
import { checkResendConnection, sendTestEmail } from "@/lib/server/resend";
import { connectDB } from "@/lib/db/supabase";
import { mapEmailMessageRow } from "@/lib/db/mappers";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Resend connection status + last inbound processing snapshot. */
export const GET = withApi(async () => {
  const user = await requireUser();
  requirePermission(user, "manageSettings");

  const settings = await getSettings();
  const connection = await checkResendConnection();

  const supabase = await connectDB();
  const { data: inboundRow } = await supabase
    .from("email_messages")
    .select("*")
    .eq("direction", "in")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Record<string, unknown>>();

  const { data: outboundRow } = await supabase
    .from("email_messages")
    .select("*")
    .eq("direction", "out")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Record<string, unknown>>();

  const lastInbound = inboundRow ? mapEmailMessageRow(inboundRow) : null;
  const lastOutbound = outboundRow ? mapEmailMessageRow(outboundRow) : null;

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
          subject: lastInbound.subject,
          from: lastInbound.from,
          ticketId: lastInbound.ticketId,
          processedAt: lastInbound.processedAt ?? lastInbound.createdAt,
          autoCreatedTicket: lastInbound.autoCreatedTicket,
        }
      : null,
    lastOutbound: lastOutbound
      ? {
          subject: lastOutbound.subject,
          to: lastOutbound.to,
          processedAt: lastOutbound.processedAt ?? lastOutbound.createdAt,
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
