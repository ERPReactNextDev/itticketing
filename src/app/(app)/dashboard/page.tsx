"use client";

import * as React from "react";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  StatCard,
  Panel,
  TerminalBadge,
  ErrorNote,
  EmptyState,
  AlertBanner,
} from "@/components/app-shell";
import {
  CheckCircle2,
  Loader2,
  Clock3,
  Mail,
  AlertTriangle,
  Ticket as TicketIcon,
  Users,
  Building2,
} from "lucide-react";
import { api } from "@/lib/client/api";
import type { DashboardData } from "@/lib/client/types";
import { formatDuration } from "@/lib/shared/format";
import { cn } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  pending: "#eab308",
  scheduled: "#06b6d4",
  ongoing: "#f97316",
  resolved: "#22c55e",
  closed: "#22c55e",
  cancelled: "#94a3b8",
};

export default function DashboardPage() {
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await api.get<DashboardData>("/api/dashboard");
        if (!cancelled) setData(response);
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
  }, []);

  React.useEffect(() => {
    document.title = "Dashboard — Help Desk";
  }, []);

  const totals = data?.totals;
  const statusCounts = React.useMemo(() => {
    const map = new Map((data?.byStatus ?? []).map((row) => [row.key, row.count]));
    return {
      pending: map.get("pending") ?? 0,
      scheduled: map.get("scheduled") ?? 0,
      ongoing: map.get("ongoing") ?? 0,
      resolved: (map.get("resolved") ?? 0) + (map.get("closed") ?? 0),
    };
  }, [data]);

  const maxTechnician = Math.max(1, ...(data?.byTechnician ?? []).map((row) => row.count));
  const maxDepartment = Math.max(1, ...(data?.byDepartment ?? []).map((row) => row.count));

  // "Unassigned" is a bucket, not an agent, so it must not inflate the count.
  const assignedAgents = (data?.byTechnician ?? []).filter((row) => row.name !== "Unassigned").length;

  return (
    <AppPage>
      <PageHeading
        title="Dashboard"
        description="Live ticket health across the help desk. Every figure below is aggregated in MongoDB."
      />

      <div className="space-y-4">
        <ErrorNote error={error} />

        {/* SLA alerting - the single most important thing on this page. */}
        {totals && totals.breached > 0 ? (
          <AlertBanner tone="danger" title={`${totals.breached} ticket(s) have breached their SLA`}>
            <p className="mb-2">
              These tickets are past their priority deadline and still open. Reassign or escalate them.
            </p>
            <ul className="space-y-1">
              {data?.atRiskTickets
                .filter((ticket) => ticket.breached)
                .slice(0, 3)
                .map((ticket) => (
                  <li key={ticket.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <a
                      href={`/tickets/${ticket.id}`}
                      className="font-semibold underline underline-offset-2"
                    >
                      {ticket.ticketNumber}
                    </a>
                    <span className="truncate">{ticket.subject}</span>
                    <span className="text-muted-foreground">
                      · {ticket.technicianName} · {formatDuration(Math.abs(ticket.remainingSeconds ?? 0))} over
                    </span>
                  </li>
                ))}
            </ul>
          </AlertBanner>
        ) : totals && totals.atRisk > 0 ? (
          <AlertBanner tone="warning" title={`${totals.atRisk} ticket(s) are close to breaching`}>
            <ul className="space-y-1">
              {data?.atRiskTickets.slice(0, 3).map((ticket) => (
                <li key={ticket.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                  <a
                    href={`/tickets/${ticket.id}`}
                    className="font-semibold underline underline-offset-2"
                  >
                    {ticket.ticketNumber}
                  </a>
                  <span className="truncate">{ticket.subject}</span>
                  <span className="text-muted-foreground">
                    · {formatDuration(ticket.remainingSeconds ?? 0)} left
                  </span>
                </li>
              ))}
            </ul>
          </AlertBanner>
        ) : null}

        {/* Stat cards */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Total Tickets"
            value={loading ? "—" : (totals?.all ?? 0)}
            loading={loading}
            hint={
              totals && totals.all > 0
                ? `${statusCounts.pending + statusCounts.ongoing + statusCounts.scheduled} still open`
                : "No tickets yet"
            }
            accent="#f97316"
            icon={TicketIcon}
          />
          <StatCard
            label="Resolved"
            value={loading ? "—" : statusCounts.resolved}
            loading={loading}
            hint={
              totals && totals.all > 0
                ? `${((statusCounts.resolved / totals.all) * 100).toFixed(1)}% resolve rate`
                : undefined
            }
            accent="#22c55e"
            icon={CheckCircle2}
          />
          <StatCard
            label="Ongoing"
            value={loading ? "—" : statusCounts.ongoing}
            loading={loading}
            hint="Being worked on"
            accent="#f97316"
            icon={Loader2}
          />
          <StatCard
            label="Pending"
            value={loading ? "—" : statusCounts.pending}
            loading={loading}
            hint="Awaiting action"
            accent="#eab308"
            icon={Clock3}
          />
          <StatCard
            label="From Gmail"
            value={loading ? "—" : (totals?.fromGmail ?? 0)}
            loading={loading}
            hint="Auto-created via Resend"
            accent="#06b6d4"
            icon={Mail}
          />
          <StatCard
            label="SLA Breached"
            value={loading ? "—" : (totals?.breached ?? 0)}
            loading={loading}
            hint={
              totals?.avgResolutionSeconds
                ? `Avg resolution ${formatDuration(totals.avgResolutionSeconds)}`
                : "Past deadline and open"
            }
            accent="#ef4444"
            icon={AlertTriangle}
          />
          <StatCard
            label="Scheduled"
            value={loading ? "—" : statusCounts.scheduled}
            loading={loading}
            hint={totals?.inboundLast24h ? `${totals.inboundLast24h} new email(s) today` : "Planned work"}
            accent="#06b6d4"
            icon={Clock3}
          />
          <StatCard
            label="Assigned Agents"
            value={loading ? "—" : assignedAgents}
            loading={loading}
            hint="Agents with at least one ticket"
            accent="#8b5cf6"
            icon={Users}
          />
        </div>

        {/* Load-balanced charts */}
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Tickets per Technician" hint="Based on processed counts">
            {loading ? (
              <p className="px-4 py-8 text-center text-[11px] text-muted-foreground">Loading…</p>
            ) : data?.byTechnician.length ? (
              <ul className="space-y-2.5 p-4">
                {data.byTechnician.map((row) => (
                  <li key={row.name} className="flex items-center gap-3">
                    <span className="w-36 shrink-0 truncate text-[10px] uppercase tracking-wider text-muted-foreground">
                      {row.name}
                    </span>
                    <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${(row.count / maxTechnician) * 100}%`,
                          backgroundColor: "#f97316",
                        }}
                      />
                    </span>
                    <span className="w-8 shrink-0 text-right text-[11px] font-bold tabular-nums">
                      {row.count}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No tickets yet" />
            )}
          </Panel>

          <Panel title="Tickets per Department">
            {loading ? (
              <p className="px-4 py-8 text-center text-[11px] text-muted-foreground">Loading…</p>
            ) : data?.byDepartment.length ? (
              <ul className="space-y-2.5 p-4">
                {data.byDepartment.map((row) => (
                  <li key={row.key} className="flex items-center gap-3">
                    <span className="w-36 shrink-0 truncate text-[10px] uppercase tracking-wider text-muted-foreground">
                      {row.key || "Unassigned"}
                    </span>
                    <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${(row.count / maxDepartment) * 100}%`,
                          backgroundColor: "#22c55e",
                        }}
                      />
                    </span>
                    <span className="w-8 shrink-0 text-right text-[11px] font-bold tabular-nums">
                      {row.count}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No tickets yet" />
            )}
          </Panel>
        </div>

        {/* Breakdown by status and priority */}
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Status Breakdown">
            <ul className="divide-y divide-border">
              {(data?.byStatus ?? []).map((row) => (
                <li key={row.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <TerminalBadge
                    label={row.key}
                    color={STATUS_COLORS[row.key] ?? "#94a3b8"}
                  />
                  <span className="text-[12px] font-bold tabular-nums">{row.count}</span>
                </li>
              ))}
              {!data?.byStatus.length && !loading ? (
                <li>
                  <EmptyState title="No status data" />
                </li>
              ) : null}
            </ul>
          </Panel>

          <Panel title="Priority Breakdown">
            <ul className="divide-y divide-border">
              {(data?.byPriority ?? []).map((row) => (
                <li key={row.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="truncate text-[11px] text-foreground">{row.key || "Unset"}</span>
                  <span className="text-[12px] font-bold tabular-nums">{row.count}</span>
                </li>
              ))}
              {!data?.byPriority.length && !loading ? (
                <li>
                  <EmptyState title="No priority data" />
                </li>
              ) : null}
            </ul>
          </Panel>
        </div>

        {/* Closest to breach */}
        {data?.atRiskTickets.length ? (
          <Panel title="Closest to SLA Breach" hint="Open tickets ordered by deadline">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border">
                    <Th>Ticket</Th>
                    <Th>Subject</Th>
                    <Th>Priority</Th>
                    <Th>Status</Th>
                    <Th>Technician</Th>
                    <Th align="right">Remaining</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.atRiskTickets.map((ticket) => (
                    <tr key={ticket.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                      <Td>
                        <a href={`/tickets/${ticket.id}`} className="font-semibold hover:underline">
                          {ticket.ticketNumber}
                        </a>
                      </Td>
                      <Td className="max-w-[280px] truncate">{ticket.subject}</Td>
                      <Td>
                        <TerminalBadge label={ticket.priorityLabel} color={ticket.priorityColor} />
                      </Td>
                      <Td>
                        <TerminalBadge
                          label={ticket.status}
                          color={STATUS_COLORS[ticket.status] ?? "#94a3b8"}
                        />
                      </Td>
                      <Td className="text-muted-foreground">{ticket.technicianName}</Td>
                      <Td align="right">
                        <span
                          className="font-semibold tabular-nums"
                          style={{ color: ticket.breached ? "#dc2626" : "#ea580c" }}
                        >
                          {ticket.breached ? "-" : ""}
                          {formatDuration(Math.abs(ticket.remainingSeconds ?? 0))}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}

        <p className="flex items-center gap-1.5 pb-2 text-[10px] text-muted-foreground">
          <Building2 className="h-3 w-3" />
          Totals respect your role: agents only see tickets assigned to or processed by them.
        </p>
      </div>
    </AppPage>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`px-4 py-2 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-4 py-2.5 text-[11px] text-foreground",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}