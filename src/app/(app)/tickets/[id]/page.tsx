"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  Panel,
  TerminalBadge,
  ErrorNote,
  AlertBanner,
  PrimaryButton,
  GhostButton,
  EmptyState,
} from "@/components/app-shell";
import {
  LabeledField,
  Select,
  TextArea,
  AutoField,
  KeyValueRow,
  TextInput,
  ACCENT,
} from "@/components/ui/primitives";
import {
  ArrowLeft,
  Save,
  Send,
  RotateCcw,
  Mail,
  Phone,
  User,
  Paperclip,
  CheckCircle2,
  ArrowRightLeft,
  Flag,
  FileText,
  StickyNote,
} from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { useSession } from "@/contexts/SessionContext";
import type { DropdownOption, Ticket, TicketRemark } from "@/lib/client/types";
import { formatDateTime, formatDuration, timeAgo } from "@/lib/shared/format";

const STATUS_COLORS: Record<string, string> = {
  pending: "#eab308",
  scheduled: "#06b6d4",
  ongoing: "#f97316",
  resolved: "#22c55e",
  closed: "#22c55e",
  cancelled: "#94a3b8",
};

/** Icon + colour per remark type, shared by the timeline. */
const REMARK_STYLE: Record<string, { icon: React.ElementType; color: string }> = {
  note: { icon: StickyNote, color: "#f97316" },
  "email-in": { icon: Mail, color: "#06b6d4" },
  "email-out": { icon: Send, color: "#3b82f6" },
  "status-change": { icon: ArrowRightLeft, color: "#eab308" },
  "priority-change": { icon: Flag, color: "#ef4444" },
  assignment: { icon: User, color: "#8b5cf6" },
  "field-change": { icon: FileText, color: "#64748b" },
  system: { icon: CheckCircle2, color: "#22c55e" },
};

const REMARK_LABEL: Record<string, string> = {
  note: "Note",
  "email-in": "Email In",
  "email-out": "Email Out",
  "status-change": "Status Change",
  "priority-change": "Priority Change",
  assignment: "Assignment",
  "field-change": "Field Change",
  system: "System",
};

