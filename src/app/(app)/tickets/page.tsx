"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
import { Download, Plus, X, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { api, downloadCsv } from "@/lib/client/api";
import { useSession } from "@/contexts/SessionContext";
import type { DropdownOption, Ticket, TicketListResponse } from "@/lib/client/types";
import { formatDuration, formatDateTime, fromDateInputValue } from "@/lib/shared/format";
import { cn } from "@/lib/utils";
import { LabeledField, Select, TextInput, ACCENT } from "@/components/ui/primitives";

const STATUS_COLORS: Record<string, string> = {
  pending: "#eab308",
  scheduled: "#06b6d4",
  ongoing: "#f97316",
  resolved: "#22c55e",
  closed: "#22c55e",
  cancelled: "#94a3b8",
};

const SLA_COLORS: Record<string, { text: string; bar: string }> = {
  breached: { text: "text-red-600", bar: "bg-red-500" },
  critical: { text: "text-orange-600", bar: "bg-orange-500" },
  warning: { text: "text-amber-600", bar: "bg-amber-400" },
  ok: { text: "text-emerald-600", bar: "bg-emerald-500" },
  none: { text: "text-muted-foreground", bar: "bg-stone-300" },
};

/** Tab definitions double as quick filters. */
type Tab = { key: string; label: string; params: Record<string, string> };

export default function TicketsPage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <TicketsView />
    </React.Suspense>
  );
}

function TicketsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useSession();

  const [tickets, setTickets] = React.useState<Ticket[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [search, setSearch] = React.useState(searchParams?.get("search") ?? "");
  const [debouncedSearch, setDebouncedSearch] = React.useState(search);

  const [showFilters, setShowFilters] = React.useState(false);
  const [statusFilter, setStatusFilter] = React.useState<string[]>([]);
  const [priorityFilter, setPriorityFilter] = React.useState<string[]>([]);
  const [departmentFilter, setDepartmentFilter] = React.useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = React.useState<string[]>([]);
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [openOnly, setOpenOnly] = React.useState(searchParams?.get("openOnly") === "true");
  const [breachedOnly, setBreachedOnly] = React.useState(false);

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [options, setOptions] = React.useState<Record<string, DropdownOption[] | undefined>>({});
  const [technicians, setTechnicians] = React.useState<Array<{ id: string; name: string }>>([]);
  const [refreshNonce, setRefreshNonce] = React.useState(0);
  const [sort, setSort] = React.useState<"newest" | "sla" | "updated">("newest");
  const [bulkTechnicianId, setBulkTechnicianId] = React.useState("");
  const [bulkStatus, setBulkStatus] = React.useState("");

  React.useEffect(() => {
    document.title = "Tickets — Help Desk";
  }, []);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Any filter change resets to page 1, otherwise you land on an empty page.
  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, priorityFilter, departmentFilter, sourceFilter, dateFrom, dateTo, openOnly, breachedOnly]);

  // Load the dropdown option sets once.
  React.useEffect(() => {
    async function load() {
      try {
        const response = await api.get<{ grouped: Record<string, DropdownOption[]> }>(
          "/api/dropdowns",
        );
        setOptions(response.grouped ?? {});
      } catch {
        // Filters degrade to "all" rather than blocking the page.
      }
    }
    void load();
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

  const activeFilterCount =
    statusFilter.length +
    priorityFilter.length +
    departmentFilter.length +
    sourceFilter.length +
    (dateFrom ? 1 : 0) +
    (dateTo ? 1 : 0) +
    (openOnly ? 1 : 0) +
    (breachedOnly ? 1 : 0);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (statusFilter.length) params.set("status", statusFilter.join(","));
        if (priorityFilter.length) params.set("priority", priorityFilter.join(","));
        if (departmentFilter.length) params.set("department", departmentFilter.join(","));
        if (sourceFilter.length) params.set("source", sourceFilter.join(","));
        if (openOnly) params.set("openOnly", "true");
        if (breachedOnly) params.set("breachedOnly", "true");
        params.set("sort", sort);
        if (dateFrom) {
          const d = fromDateInputValue(dateFrom);
          if (d) params.set("from", d.toISOString());
        }
        if (dateTo) {
          const d = fromDateInputValue(dateTo);
          if (d) {
            d.setUTCHours(23, 59, 59, 999);
            params.set("to", d.toISOString());
          }
        }
        params.set("page", String(page));
        params.set("pageSize", "25");

        const response = await api.get<TicketListResponse>(`/api/tickets?${params}`);
        if (cancelled) return;
        setTickets(response.tickets);
        setTotal(response.total);
        setTotalPages(response.totalPages);
        setSelected(new Set());
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(caught);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    debouncedSearch,
    statusFilter,
    priorityFilter,
    departmentFilter,
    sourceFilter,
    dateFrom,
    dateTo,
    openOnly,
    breachedOnly,
    page,
    sort,
    refreshNonce,
  ]);

  const tabs = React.useMemo<Tab[]>(() => {
    const base: Tab[] = [
      { key: "all", label: "All", params: {} },
      { key: "open", label: "Open", params: { openOnly: "true" } },
      { key: "breached", label: "SLA Breached", params: { breachedOnly: "true", openOnly: "true" } },
      { key: "email", label: "From Gmail", params: { source: "email" } },
    ];
    if (user?.permissions.viewAllTickets) {
      base.splice(2, 0, { key: "unassigned", label: "Unassigned", params: { technician: "none" } });
    }
    return base;
  }, [user]);

  const activeTab = React.useMemo(() => {
    if (breachedOnly) return "breached";
    if (openOnly && !sourceFilter.includes("email")) return "open";
    if (sourceFilter.includes("email") && !openOnly) return "email";
    return "all";
  }, [breachedOnly, openOnly, sourceFilter]);

  function applyTab(tab: Tab) {
    setOpenOnly(tab.params.openOnly === "true");
    setBreachedOnly(tab.params.breachedOnly === "true");
    setSourceFilter(tab.params.source ? [tab.params.source] : []);
    setStatusFilter([]);
  }

  function toggleFilter(
    value: string,
    current: string[],
    setter: (next: string[]) => void,
  ) {
    setter(
      current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value],
    );
  }

  async function handleExport() {
    setNotice(null);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (statusFilter.length) params.set("status", statusFilter.join(","));
    if (priorityFilter.length) params.set("priority", priorityFilter.join(","));
    if (departmentFilter.length) params.set("department", departmentFilter.join(","));
    if (sourceFilter.length) params.set("source", sourceFilter.join(","));
    try {
      await downloadCsv(
        `/api/tickets/export?${params}`,
        `tickets_${new Date().toISOString().slice(0, 10)}.csv`,
      );
    } catch (caught) {
      setError(caught);
    }
  }

  async function runBulk(
    action: "assign" | "status" | "delete",
    extra: Record<string, unknown> = {},
  ) {
    setNotice(null);
    try {
      const response = await api.post<{ updated: number; skipped?: unknown[] }>(
        "/api/tickets/bulk",
        { ids: [...selected], action, ...extra },
      );
      setNotice(
        response.skipped?.length
          ? `Updated ${response.updated} ticket(s). ${response.skipped.length} could not be updated.`
          : `Updated ${response.updated} ticket(s).`,
      );
      setSelected(new Set());
      setBulkTechnicianId("");
      setBulkStatus("");
      router.refresh();
      setRefreshNonce((n) => n + 1);
    } catch (caught) {
      setError(caught);
    }
  }

  function clearFilters() {
    setStatusFilter([]);
    setPriorityFilter([]);
    setDepartmentFilter([]);
    setSourceFilter([]);
    setDateFrom("");
    setDateTo("");
    setOpenOnly(false);
    setBreachedOnly(false);
    setSearch("");
    setDebouncedSearch("");
  }

  const canCreate = user?.permissions.createTicket;
  const canBulk = Boolean(user?.permissions.assignTechnician || user?.permissions.changeStatus);
  const canDelete = user?.permissions.deleteTicket;

  return (
    <AppPage
      search={{ value: search, onChange: setSearch }}
      onFiltersClick={() => setShowFilters((prev) => !prev)}
      activeFilterCount={activeFilterCount}
      actions={
        <>
          {user?.permissions.exportCsv ? (
            <GhostButton icon={Download} onClick={handleExport}>
              CSV
            </GhostButton>
          ) : null}
          {canCreate ? (
            <PrimaryButton icon={Plus} onClick={() => router.push("/tickets/new")}>
              New Ticket
            </PrimaryButton>
          ) : null}
        </>
      }
    >
      <PageHeading
        title="Received Tickets"
        badge={
          user?.permissions.viewAllTickets ? null : (
            <TerminalBadge label="Assigned only" color="#06b6d4" />
          )
        }
        description={
          user?.permissions.viewAllTickets
            ? "Every ticket in the system. Search, filter, export and bulk-update."
            : "Showing tickets assigned to or processed by you."
        }
      />

      <div className="space-y-4">
        <ErrorNote error={error} />
        {notice ? <AlertBanner tone="success" title="Done">{notice}</AlertBanner> : null}

        {/* Tabs */}
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => applyTab(tab)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors",
                activeTab === tab.key
                  ? "border-transparent text-white"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              style={activeTab === tab.key ? { backgroundColor: ACCENT } : undefined}
            >
              {tab.label}
            </button>
          ))}
          <span className="self-center text-[10px] text-muted-foreground">
            {total} result{total === 1 ? "" : "s"}
          </span>
        </div>

        {/* Filter panel */}
        {showFilters ? (
          <Panel
            title="Filters"
            actions={
              <button
                type="button"
                onClick={clearFilters}
                className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            }
          >
            <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
              <FilterGroup
                label="Status"
                values={options.status ?? []}
                selected={statusFilter}
                onToggle={(value) => toggleFilter(value, statusFilter, setStatusFilter)}
                colorFor={(option) => STATUS_COLORS[option.value]}
              />
              <FilterGroup
                label="Priority"
                values={options.priority ?? []}
                selected={priorityFilter}
                onToggle={(value) => toggleFilter(value, priorityFilter, setPriorityFilter)}
                colorFor={(option) => option.color}
              />
              <FilterGroup
                label="Department"
                values={options.department ?? []}
                selected={departmentFilter}
                onToggle={(value) => toggleFilter(value, departmentFilter, setDepartmentFilter)}
              />
              <div className="space-y-3">
                <LabeledField label="Created From">
                  <TextInput
                    type="date"
                    value={dateFrom}
                    onChange={(event) => setDateFrom(event.target.value)}
                  />
                </LabeledField>
                <LabeledField label="Created To">
                  <TextInput
                    type="date"
                    value={dateTo}
                    onChange={(event) => setDateTo(event.target.value)}
                  />
                </LabeledField>
                <div className="flex flex-col gap-1.5 pt-1">
                  <CheckLine
                    checked={openOnly}
                    onChange={setOpenOnly}
                    label="Only unresolved"
                  />
                  <CheckLine
                    checked={breachedOnly}
                    onChange={setBreachedOnly}
                    label="Only SLA breached"
                  />
                  <CheckLine
                    checked={sourceFilter.includes("email")}
                    onChange={(next) =>
                      setSourceFilter(next ? ["email"] : [])
                    }
                    label="From email only"
                  />
                </div>
              </div>
            </div>
          </Panel>
        ) : null}

        {/* Bulk actions */}
        {selected.size > 0 && canBulk ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5"
            style={{ borderColor: `${ACCENT}55`, backgroundColor: `${ACCENT}0f` }}
          >
            <span className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: ACCENT }}>
              {selected.size} selected
            </span>

            {user?.permissions.assignTechnician ? (
              <>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Assign to
                </span>
                <Select
                  className="h-8 w-44"
                  value={bulkTechnicianId}
                  onChange={(event) => {
                    setBulkTechnicianId(event.target.value);
                    if (event.target.value) void runBulk("assign", { technicianId: event.target.value });
                  }}
                >
                  <option value="">Choose agent…</option>
                  {technicians.map((tech) => (
                    <option key={tech.id} value={tech.id}>
                      {tech.name}
                    </option>
                  ))}
                </Select>
              </>
            ) : null}

            {user?.permissions.changeStatus ? (
              <>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Set status
                </span>
                <Select
                  className="h-8 w-40"
                  value={bulkStatus}
                  onChange={(event) => {
                    setBulkStatus(event.target.value);
                    if (event.target.value) void runBulk("status", { status: event.target.value });
                  }}
                >
                  <option value="">Choose status…</option>
                  {(options.status ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </>
            ) : null}

            {canDelete ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Permanently delete ${selected.size} ticket(s)? This cannot be undone.`)) {
                    void runBulk("delete");
                  }
                }}
                className="ml-auto flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-[10px] uppercase tracking-wider text-red-600 hover:bg-red-50"
              >
                <Trash2 className="h-3 w-3" /> Delete
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Table */}
        <Panel title="Ticket List" hint={`${tickets.length} on this page`}>
          {loading ? (
            <p className="px-4 py-10 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
              Loading tickets…
            </p>
          ) : tickets.length === 0 ? (
            <EmptyState
              title="No tickets found"
              description="Adjust the filters, or create a ticket to get started."
              action={
                canCreate ? (
                  <PrimaryButton icon={Plus} onClick={() => router.push("/tickets/new")}>
                    New Ticket
                  </PrimaryButton>
                ) : null
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] text-left">
                <thead>
                  <tr className="border-b border-border">
                    {canBulk || canDelete ? (
                      <th className="w-9 px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={selected.size > 0 && selected.size === tickets.length}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? new Set(tickets.map((ticket) => ticket.id))
                                : new Set(),
                            )
                          }
                          className="accent-[#f97316]"
                        />
                      </th>
                    ) : null}
                    <Th>Ticket #</Th>
                    <Th>Subject</Th>
                    <Th>Priority</Th>
                    <Th>Status</Th>
                    <Th>Requestor</Th>
                    <Th>Dept</Th>
                    <Th>Technician</Th>
                    <Th
                      sortKey="sla"
                      currentSort={sort}
                      onSort={(key) => setSort(key as "newest" | "sla" | "updated")}
                    >
                      SLA
                    </Th>
                    <Th>Source</Th>
                    <Th
                      sortKey="newest"
                      currentSort={sort}
                      onSort={(key) => setSort(key as "newest" | "sla" | "updated")}
                    >
                      Created
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((ticket) => (
                    <tr
                      key={ticket.id}
                      className={cn(
                        "border-b border-border/60 last:border-0 hover:bg-muted/40",
                        selected.has(ticket.id) && "bg-muted/60",
                      )}
                    >
                      {canBulk || canDelete ? (
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${ticket.ticketNumber}`}
                            checked={selected.has(ticket.id)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(ticket.id);
                              else next.delete(ticket.id);
                              setSelected(next);
                            }}
                            className="accent-[#f97316]"
                          />
                        </td>
                      ) : null}
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/tickets/${ticket.id}`}
                          className="whitespace-nowrap text-[11px] font-bold hover:underline"
                          style={{ color: ACCENT }}
                        >
                          {ticket.ticketNumber}
                        </Link>
                      </td>
                      <td className="max-w-[260px] px-3 py-2.5">
                        <Link href={`/tickets/${ticket.id}`} className="block truncate hover:underline">
                          {ticket.subject}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5">
                        <TerminalBadge
                          label={ticket.priority.label || "—"}
                          color={ticket.priority.color}
                          inactive={ticket.priority.inactive}
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <TerminalBadge
                          label={ticket.statusLabel || ticket.status}
                          color={STATUS_COLORS[ticket.status] ?? "#94a3b8"}
                        />
                      </td>
                      <td className="max-w-[170px] px-3 py-2.5">
                        <span className="block truncate">{ticket.requestorName || "—"}</span>
                        {ticket.requestorEmail ? (
                          <span className="block truncate text-[9px] text-muted-foreground">
                            {ticket.requestorEmail}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{ticket.department || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                        {ticket.technicianName || "Unassigned"}
                      </td>
                      <td className="px-3 py-2.5">
                        <SlaCell ticket={ticket} />
                      </td>
                      <td className="px-3 py-2.5">
                        {ticket.source === "email" ? (
                          <TerminalBadge label="Gmail" color="#06b6d4" />
                        ) : ticket.source === "webform" ? (
                          <TerminalBadge label="Web" color="#8b5cf6" />
                        ) : (
                          <TerminalBadge label="Manual" color="#94a3b8" />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-[10px] text-muted-foreground">
                        {formatDateTime(ticket.dateCreated)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Pagination */}
        {totalPages > 1 ? (
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
              className="rounded-md border border-border px-3 py-1.5 text-[10px] uppercase tracking-wider disabled:opacity-40"
            >
              Previous
            </button>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">Page</span>
              <TextInput
                type="number"
                min={1}
                max={totalPages}
                value={page}
                onChange={(event) => {
                  const n = Number(event.target.value);
                  if (n >= 1 && n <= totalPages) setPage(n);
                }}
                className="h-8 w-14 text-center"
              />
              <span className="text-[10px] text-muted-foreground">of {totalPages}</span>
            </div>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((current) => current + 1)}
              className="rounded-md border border-border px-3 py-1.5 text-[10px] uppercase tracking-wider disabled:opacity-40"
            >
              Next
            </button>
          </div>
        ) : null}
      </div>
    </AppPage>
  );
}

function SlaCell({ ticket }: { ticket: Ticket }) {
  if (ticket.isClosed) {
    return (
      <span className="whitespace-nowrap text-[10px] text-muted-foreground">
        {ticket.durationLabel}
      </span>
    );
  }
  if (ticket.sla.remainingSeconds === null) {
    return <span className="text-[10px] text-muted-foreground">No SLA</span>;
  }
  const band = SLA_COLORS[ticket.sla.band] ?? SLA_COLORS.none;
  const ratio =
    ticket.sla.consumedRatio === null
      ? 0
      : Math.min(100, Math.max(0, ticket.sla.consumedRatio * 100));

  return (
    <div className="w-24">
      <p className={cn("whitespace-nowrap text-[10px] font-semibold tabular-nums", band.text)}>
        {ticket.sla.breached ? "-" : ""}
        {formatDuration(Math.abs(ticket.sla.remainingSeconds))}
        {ticket.sla.paused ? " ⏸" : ""}
      </p>
      <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", band.bar)}
          style={{ width: `${ratio}%` }}
        />
      </span>
    </div>
  );
}

function Th({
  children,
  sortKey,
  currentSort,
  onSort,
}: {
  children: React.ReactNode;
  sortKey?: string;
  currentSort?: string;
  onSort?: (key: string) => void;
}) {
  const isActive = sortKey !== undefined && currentSort === sortKey;
  if (sortKey && onSort) {
    return (
      <th
        className="cursor-pointer select-none px-3 py-2 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground"
        onClick={() => onSort(sortKey)}
      >
        <span className="inline-flex items-center gap-1">
          {children}
          {isActive ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronUp className="h-3 w-3 opacity-30" />
          )}
        </span>
      </th>
    );
  }
  return (
    <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
      {children}
    </th>
  );
}

function FilterGroup({
  label,
  values,
  selected,
  onToggle,
  colorFor,
}: {
  label: string;
  values: DropdownOption[];
  selected: string[];
  onToggle: (value: string) => void;
  colorFor?: (option: DropdownOption) => string | undefined;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
        {label}
      </p>
      <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
        {values.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onToggle(option.value)}
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors",
              selected.includes(option.value)
                ? "bg-muted font-semibold"
                : "hover:bg-muted/60",
            )}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: colorFor?.(option) ?? "#cbd5e1" }}
            />
            <span className="truncate">{option.label}</span>
          </button>
        ))}
        {values.length === 0 ? (
          <p className="px-2 py-1 text-[10px] text-muted-foreground">No options configured.</p>
        ) : null}
      </div>
    </div>
  );
}

function CheckLine({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-[#f97316]"
      />
      {label}
    </label>
  );
}