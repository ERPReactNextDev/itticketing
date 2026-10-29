"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  Panel,
  ErrorNote,
  AlertBanner,
  PrimaryButton,
  GhostButton,
} from "@/components/app-shell";
import { LabeledField, Select, TextInput, TextArea, AutoField, ACCENT } from "@/components/ui/primitives";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { ArrowLeft, Save, Search, UserPlus, Clock, X } from "lucide-react";
import { api } from "@/lib/client/api";
import { useSession } from "@/contexts/SessionContext";
import type { DropdownOption, Requestor, Ticket } from "@/lib/client/types";
import { fromDateInputValue } from "@/lib/shared/format";

type Settings = {
  ticketNumberPattern?: string;
  ticketPrefix?: string;
  defaultTechnicianAssignment?: string;
};

export default function NewTicketPage() {
  const router = useRouter();
  const { user } = useSession();

  const [options, setOptions] = React.useState<Record<string, DropdownOption[]>>({});
  const [error, setError] = React.useState<unknown>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const [form, setForm] = React.useState({
    subject: "",
    description: "",
    requestorId: "",
    department: "",
    requestType: "",
    typeOfConcern: "",
    mode: "chat",
    servicesGroup: "service-desk",
    site: "",
    priority: "",
    status: "",
    /** ISO string when set, empty string when unset */
    scheduledDate: "",
    supportStartTime: "",
    supportEndTime: "",
    remarks: "",
  });

  // Live ticket-number preview.
  const [preview, setPreview] = React.useState<{ next: string; current: string } | null>(null);

  React.useEffect(() => {
    document.title = "New Ticket — Help Desk";
  }, []);

  React.useEffect(() => {
    async function load() {
      try {
        const [dropdowns, settings] = await Promise.all([
          api.get<{ grouped: Record<string, DropdownOption[]> }>("/api/dropdowns"),
          api.get<{ settings: Settings }>("/api/settings"),
        ]);
        setOptions(dropdowns.grouped ?? {});
        // Default status/priority to the first configured option.
        const firstStatus = dropdowns.grouped?.status?.[0]?.value ?? "";
        const firstPriority = dropdowns.grouped?.priority?.[0]?.value ?? "";
        setForm((current) => ({
          ...current,
          status: current.status || firstStatus,
          priority: current.priority || firstPriority,
        }));

        if (settings.settings?.ticketNumberPattern) {
          const previewResponse = await api.get<{ next: string; current: string }>(
            "/api/settings?preview=1",
          );
          setPreview(previewResponse);
        }
      } catch (caught) {
        // Non-admin roles cannot read the preview; that is expected.
        if (!(caught instanceof Error && caught.message.includes("permission"))) {
          setError(caught);
        }
      }
    }
    void load();
  }, []);

  function set(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await api.post<{ ticket: Ticket }>("/api/tickets", {
        subject: form.subject.trim(),
        description: form.description,
        requestorId: form.requestorId || null,
        department: form.department || undefined,
        requestType: form.requestType || undefined,
        typeOfConcern: form.typeOfConcern || undefined,
        mode: form.mode || undefined,
        servicesGroup: form.servicesGroup || undefined,
        site: form.site || undefined,
        priority: form.priority || undefined,
        status: form.status || undefined,
        scheduledDate: form.scheduledDate ? form.scheduledDate : null,
        supportStartTime: form.supportStartTime || null,
        supportEndTime: form.supportEndTime || null,
        remarks: form.remarks,
        source: "manual",
      });
      router.push(`/tickets/${response.ticket.id}`);
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  if (!user?.permissions.createTicket) {
    return (
      <AppPage>
        <PageHeading title="New Ticket" />
        <AlertBanner tone="warning" title="Not allowed">
          Your role does not have permission to create tickets.
        </AlertBanner>
      </AppPage>
    );
  }

  return (
    <AppPage>
      <PageHeading
        title="New Ticket"
        badge={
          preview ? (
            <span
              className="rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide"
              style={{ color: ACCENT, borderColor: `${ACCENT}55`, backgroundColor: `${ACCENT}12` }}
            >
              {preview.next}
            </span>
          ) : null
        }
        description="The ticket number is reserved when you save. Fields marked AUTO are filled in from your session."
        actions={
          <GhostButton icon={ArrowLeft} onClick={() => router.back()}>
            Cancel
          </GhostButton>
        }
      />

      <form onSubmit={handleSubmit} className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <ErrorNote error={error} />

          <Panel title="Requestor">
            <div className="p-4">
              <RequestorPicker
                value={form.requestorId}
                onChange={(id, patch) =>
                  setForm((current) => ({
                    ...current,
                    requestorId: id,
                    // Inherit department/site when the submitter left them blank.
                    department: current.department || patch.department || "",
                    site: current.site || patch.site || "",
                  }))
                }
                options={options}
              />
            </div>
          </Panel>

          <Panel title="Ticket Details">
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <LabeledField label="Subject" required>
                  <TextInput
                    value={form.subject}
                    onChange={(event) => set("subject", event.target.value)}
                    required
                    maxLength={300}
                    placeholder="Short summary of the concern"
                  />
                </LabeledField>
              </div>

              <LabeledField label="Department">
                <OptionSelect
                  type="department"
                  options={options.department}
                  value={form.department}
                  onChange={(value) => set("department", value)}
                />
              </LabeledField>

              <LabeledField label="Request Type">
                <OptionSelect
                  type="requestType"
                  options={options.requestType}
                  value={form.requestType}
                  onChange={(value) => set("requestType", value)}
                />
              </LabeledField>

              <LabeledField label="Type of Concern">
                <OptionSelect
                  type="typeOfConcern"
                  options={options.typeOfConcern}
                  value={form.typeOfConcern}
                  onChange={(value) => set("typeOfConcern", value)}
                />
              </LabeledField>

              <LabeledField label="Mode">
                <OptionSelect
                  type="mode"
                  options={options.mode}
                  value={form.mode}
                  onChange={(value) => set("mode", value)}
                />
              </LabeledField>

              <LabeledField label="Services Group">
                <OptionSelect
                  type="servicesGroup"
                  options={options.servicesGroup}
                  value={form.servicesGroup}
                  onChange={(value) => set("servicesGroup", value)}
                />
              </LabeledField>

              <LabeledField label="Site">
                <OptionSelect
                  type="site"
                  options={options.site}
                  value={form.site}
                  onChange={(value) => set("site", value)}
                />
              </LabeledField>
            </div>
          </Panel>

          <Panel title="Actions & Dates">
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <LabeledField label="Remarks" hint="first note">
                <TextArea
                  rows={4}
                  value={form.remarks}
                  onChange={(event) => set("remarks", event.target.value)}
                  placeholder="Actions already taken, or context for the technician."
                />
              </LabeledField>

              {/* Scheduled Date — hidden when status is resolved/closed/cancelled (support times replace it) */}
              {!["resolved", "closed", "cancelled"].includes(form.status) ? (
                <LabeledField
                  label="Scheduled Date"
                  hint={form.status === "scheduled" ? "pauses the SLA clock" : "optional"}
                >
                  <DateTimePicker
                    value={form.scheduledDate || undefined}
                    onChange={(iso) => set("scheduledDate", iso ?? "")}
                    placeholder="Pick date & time"
                    fromDate={new Date()}
                  />
                </LabeledField>
              ) : null}

              {/* Support time — only shown when status is resolved/closed/cancelled */}
              {["resolved", "closed", "cancelled"].includes(form.status) ? (
                <div className="flex flex-col gap-2">
                  <LabeledField label="Start of Support">
                    <DateTimePicker
                      value={form.supportStartTime || undefined}
                      onChange={(iso) => set("supportStartTime", iso ?? "")}
                      placeholder="When support started"
                    />
                  </LabeledField>

                  <LabeledField label="End of Support">
                    <DateTimePicker
                      value={form.supportEndTime || undefined}
                      onChange={(iso) => set("supportEndTime", iso ?? "")}
                      placeholder="When issue was resolved"
                    />
                  </LabeledField>
                </div>
              ) : null}

              {/* Duration badge — spans both columns */}
              {["resolved", "closed", "cancelled"].includes(form.status) ? (
                <div className="sm:col-span-2">
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                    <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-[11px] text-muted-foreground">Duration:</span>
                    {(() => {
                      if (!form.supportStartTime || !form.supportEndTime) {
                        return (
                          <span className="text-[11px] italic text-muted-foreground">
                            Set both times to calculate
                          </span>
                        );
                      }
                      const diff =
                        new Date(form.supportEndTime).getTime() -
                        new Date(form.supportStartTime).getTime();
                      if (diff <= 0) {
                        return (
                          <span className="text-[11px] text-red-500">
                            End must be after start
                          </span>
                        );
                      }
                      const mins = Math.round(diff / 60000);
                      const h = Math.floor(mins / 60);
                      const m = mins % 60;
                      const label = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${mins} min`;
                      return (
                        <span className="font-mono text-[12px] font-bold text-foreground">
                          {label}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              ) : null}
            </div>
          </Panel>
        </div>

        {/* Sidebar: auto fields + priority */}
        <div className="space-y-4">
          <Panel title="Assignment">
            <div className="space-y-3 p-4">
              <AutoField label="Processed By" value={user.name} badge="AUTO" />
              <AutoField
                label="Technician"
                value={
                  user.permissions.assignTechnician && preview
                    ? "Per assignment setting"
                    : user.name
                }
                badge="AUTO"
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Processed By is you and cannot be changed. The technician defaults to you and can be
                reassigned from the ticket if you have the permission.
              </p>
            </div>
          </Panel>

          <Panel title="Priority & Status">
            <div className="space-y-3 p-4">
              <LabeledField label="Priority" hint="sets the SLA">
                <OptionSelect
                  type="priority"
                  options={options.priority}
                  value={form.priority}
                  onChange={(value) => set("priority", value)}
                  renderLabel={(option) =>
                    option.slaHours
                      ? `${option.label} (${option.slaHours}h SLA)`
                      : option.label
                  }
                />
              </LabeledField>

              <LabeledField label="Status">
                <OptionSelect
                  type="status"
                  options={options.status}
                  value={form.status}
                  onChange={(value) => set("status", value)}
                />
              </LabeledField>

              <div className="rounded-md border border-border bg-muted/40 p-2.5">
                <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                  Ticket Number
                </p>
                <p className="text-[13px] font-bold" style={{ color: ACCENT }}>
                  {preview?.next ?? "Assigned on save"}
                </p>
                {preview ? (
                  <p className="mt-1 text-[9px] text-muted-foreground">
                    Last issued: {preview.current}
                  </p>
                ) : null}
              </div>
            </div>
          </Panel>

          <div className="flex gap-2">
            <PrimaryButton type="submit" icon={Save} disabled={submitting} className="flex-1 justify-center">
              {submitting ? "Saving…" : "Create Ticket"}
            </PrimaryButton>
          </div>
        </div>
      </form>
    </AppPage>
  );
}

/** Renders one dropdown type as a select with an empty first option. */
function OptionSelect({
  options,
  value,
  onChange,
  renderLabel,
}: {
  type: string;
  options?: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  renderLabel?: (option: DropdownOption) => string;
}) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">— Select —</option>
      {(options ?? []).map((option) => (
        <option key={option.value} value={option.value}>
          {renderLabel ? renderLabel(option) : option.label}
        </option>
      ))}
    </Select>
  );
}

/**
 * Async searchable requestor dropdown with inline quick-add.
 *
 * The directory can be incomplete, so an agent must be able to add a requestor
 * without leaving the form. Quick-add only works with `manageRequestors`;
 * everyone else must pick an existing record.
 */
function RequestorPicker({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (
    id: string,
    patch: { department?: string; site?: string; fullName?: string },
  ) => void;
  options: Record<string, DropdownOption[]>;
}) {
  const { user } = useSession();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<Requestor[]>([]);
  const [selected, setSelected] = React.useState<Requestor | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [showQuickAdd, setShowQuickAdd] = React.useState(false);
  const [quickAdd, setQuickAdd] = React.useState({
    firstName: "",
    lastName: "",
    email: "",
    employeeId: "",
  });
  const [quickAddError, setQuickAddError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const canQuickAdd = Boolean(user?.permissions.manageRequestors);

  React.useEffect(() => {
    if (selected) return;
    let cancelled = false;

    async function search() {
      setLoading(true);
      try {
        const response = await api.get<{ requestors: Requestor[] }>(
          `/api/requestors?picker=1&search=${encodeURIComponent(query)}`,
        );
        if (!cancelled) setResults(response.requestors);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    // Debounce so typing does not fire a request per keystroke.
    const timer = setTimeout(() => void search(), 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, selected]);

  async function handleQuickAdd(event: React.FormEvent) {
    event.preventDefault();
    setQuickAddError(null);
    setSaving(true);
    try {
      const response = await api.post<{ requestor: Requestor }>("/api/requestors", {
        employeeId: quickAdd.employeeId.trim(),
        firstName: quickAdd.firstName.trim(),
        lastName: quickAdd.lastName.trim(),
        email: quickAdd.email.trim(),
        status: "active",
      });
      const created = response.requestor;
      setSelected(created);
      onChange(created.id, {
        department: created.department,
        site: created.site,
        fullName: created.fullName,
      });
      setShowQuickAdd(false);
      setQuickAdd({ firstName: "", lastName: "", email: "", employeeId: "" });
    } catch (caught) {
      setQuickAddError(caught instanceof Error ? caught.message : "Could not add the requestor.");
    } finally {
      setSaving(false);
    }
  }

  const departmentLabel = (deptValue: string) =>
    options.department?.find((option) => option.value === deptValue)?.label ?? "";

  if (selected) {
    return (
      <div className="rounded-md border border-border bg-muted/40 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-foreground">{selected.fullName}</p>
            <p className="text-[10px] text-muted-foreground">
              {[selected.employeeId, selected.email, departmentLabel(selected.department)]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setQuery("");
              onChange("", {});
            }}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title="Change requestor"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <TextInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, email or employee ID"
          className="pl-8"
          autoComplete="off"
        />
      </div>

      {loading ? (
        <p className="px-1 py-2 text-[10px] text-muted-foreground">Searching…</p>
      ) : results.length === 0 ? (
        <p className="px-1 py-2 text-[10px] text-muted-foreground">
          No match. {canQuickAdd ? "Add them below." : "Ask an administrator to add them to the directory."}
        </p>
      ) : (
        <ul className="max-h-52 overflow-y-auto rounded-md border border-border">
          {results.map((requestor) => (
            <li key={requestor.id}>
              <button
                type="button"
                onClick={() => {
                  setSelected(requestor);
                  onChange(requestor.id, {
                    department: requestor.department,
                    site: requestor.site,
                    fullName: requestor.fullName,
                  });
                }}
                className="flex w-full items-center justify-between gap-3 border-b border-border/60 px-2.5 py-2 text-left last:border-0 hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium text-foreground">
                    {requestor.fullName}
                  </span>
                  <span className="block truncate text-[9px] text-muted-foreground">
                    {[requestor.employeeId, requestor.email].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {requestor.department ? (
                  <span className="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">
                    {requestor.department}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {canQuickAdd ? (
        showQuickAdd ? (
          <form
            onSubmit={handleQuickAdd}
            className="rounded-md border border-dashed border-border p-3"
          >
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              Quick add requestors
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <TextInput
                placeholder="First name"
                required
                value={quickAdd.firstName}
                onChange={(event) =>
                  setQuickAdd((current) => ({ ...current, firstName: event.target.value }))
                }
                autoFocus
              />
              <TextInput
                placeholder="Last name"
                required
                value={quickAdd.lastName}
                onChange={(event) =>
                  setQuickAdd((current) => ({ ...current, lastName: event.target.value }))
                }
              />
              <TextInput
                placeholder="Employee ID"
                required
                value={quickAdd.employeeId}
                onChange={(event) =>
                  setQuickAdd((current) => ({ ...current, employeeId: event.target.value }))
                }
              />
              <TextInput
                placeholder="Email (optional)"
                type="email"
                value={quickAdd.email}
                onChange={(event) =>
                  setQuickAdd((current) => ({ ...current, email: event.target.value }))
                }
              />
            </div>
            {quickAddError ? (
              <p className="mt-2 text-[10px] text-red-600">{quickAddError}</p>
            ) : null}
            <div className="mt-2 flex gap-2">
              <PrimaryButton type="submit" disabled={saving} className="h-8">
                {saving ? "Saving…" : "Add"}
              </PrimaryButton>
              <GhostButton type="button" className="h-8" onClick={() => setShowQuickAdd(false)}>
                Cancel
              </GhostButton>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setShowQuickAdd(true)}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <UserPlus className="h-3 w-3" /> Not in the list? Add them
          </button>
        )
      ) : null}
    </div>
  );
}
