"use client";

import * as React from "react";
import Link from "next/link";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  Panel,
  TerminalBadge,
  ErrorNote,
  EmptyState,
  GhostButton,
} from "@/components/app-shell";
import { RefreshCw, ExternalLink } from "lucide-react";
import { api } from "@/lib/client/api";
import type { Ticket, TicketListResponse } from "@/lib/client/types";
import { formatDateTime, timeAgo } from "@/lib/shared/format";

const STATUS_COLORS: Record<string, string> = {
  pending: "#eab308",
  scheduled: "#06b6d4",
  ongoing: "#f97316",
  resolved: "#22c55e",
  closed: "#22c55e",
  cancelled: "#94a3b8",
};

/**
 * "Ticket Detail" landing page.
 *
 * The sidebar entry exists so an agent can jump straight to the most recently
 * touched ticket without going through the full list. Defaults to sorting by
 * last activity, which is what "what just happened" means in practice.
 */
export default function RecentTicketsPage() {
  const [data, setData] = React.useState<TicketListResponse | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<TicketListResponse>("/api/tickets?pageSize=15&sort=newest");
      setData(response);
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
    document.title = "Ticket Detail — Help Desk";
  }, []);

  const newest = data?.tickets[0];

  return (
    <AppPage
      actions={
        <GhostButton icon={RefreshCw} onClick={() => void load()}>
          Refresh
        </GhostButton>
      }
    >
      <PageHeading
        title="Ticket Detail"
        description="Most recently created tickets. Open one to edit its fields and add remarks."
      />

      <div className="space-y-4">
        <ErrorNote error={error} />

        <Panel title="Last Touched" hint="jump straight in">
          {!loading && !newest ? (
            <EmptyState title="No tickets yet" description="Create your first ticket to see it here." />
          ) : newest ? (
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/tickets/${newest.id}`}
                    className="text-[13px] font-bold hover:underline"
                    style={{ color: "#f97316" }}
                  >
                    {newest.ticketNumber}
                  </Link>
                  <TerminalBadge
                    label={newest.priority.label || "—"}
                    color={newest.priority.color}
                    inactive={newest.priority.inactive}
                  />
                  <TerminalBadge
                    label={newest.statusLabel || newest.status}
                    color={STATUS_COLORS[newest.status] ?? "#94a3b8"}
                  />
                </div>
                <p className="mt-1 truncate text-[11px] text-foreground">{newest.subject}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {newest.requestorName || "No requestor"} · {newest.technicianName} · updated{" "}
                  {timeAgo(newest.lastActivityAt)}
                </p>
              </div>
              <Link
                href={`/tickets/${newest.id}`}
                className="flex items-center gap-1.5 rounded-md px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white"
                style={{ backgroundColor: "#f97316" }}
              >
                Open <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          ) : null}
        </Panel>

        <Panel title="Recent Tickets" hint={`${data?.total ?? 0} total`}>
          {loading ? (
            <p className="px-4 py-10 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
              Loading…
            </p>
          ) : data?.tickets.length ? (
            <ul className="divide-y divide-border">
              {data.tickets.map((ticket) => (
                <li key={ticket.id}>
                  <Link
                    href={`/tickets/${ticket.id}`}
                    className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted/50"
                  >
                    <span
                      className="w-40 shrink-0 text-[11px] font-bold"
                      style={{ color: "#f97316" }}
                    >
                      {ticket.ticketNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px]">{ticket.subject}</span>
                    <TerminalBadge
                      label={ticket.priority.label || "—"}
                      color={ticket.priority.color}
                      inactive={ticket.priority.inactive}
                    />
                    <TerminalBadge
                      label={ticket.statusLabel || ticket.status}
                      color={STATUS_COLORS[ticket.status] ?? "#94a3b8"}
                    />
                    <span className="w-32 shrink-0 text-right text-[10px] text-muted-foreground">
                      {formatDateTime(ticket.lastActivityAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No tickets yet"
              description="Tickets created here or auto-created from Gmail will show up in this list."
            />
          )}
        </Panel>
      </div>
    </AppPage>
  );
}
