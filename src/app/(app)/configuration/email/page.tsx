"use client";

import * as React from "react";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  Panel,
  ErrorNote,
  AlertBanner,
  GhostButton,
  PrimaryButton,
  EmptyState,
} from "@/components/app-shell";
import { LabeledField, TextInput, ACCENT } from "@/components/ui/primitives";
import { CheckCircle2, XCircle, Send, Save, Webhook, Mail } from "lucide-react";
import { api } from "@/lib/client/api";
import { formatDateTime } from "@/lib/shared/format";

type EmailStatus = {
  connection: {
    configured: boolean;
    reachable: boolean;
    fromEmail: string;
    inboundEmail: string;
    message: string;
    hasWebhookSecret: boolean;
  };
  webhookUrl: string;
  lastInbound: {
    subject: string;
    from: string;
    ticketId: string | null;
    processedAt: string;
    autoCreatedTicket: boolean;
  } | null;
  lastOutbound: { subject: string; to: string[]; processedAt: string } | null;
};

export default function EmailConfigPage() {
  const [status, setStatus] = React.useState<EmailStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [form, setForm] = React.useState({ resendFromEmail: "", inboundEmail: "", resendInboundSecret: "" });
  const [testTo, setTestTo] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  const load = React.useCallback(async () => {    setLoading(true);
    try {
      const [statusResponse, settingsResponse] = await Promise.all([
        api.get<EmailStatus>("/api/email/status"),
        api.get<{ settings: { resendFromEmail: string; inboundEmail: string; resendInboundSecret?: string } }>(
          "/api/settings",
        ),
      ]);
      setStatus(statusResponse);
      setForm({
        resendFromEmail: settingsResponse.settings.resendFromEmail,
        inboundEmail: settingsResponse.settings.inboundEmail,
        // Never echo an existing secret back into the browser.
        resendInboundSecret: "",
      });
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    document.title = "Email Settings — Help Desk";
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch("/api/settings", {
        resendFromEmail: form.resendFromEmail,
        inboundEmail: form.inboundEmail,
        // An empty secret means "leave the stored value alone".
        ...(form.resendInboundSecret ? { resendInboundSecret: form.resendInboundSecret } : {}),
      });
      setForm((current) => ({ ...current, resendInboundSecret: "" }));
      setNotice("Email settings saved.");
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function sendTest(event: React.FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      const response = await api.post<{ message: string }>("/api/email/status", { to: testTo });
      setNotice(response.message);
    } catch (caught) {
      setError(caught);
    } finally {
      setSending(false);
    }
  }

  const healthy = status?.connection.configured && status?.connection.reachable;

  return (
    <AppPage>
      <PageHeading
        title="Email / Resend"
        description="Gmail forwarding and the Resend inbound webhook turn concerns into tickets, and let replies land back on the ticket."
      />

      {loading ? (
        <p className="py-10 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
          Checking connection…
        </p>
      ) : (
        <div className="space-y-4">
          <ErrorNote error={error} />
          {notice ? <AlertBanner tone="success" title="Done">{notice}</AlertBanner> : null}

          {/* Connection status */}
          {healthy ? (
            <AlertBanner tone="success" title="Resend connected">
              {status?.connection.message}
            </AlertBanner>
          ) : (
            <AlertBanner tone="danger" title="Resend not connected">
              {status?.connection.message ??
                "Set RESEND_API_KEY in .env.local and restart, then verify the sending domain in Resend."}
            </AlertBanner>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Configuration */}
            <Panel title="Connection Settings">
              <div className="space-y-3 p-4">
                <LabeledField label="Sending Address (EMAIL_FROM)">
                  <TextInput
                    type="email"
                    value={form.resendFromEmail}
                    onChange={(event) => setForm({ ...form, resendFromEmail: event.target.value })}
                    placeholder="support@yourdomain.com"
                  />
                </LabeledField>

                <LabeledField label="Inbound Address (INBOUND_EMAIL)">
                  <TextInput
                    type="email"
                    value={form.inboundEmail}
                    onChange={(event) => setForm({ ...form, inboundEmail: event.target.value })}
                    placeholder="tickets@yourdomain.com"
                  />
                </LabeledField>

                <LabeledField
                  label="Inbound Webhook Secret"
                  hint={
                    status?.connection.hasWebhookSecret ? "saved — leave blank to keep" : "not set"
                  }
                >
                  <TextInput
                    type="password"
                    autoComplete="off"
                    value={form.resendInboundSecret}
                    onChange={(event) =>
                      setForm({ ...form, resendInboundSecret: event.target.value })
                    }
                    placeholder={
                      status?.connection.hasWebhookSecret ? "••••••••" : "whsec_..."
                    }
                  />
                </LabeledField>

                {!status?.connection.hasWebhookSecret ? (
                  <AlertBanner tone="warning" title="Webhook signature cannot be verified">
                    Until a secret is set, inbound webhooks are rejected. Unsigned mail would let
                    anyone create tickets in your system.
                  </AlertBanner>
                ) : null}

                <div className="flex justify-end">
                  <PrimaryButton icon={Save} onClick={save} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </PrimaryButton>
                </div>
              </div>
            </Panel>

            {/* Webhook + test */}
            <Panel title="Webhook & Testing">
              <div className="space-y-4 p-4">
                <div className="rounded-md border border-border bg-muted/40 p-3">
                  <p className="mb-1 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                    <Webhook className="h-3 w-3" /> Inbound Webhook URL
                  </p>
                  <code className="block break-all font-mono text-[11px] text-foreground">
                    {status?.webhookUrl}
                  </code>
                  <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                    Point your Resend inbound routing at this URL. It verifies the signature, dedupes
                    by message ID, threads replies that carry a ticket number in the subject, and
                    auto-creates a ticket for anything unmatched.
                  </p>
                </div>

                <form onSubmit={sendTest} className="space-y-2">
                  <LabeledField label="Send Test Email To">
                    <TextInput
                      type="email"
                      required
                      value={testTo}
                      onChange={(event) => setTestTo(event.target.value)}
                      placeholder="you@company.com"
                    />
                  </LabeledField>
                  <div className="flex justify-end">
                    <PrimaryButton type="submit" icon={Send} disabled={sending || !testTo}>
                      {sending ? "Sending…" : "Send Test"}
                    </PrimaryButton>
                  </div>
                </form>

                <div className="rounded-md border border-border p-3">
                  <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                    Gmail Setup
                  </p>
                  <ol className="list-decimal space-y-1 pl-4 text-[10px] leading-relaxed text-muted-foreground">
                    <li>
                      Set up a Gmail filter that forwards mail to the inbound address above.
                    </li>
                    <li>
                      Replies an agent sends from Gmail keep the <code>[DSI-…]</code> subject
                      prefix, so they thread back onto the ticket automatically.
                    </li>
                    <li>
                      Replies sent from the ticket composer go out via Resend with{" "}
                      <code>Reply-To</code> set to the inbound address.
                    </li>
                  </ol>
                </div>
              </div>
            </Panel>
          </div>

          {/* Activity */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Last Inbound Message">
              {status?.lastInbound ? (
                <div className="space-y-1.5 p-4">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    <span className="truncate text-[12px] font-medium">{status.lastInbound.subject || "(no subject)"}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">From {status.lastInbound.from}</p>
                  <p className="text-[10px] text-muted-foreground">
                    Processed {formatDateTime(status.lastInbound.processedAt)} ·{" "}
                    {status.lastInbound.autoCreatedTicket ? "created a new ticket" : "threaded onto an existing ticket"}
                  </p>
                  {status.lastInbound.ticketId ? (
                    <a
                      href={`/tickets/${status.lastInbound.ticketId}`}
                      className="inline-block text-[10px] underline underline-offset-2"
                      style={{ color: ACCENT }}
                    >
                      Open the ticket
                    </a>
                  ) : null}
                </div>
              ) : (
                <EmptyState
                  title="No inbound mail yet"
                  description="Once the webhook is receiving forwarded Gmail, the last message appears here."
                />
              )}
            </Panel>

            <Panel title="Last Outbound Message">
              {status?.lastOutbound ? (
                <div className="space-y-1.5 p-4">
                  <div className="flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate text-[12px] font-medium">
                      {status.lastOutbound.subject || "(no subject)"}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    To {status.lastOutbound.to.join(", ") || "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Sent {formatDateTime(status.lastOutbound.processedAt)}
                  </p>
                </div>
              ) : (
                <EmptyState
                  title="No outbound mail yet"
                  description="Send a reply from a ticket, or use the Send Test button above."
                />
              )}
            </Panel>
          </div>

          {!status?.connection.reachable && status?.connection.configured ? (
            <GhostButton icon={XCircle} onClick={() => void load()}>
              Re-check connection
            </GhostButton>
          ) : null}
        </div>
      )}
    </AppPage>
  );
}