export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const router = useRouter();
  const { user } = useSession();

  const [ticket, setTicket] = React.useState<Ticket | null>(null);
  const [options, setOptions] = React.useState<Record<string, DropdownOption[] | undefined>>({});
  const [optionsLoaded, setOptionsLoaded] = React.useState(false);
  const [technicians, setTechnicians] = React.useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const [note, setNote] = React.useState("");
  const [reply, setReply] = React.useState("");
  const [replyTo, setReplyTo] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [showReply, setShowReply] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const response = await api.get<{ ticket: Ticket }>(`/api/tickets/${id}`);
      setTicket(response.ticket);
      setReplyTo(response.ticket.requestorEmail ?? "");
      document.title = `${response.ticket.ticketNumber} — Help Desk`;
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    async function loadOptions() {
      try {
        const response = await api.get<{ grouped: Record<string, DropdownOption[]> }>(
          "/api/dropdowns",
        );
        setOptions(response.grouped ?? {});
      } catch {
        // Read-only views still work without options.
      } finally {
        setOptionsLoaded(true);
      }
    }
    void loadOptions();
  }, []);

  React.useEffect(() => {
    if (!user?.permissions.assignTechnician) return;
    async function load() {
      try {
        const response = await api.get<{ technicians: Array<{ id: string; name: string }> }>(
          "/api/tickets/bulk",
        );
        setTechnicians(response.technicians ?? []);
      } catch {
        setTechnicians([]);
      }
    }
    void load();
  }, [user]);

  /** Sends a field/status/assignment change. Every change writes a remark. */
  async function patch(payload: Record<string, unknown>, message?: string) {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.patch<{ ticket: Ticket }>(`/api/tickets/${id}`, {
        ...payload,
        note: message,
      });
      setTicket(response.ticket);
      setNotice("Saved.");
      setTimeout(() => setNotice(null), 2500);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function addNote(event: React.FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    await patch({}, note.trim());
    setNote("");
  }

  async function sendReply(event: React.FormEvent) {
    event.preventDefault();
    if (!reply.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api.post(`/api/tickets/${id}/reply`, {
        body: reply.trim(),
        to: replyTo,
      });
      setReply("");
      setShowReply(false);
      setNotice("Reply sent.");
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <AppPage>
        <p className="py-16 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
          Loading ticket…
        </p>
      </AppPage>
    );
  }

  if (!ticket) {
    return (
      <AppPage>
        <PageHeading
          title="Ticket"
          actions={
            <GhostButton icon={ArrowLeft} onClick={() => router.push("/tickets")}>
              Back to tickets
            </GhostButton>
          }
        />
        <EmptyState
          title="Ticket not found"
          description="It may have been deleted, or it may be outside your assigned scope."
        />
      </AppPage>
    );
  }

  const canEditAny = user?.permissions.editAnyTicket;
  const canChangeStatus = user?.permissions.changeStatus;
  const canAssign = user?.permissions.assignTechnician;
  const canClose = user?.permissions.closeTicket;
  const canReopen = user?.permissions.reopenTicket;
  const canReply = user?.permissions.sendEmailReply;

  return (
    <AppPage>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              {ticket.ticketNumber}
            </h1>
            <TerminalBadge
              label={ticket.priority.label || "No priority"}
              color={ticket.priority.color}
              inactive={ticket.priority.inactive}
            />
            <TerminalBadge
              label={ticket.statusLabel || ticket.status}
              color={STATUS_COLORS[ticket.status] ?? "#94a3b8"}
            />
            {ticket.emailThreadId ? (
              <span className="flex items-center gap-1 rounded border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-cyan-700">
                <Mail className="h-3 w-3" /> Thread linked to Gmail
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {ticket.subject} · created {formatDateTime(ticket.dateCreated)}
            {ticket.dateClosed ? ` · closed ${formatDateTime(ticket.dateClosed)}` : ""}
            {ticket.durationSeconds ? ` · took ${ticket.durationLabel}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <GhostButton icon={ArrowLeft} onClick={() => router.push("/tickets")}>
            Back
          </GhostButton>
          {canReply ? (
            <GhostButton icon={Send} onClick={() => setShowReply((prev) => !prev)}>
              Reply via Email
            </GhostButton>
          ) : null}
          {ticket.isClosed && canReopen ? (
            <PrimaryButton
              icon={RotateCcw}
              onClick={() =>
                patch({ status: options.status?.find((o) => !["resolved", "closed", "cancelled"].includes(o.value))?.value ?? "pending" })
              }
              disabled={saving || !optionsLoaded}
              title={!optionsLoaded ? "Loading…" : undefined}
            >
              Reopen Ticket
            </PrimaryButton>
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        <ErrorNote error={error} />
        {notice ? <AlertBanner tone="success" title="Done">{notice}</AlertBanner> : null}

        {!ticket.isClosed && ticket.sla.remainingSeconds !== null ? (
          <AlertBanner
            tone={ticket.sla.breached ? "danger" : ticket.sla.warning ? "warning" : "info"}
            title={
              ticket.sla.breached
                ? "SLA breached"
                : ticket.sla.paused
                  ? "SLA clock paused"
                  : `${formatDuration(ticket.sla.remainingSeconds)} of SLA remaining`
            }
          >
            {ticket.priority.label} · {ticket.priority.slaHours}h budget · deadline{" "}
            {formatDateTime(ticket.sla.dueAt)}
            {ticket.sla.paused ? " (frozen while Scheduled)" : ""}
          </AlertBanner>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          {/* Left: editable fields */}
          <div className="space-y-4">
            <Panel title="Ticket Details">
              <div className="grid gap-4 p-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <LabeledField label="Subject">
                    <TextArea
                      rows={2}
                      defaultValue={ticket.subject}
                      disabled={!canEditAny}
                      onBlur={(event) => {
                        if (event.target.value.trim() && event.target.value.trim() !== ticket.subject) {
                          void patch({ subject: event.target.value.trim() }, "Subject updated");
                        }
                      }}
                      className="resize-none"
                    />
                  </LabeledField>
                </div>

                <div className="sm:col-span-2">
                  <LabeledField label="Description">
                    <TextArea
                      rows={5}
                      defaultValue={ticket.description}
                      disabled={!canEditAny}
                      onBlur={(event) => {
                        if (event.target.value !== ticket.description) {
                          void patch({ description: event.target.value }, "Description updated");
                        }
                      }}
                    />
                  </LabeledField>
                </div>

                <FieldSelect
                  label="Department"
                  value={ticket.department}
                  options={options.department}
                  disabled={!canEditAny}
                  onChange={(value) => void patch({ department: value }, "Department changed")}
                />
                <FieldSelect
                  label="Request Type"
                  value={ticket.requestType}
                  options={options.requestType}
                  disabled={!canEditAny}
                  onChange={(value) => void patch({ requestType: value }, "Request Type changed")}
                />
                <FieldSelect
                  label="Type of Concern"
                  value={ticket.typeOfConcern}
                  options={options.typeOfConcern}
                  disabled={!canEditAny}
                  onChange={(value) => void patch({ typeOfConcern: value }, "Type of Concern changed")}
                />
                <FieldSelect
                  label="Mode"
                  value={ticket.mode}
                  options={options.mode}
                  disabled={!canEditAny}
                  onChange={(value) => void patch({ mode: value }, "Mode changed")}
                />
                <FieldSelect
                  label="Services Group"
                  value={ticket.servicesGroup}
                  options={options.servicesGroup}
                  disabled={!canEditAny}
                  onChange={(value) => void patch({ servicesGroup: value }, "Services Group changed")}
                />
                <FieldSelect
                  label="Site"
                  value={ticket.site}
                  options={options.site}
                  disabled={!canEditAny}
                  onChange={(value) => void patch({ site: value }, "Site changed")}
                />

                <FieldSelect
                  label="Priority"
                  value={ticket.priority.value}
                  options={options.priority}
                  disabled={!canClose}
                  renderLabel={(option) =>
                    option.slaHours ? `${option.label} (${option.slaHours}h)` : option.label
                  }
                  onChange={(value) => void patch({ priority: value }, "Priority changed")}
                />

                <FieldSelect
                  label="Status"
                  value={ticket.status}
                  options={options.status}
                  disabled={!canChangeStatus && !canClose}
                  onChange={(value) => {
                    const closing = ["resolved", "closed", "cancelled"].includes(value);
                    if (closing && !canClose) {
                      setError(new ApiError("You do not have permission to close tickets.", 403));
                      return;
                    }
                    void patch({ status: value });
                  }}
                />

                <FieldSelect
                  label="Technician"
                  value={ticket.technician ?? ""}
                  disabled={!canAssign}
                  options={technicians.map((tech) => ({ value: tech.id, label: tech.name }))}
                  renderLabel={(option) => option.label}
                  onChange={(value) => void patch({ technician: value || null }, "Technician changed")}
                  allowEmpty="Unassigned"
                />

                <LabeledField label="Scheduled Date">
                  <TextInput
                    type="date"
                    defaultValue={ticket.scheduledDate ? ticket.scheduledDate.slice(0, 10) : ""}
                    disabled={!canEditAny}
                    onBlur={(event) => {
                      const next = event.target.value
                        ? new Date(`${event.target.value}T00:00:00`).toISOString()
                        : null;
                      const current = ticket.scheduledDate
                        ? new Date(ticket.scheduledDate).toISOString().slice(0, 10)
                        : "";
                      if (event.target.value !== current) {
                        void patch({ scheduledDate: next }, "Scheduled date changed");
                      }
                    }}
                  />
                </LabeledField>
              </div>
            </Panel>

            {/* Requestor */}
            <Panel title="Requestor">
              <div className="grid gap-x-6 gap-y-1 p-4 sm:grid-cols-2">
                <KeyValueRow label="Name" value={ticket.requestorName} />
                <KeyValueRow label="Employee ID" value={ticket.requestorEmployeeId} mono />
                <KeyValueRow
                  label="Email"
                  value={
                    ticket.requestorEmail ? (
                      <a href={`mailto:${ticket.requestorEmail}`} className="hover:underline">
                        {ticket.requestorEmail}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                />
                <KeyValueRow label="Department" value={ticket.requestorDepartment} />
                <KeyValueRow label="Site" value={ticket.requestorSite} />
                <KeyValueRow
                  label="Phone"
                  value={
                    ticket.requestorPhone ? (
                      <span className="inline-flex items-center gap-1">
                        <Phone className="h-3 w-3" /> {ticket.requestorPhone}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
              </div>
            </Panel>

            {/* Email composer */}
            {showReply && !replyTo ? (
              <p className="text-[10px] text-amber-600">
                No email on file for this requestor. Enter a recipient address.
              </p>
            ) : null}
            {showReply && canReply ? (
              <Panel title="Reply via Email" hint={`via Resend from ${ticket.requestorEmail || "the requestor"}`}>
                <form onSubmit={sendReply} className="space-y-3 p-4">
                  <LabeledField label="To" hint="comma separated">
                    <input
                      value={replyTo}
                      onChange={(event) => setReplyTo(event.target.value)}
                      className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-accent"
                      placeholder="requestor@company.com"
                    />
                  </LabeledField>
                  <LabeledField
                    label="Message"
                    hint={`subject will be [${ticket.ticketNumber}] ${ticket.subject}`}
                  >
                    <TextArea
                      rows={7}
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      placeholder={`Hi ${ticket.requestorName.split(",")[0] || "there"},\n\n`}
                    />
                  </LabeledField>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] text-muted-foreground">
                      Reply-To is the ticketing inbox, so their answer comes back here.
                    </p>
                    <div className="flex gap-2">
                      <GhostButton type="button" onClick={() => setShowReply(false)}>
                        Cancel
                      </GhostButton>
                      <PrimaryButton type="submit" icon={Send} disabled={sending}>
                        {sending ? "Sending…" : "Send"}
                      </PrimaryButton>
                    </div>
                  </div>
                </form>
              </Panel>
            ) : null}

            {/* Note composer */}
            <Panel title="Add Remark">
              <form onSubmit={addNote} className="space-y-2 p-4">
                <TextArea
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Add a note to the timeline. Notes cannot be deleted by other agents."
                  maxLength={2000}
                />
                <p className="mt-1 text-right text-[9px] text-muted-foreground">
                  {note.length}/2000
                </p>
                <div className="flex justify-end">
                  <PrimaryButton type="submit" icon={Save} disabled={saving || !note.trim()}>
                    {saving ? "Saving…" : "Add Remark"}
                  </PrimaryButton>
                </div>
              </form>
            </Panel>
          </div>

          {/* Right: auto fields + timeline */}
          <div className="space-y-4">
            <Panel title="Auto Fields" hint="populated automatically">
              <div className="space-y-2 p-4">
                <AutoField label="Processed By" value={ticket.processedByName || "—"} badge="AUTO" />
                <AutoField label="Technician" value={ticket.technicianName || "Unassigned"} badge="AUTO" />
                <AutoField label="Closed By" value={ticket.closedByName || "—"} badge="AUTO" />
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <KeyValueRow label="Created" value={formatDateTime(ticket.dateCreated)} />
                  <KeyValueRow label="Last Activity" value={timeAgo(ticket.lastActivityAt)} />
                  <KeyValueRow label="Closed" value={ticket.dateClosed ? formatDateTime(ticket.dateClosed) : "—"} />
                  <KeyValueRow label="Source" value={ticket.source} />
                </div>
              </div>
            </Panel>

            {ticket.attachments.length > 0 ? (
              <Panel title="Attachments" hint={`${ticket.attachments.length} file(s)`}>
                <ul className="divide-y divide-border">
                  {ticket.attachments.map((fileId, index) => (
                    <li key={fileId}>
                      <a
                        href={`/api/files/${fileId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 px-4 py-2.5 text-[11px] hover:bg-muted"
                        aria-label={`Download Attachment ${index + 1}`}
                      >
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{`Attachment ${index + 1}`}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            <Panel
              title="Remarks & History"
              hint={`${ticket.remarks.length} entr${ticket.remarks.length === 1 ? "y" : "ies"}`}
            >
              {ticket.remarks.length === 0 ? (
                <EmptyState title="No remarks yet" />
              ) : (
                <ol className="relative p-4">
                  {/* Vertical rail */}
                  <span className="absolute bottom-6 left-[22px] top-6 w-px bg-border" aria-hidden />
                  {ticket.remarks.map((remark) => (
                    <TimelineEntry key={remark.id} remark={remark} />
                  ))}
                </ol>
              )}
            </Panel>

            {ticket.assignmentHistory.length > 0 ? (
              <Panel title="Assignment History">
                <ul className="divide-y divide-border">
                  {ticket.assignmentHistory.map((entry, index) => (
                    <li key={index} className="flex items-center justify-between gap-2 px-4 py-2">
                      <span className="text-[11px]">{entry.technicianName}</span>
                      <span className="text-[9px] text-muted-foreground">
                        {entry.byName} · {formatDateTime(entry.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </div>
        </div>
      </div>
    </AppPage>
  );
}

function TimelineEntry({ remark }: { remark: TicketRemark }) {
  const style = REMARK_STYLE[remark.type] ?? REMARK_STYLE.system;
  const Icon = style.icon;

  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span
        className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-card"
        style={{ backgroundColor: `${style.color}22`, color: style.color }}
      >
        <Icon className="h-3 w-3" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
            style={{ color: style.color, backgroundColor: `${style.color}14` }}
          >
            {REMARK_LABEL[remark.type] ?? remark.type}
          </span>
          <span className="text-[11px] font-semibold text-foreground">{remark.authorName}</span>
          <span className="text-[9px] text-muted-foreground">{timeAgo(remark.createdAt)}</span>
        </div>

        {remark.content ? (
          <p className="mt-1.5 whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-foreground">
            {remark.content}
          </p>
        ) : null}

        {remark.field && remark.oldValue !== remark.newValue ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700 line-through">
              {remark.oldValue || "empty"}
            </span>
            <span className="text-muted-foreground">→</span>
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
              {remark.newValue || "empty"}
            </span>
          </p>
        ) : null}

        {remark.attachments.length > 0 ? (
          <p className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Paperclip className="h-3 w-3" /> {remark.attachments.length} attachment(s)
          </p>
        ) : null}

        {remark.emailMessageId ? (
          <p className="mt-1 text-[9px] text-muted-foreground">
            message-id {remark.emailMessageId}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
  disabled,
  renderLabel,
  allowEmpty,
}: {
  label: string;
  value: string;
  /** Undefined until /api/dropdowns resolves, so it must be tolerated. */
  options?: Array<{ value: string; label: string; slaHours?: number; inactive?: boolean }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  renderLabel?: (option: { value: string; label: string; slaHours?: number }) => string;
  allowEmpty?: string;
}) {
  // The dropdown list arrives asynchronously; render nothing rather than
  // crashing on the first pass.
  const available = options ?? [];

  // A value with no matching option means the option was deactivated. Render it
  // as a disabled entry marked "(inactive)" instead of silently dropping it.
  const known = available.some((option) => option.value === value);

  return (
    <LabeledField label={label}>
      <Select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {allowEmpty ? <option value="">{allowEmpty}</option> : null}
        {!known && value ? (
          <option value={value} disabled>
            {value} (inactive)
          </option>
        ) : null}
        {available.map((option) => (
          <option key={option.value} value={option.value}>
            {renderLabel ? renderLabel(option) : option.label}
          </option>
        ))}
      </Select>
    </LabeledField>
  );
}