"use client";

import * as React from "react";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  Panel,
  TerminalBadge,
  ErrorNote,
  EmptyState,
  GhostButton,
  PrimaryButton,
  AlertBanner,
} from "@/components/app-shell";
import {
  LabeledField,
  TextInput,
  Select,
  TextArea,
  ACCENT,
} from "@/components/ui/primitives";
import { Download, Upload, UserPlus, Pencil, X, Check } from "lucide-react";
import { api, downloadCsv } from "@/lib/client/api";
import { useSession } from "@/contexts/SessionContext";
import type { DropdownOption, Requestor } from "@/lib/client/types";

type ImportReport = {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; employeeId: string; message: string }>;
};

export default function RequestorsDirectoryPage() {
  const { user } = useSession();

  const [requestors, setRequestors] = React.useState<Requestor[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<React.ReactNode>(null);

  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [options, setOptions] = React.useState<Record<string, DropdownOption[]>>({});

  const [editing, setEditing] = React.useState<Requestor | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = React.useState(false);

  const canManage = user?.permissions.manageRequestors;
  const canExport = user?.permissions.exportCsv;

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter) params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("pageSize", "25");
      const response = await api.get<{
        requestors: Requestor[];
        total: number;
        totalPages: number;
      }>(`/api/requestors?${params}`);
      setRequestors(response.requestors);
      setTotal(response.total);
      setTotalPages(response.totalPages);
      setSelected(new Set());
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, page]);

  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  React.useEffect(() => {
    void (async () => {
      try {
        const response = await api.get<{ grouped: Record<string, DropdownOption[]> }>(
          "/api/dropdowns",
        );
        setOptions(response.grouped ?? {});
      } catch {
        setOptions({});
      }
    })();
  }, []);

  async function runBulk(action: "activate" | "deactivate") {
    setError(null);
    try {
      const response = await api.post<{ updated: number }>("/api/requestors/bulk", {
        ids: [...selected],
        action,
      });
      setNotice(
        <span>
          {response.updated} requestor{response.updated === 1 ? "" : "s"} updated.
        </span>,
      );
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  async function remove(requestor: Requestor) {
    if (!window.confirm(`Delete ${requestor.fullName}?`)) return;
    setError(null);
    try {
      await api.delete(`/api/requestors/${requestor.id}`);
      await load();
    } catch (caught) {
      // The API explains the "linked to tickets" case with a friendly message.
      setError(caught);
    }
  }

  return (
    <AppPage
      search={{ value: search, onChange: setSearch, placeholder: "Search name, email, employee ID" }}
      actions={
        <>
          {canExport ? (
            <GhostButton
              icon={Download}
              onClick={() =>
                void downloadCsv(
                  "/api/requestors?format=csv",
                  `requestors_${new Date().toISOString().slice(0, 10)}.csv`,
                )
              }
            >
              Export
            </GhostButton>
          ) : null}
          {canManage ? (
            <>
              <GhostButton icon={Upload} onClick={() => setImportOpen((prev) => !prev)}>
                Import CSV
              </GhostButton>
              <PrimaryButton icon={UserPlus} onClick={() => setCreating(true)}>
                Add Requestor
              </PrimaryButton>
            </>
          ) : null}
        </>
      }
    >
      <PageHeading
        title="Requestors Directory"
        badge={<TerminalBadge label="Standalone · MongoDB" color={ACCENT} />}
        description="The employee and end-user directory. This list populates the Requestor Name dropdown on New Ticket, and unknown Gmail senders are added here automatically."
      />

      <div className="space-y-4">
        <ErrorNote error={error} />
        {notice ? <AlertBanner tone="success" title="Done">{notice}</AlertBanner> : null}

        {canManage && importOpen ? (
          <ImportPanel
            onClose={() => setImportOpen(false)}
            onDone={async (report) => {
              setNotice(
                <span>
                  Created {report.created}, updated {report.updated}, skipped {report.skipped}
                  {report.errors.length ? `, ${report.errors.length} row(s) had errors` : ""}.
                </span>,
              );
              await load();
            }}
          />
        ) : null}

        {creating ? (
          <RequestorForm
            title="Add Requestor"
            options={options}
            onCancel={() => setCreating(false)}
            onSaved={async () => {
              setCreating(false);
              await load();
            }}
          />
        ) : null}

        {editing ? (
          <RequestorForm
            title={`Edit ${editing.fullName}`}
            requestor={editing}
            options={options}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await load();
            }}
          />
        ) : null}

        {canManage && selected.size > 0 ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5"
            style={{ borderColor: `${ACCENT}55`, backgroundColor: `${ACCENT}0f` }}
          >
            <span className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: ACCENT }}>
              {selected.size} selected
            </span>
            <button
              type="button"
              onClick={() => void runBulk("activate")}
              className="rounded border border-emerald-300 px-2 py-1 text-[10px] uppercase tracking-wider text-emerald-700 hover:bg-emerald-50"
            >
              Activate
            </button>
            <button
              type="button"
              onClick={() => void runBulk("deactivate")}
              className="rounded border border-amber-300 px-2 py-1 text-[10px] uppercase tracking-wider text-amber-700 hover:bg-amber-50"
            >
              Deactivate
            </button>
          </div>
        ) : null}

        <Panel title="Directory" hint={`${total} record${total === 1 ? "" : "s"}`}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              Status
            </span>
            <Select
              className="h-8 w-40"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </div>

          {loading ? (
            <p className="px-4 py-10 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
              Loading…
            </p>
          ) : requestors.length === 0 ? (
            <EmptyState
              title="No requestors found"
              description={
                search
                  ? "Try a different search."
                  : "Import a CSV or add someone manually to populate the list."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left">
                <thead>
                  <tr className="border-b border-border">
                    {canManage ? (
                      <th className="w-9 px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          className="accent-[#f97316]"
                          checked={selected.size > 0 && selected.size === requestors.length}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? new Set(requestors.map((r) => r.id))
                                : new Set(),
                            )
                          }
                        />
                      </th>
                    ) : null}
                    <Th>Employee ID</Th>
                    <Th>Name</Th>
                    <Th>Email</Th>
                    <Th>Department</Th>
                    <Th>Site</Th>
                    <Th>Status</Th>
                    {canManage ? <Th>Actions</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {requestors.map((requestor) => (
                    <tr key={requestor.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                      {canManage ? (
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            aria-label={`Select ${requestor.fullName}`}
                            className="accent-[#f97316]"
                            checked={selected.has(requestor.id)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(requestor.id);
                              else next.delete(requestor.id);
                              setSelected(next);
                            }}
                          />
                        </td>
                      ) : null}
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[10px] text-muted-foreground">
                        {requestor.employeeId}
                        {requestor.isGuest ? (
                          <span className="ml-1.5 rounded bg-amber-100 px-1 py-px text-[8px] font-bold uppercase text-amber-700">
                            guest
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 font-medium">{requestor.fullName}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{requestor.email || "—"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{requestor.department || "—"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{requestor.site || "—"}</td>
                      <td className="px-3 py-2.5">
                        <TerminalBadge
                          label={requestor.status}
                          color={requestor.status === "active" ? "#22c55e" : "#94a3b8"}
                        />
                      </td>
                      {canManage ? (
                        <td className="px-3 py-2.5">
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => setEditing(requestor)}
                              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                              title="Edit"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void remove(requestor)}
                              className="rounded p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                              title="Delete"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {totalPages > 1 ? (
          <div className="flex items-center justify-between gap-3">
            <GhostButton disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </GhostButton>
            <span className="text-[10px] text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <GhostButton disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </GhostButton>
          </div>
        ) : null}
      </div>
    </AppPage>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
      {children}
    </th>
  );
}

/** Create / edit form. */
function RequestorForm({
  title,
  requestor,
  options,
  onCancel,
  onSaved,
}: {
  title: string;
  requestor?: Requestor;
  options: Record<string, DropdownOption[]>;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [form, setForm] = React.useState({
    employeeId: requestor?.employeeId ?? "",
    firstName: requestor?.firstName ?? "",
    lastName: requestor?.lastName ?? "",
    email: requestor?.email ?? "",
    department: requestor?.department ?? "",
    site: requestor?.site ?? "",
    phone: requestor?.phone ?? "",
    status: requestor?.status ?? "active",
    notes: requestor?.notes ?? "",
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (requestor) {
        await api.patch(`/api/requestors/${requestor.id}`, form);
      } else {
        await api.post("/api/requestors", form);
      }
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title={title}>
      <form onSubmit={submit} className="space-y-4 p-4">
        <ErrorNote error={error ? new Error(error) : null} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <LabeledField label="Employee ID" required>
            <TextInput
              required
              value={form.employeeId}
              onChange={(event) => setForm((c) => ({ ...c, employeeId: event.target.value }))}
            />
          </LabeledField>
          <LabeledField label="First Name" required>
            <TextInput
              required
              value={form.firstName}
              onChange={(event) => setForm((c) => ({ ...c, firstName: event.target.value }))}
            />
          </LabeledField>
          <LabeledField label="Last Name" required>
            <TextInput
              required
              value={form.lastName}
              onChange={(event) => setForm((c) => ({ ...c, lastName: event.target.value }))}
            />
          </LabeledField>
          <LabeledField label="Email">
            <TextInput
              type="email"
              value={form.email}
              onChange={(event) => setForm((c) => ({ ...c, email: event.target.value }))}
            />
          </LabeledField>
          <LabeledField label="Department">
            <Select
              value={form.department}
              onChange={(event) => setForm((c) => ({ ...c, department: event.target.value }))}
            >
              <option value="">— Select —</option>
              {(options.department ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </LabeledField>
          <LabeledField label="Site">
            <Select
              value={form.site}
              onChange={(event) => setForm((c) => ({ ...c, site: event.target.value }))}
            >
              <option value="">— Select —</option>
              {(options.site ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </LabeledField>
          <LabeledField label="Phone">
            <TextInput
              value={form.phone}
              onChange={(event) => setForm((c) => ({ ...c, phone: event.target.value }))}
            />
          </LabeledField>
          <LabeledField label="Status">
            <Select
              value={form.status}
              onChange={(event) => setForm((c) => ({ ...c, status: event.target.value }))}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </LabeledField>
          <div className="sm:col-span-2 lg:col-span-3">
            <LabeledField label="Notes">
              <TextArea
                rows={2}
                value={form.notes}
                onChange={(event) => setForm((c) => ({ ...c, notes: event.target.value }))}
              />
            </LabeledField>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <GhostButton type="button" onClick={onCancel}>
            Cancel
          </GhostButton>
          <PrimaryButton type="submit" icon={Check} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </PrimaryButton>
        </div>
      </form>
    </Panel>
  );
}

/** CSV import with a paste-or-upload textarea and a per-row error report. */
function ImportPanel({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (report: ImportReport) => void | Promise<void>;
}) {
  const [csv, setCsv] = React.useState("");
  const [updateExisting, setUpdateExisting] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setRunning(true);
    setError(null);
    try {
      const response = await api.post<{ report: ImportReport }>("/api/requestors/import", {
        csv,
        updateExisting,
      });
      await onDone(response.report);
      setCsv("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Panel title="Import Requestors from CSV">
      <form onSubmit={submit} className="space-y-3 p-4">
        <ErrorNote error={error ? new Error(error) : null} />

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Header row required. Supported columns:{" "}
          <code className="rounded bg-muted px-1">employeeId</code>,{" "}
          <code className="rounded bg-muted px-1">firstName</code>,{" "}
          <code className="rounded bg-muted px-1">lastName</code>,{" "}
          <code className="rounded bg-muted px-1">email</code>,{" "}
          <code className="rounded bg-muted px-1">department</code>,{" "}
          <code className="rounded bg-muted px-1">site</code>,{" "}
          <code className="rounded bg-muted px-1">phone</code>. Column order does not matter.
        </p>

        <TextArea
          rows={8}
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
          placeholder={"employeeId,firstName,lastName,email,department,site,phone\nEMP-0001,Juan,Dela Cruz,juan@company.com,Engineering,Disruptive - Primex,"}
          className="font-mono text-[11px]"
        />

        <label className="flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={updateExisting}
            onChange={(event) => setUpdateExisting(event.target.checked)}
            className="accent-[#f97316]"
          />
          Update existing records with the same employee ID
        </label>

        <div className="flex justify-end gap-2">
          <GhostButton type="button" onClick={onClose}>
            Close
          </GhostButton>
          <PrimaryButton type="submit" icon={Upload} disabled={running || !csv.trim()}>
            {running ? "Importing…" : "Run Import"}
          </PrimaryButton>
        </div>
      </form>
    </Panel>
  );
}