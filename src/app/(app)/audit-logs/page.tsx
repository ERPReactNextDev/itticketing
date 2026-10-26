"use client";

import * as React from "react";
import { AppPage } from "@/components/app-page";
import {
  PageHeading,
  Panel,
  ErrorNote,
  EmptyState,
  GhostButton,
  TerminalBadge,
} from "@/components/app-shell";
import { RefreshCw, ScrollText as ScrollTextIcon } from "lucide-react";
import { api } from "@/lib/client/api";
import type { AuditLog } from "@/lib/client/types";
import { formatDateTime } from "@/lib/shared/format";

/** Colour-coded action verbs, so the trail is scannable. */
function actionTone(action: string): string {
  if (action.includes("failed") || action.includes("blocked") || action.includes("rejected")) {
    return "#ef4444";
  }
  if (action.includes("delete") || action.includes("suspend")) return "#b91c1c";
  if (action.includes("create")) return "#22c55e";
  if (action.includes("update") || action.includes("toggle") || action.includes("reorder")) {
    return "#f97316";
  }
  if (action.includes("login") || action.includes("logout")) return "#06b6d4";
  return "#8b5cf6";
}

export default function AuditLogsPage() {
  const [logs, setLogs] = React.useState<AuditLog[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      params.set("page", String(page));
      params.set("pageSize", "50");
      const response = await api.get<{
        logs: AuditLog[];
        total: number;
        totalPages: number;
      }>(`/api/audit-logs?${params}`);
      setLogs(response.logs);
      setTotal(response.total);
      setTotalPages(response.totalPages);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  React.useEffect(() => {
    document.title = "Audit Logs — Help Desk";
  }, []);

  function toggleMeta(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <AppPage
      search={{ value: search, onChange: setSearch, placeholder: "Search actor, action, entity, IP" }}
      actions={
        <GhostButton icon={RefreshCw} onClick={() => void load()}>
          Refresh
        </GhostButton>
      }
    >
      <PageHeading
        title="Audit Logs"
        badge={<TerminalBadge label="Immutable" color="#8b5cf6" />}
        description="Every privileged action, written once and never modified. Useful for tracing who changed what, and when."
      />

      <div className="space-y-4">
        <ErrorNote error={error} />

        <Panel title="Activity" hint={`${total} entr${total === 1 ? "y" : "ies"}`}>
          {loading ? (
            <p className="px-4 py-10 text-center text-[11px] uppercase tracking-wider text-muted-foreground">
              Loading…
            </p>
          ) : logs.length === 0 ? (
            <EmptyState title="No audit entries" description="Actions will appear here as they happen." icon={ScrollTextIcon} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left">
                <thead>
                  <tr className="border-b border-border">
                    <Th>When</Th>
                    <Th>Actor</Th>
                    <Th>Action</Th>
                    <Th>Entity</Th>
                    <Th>IP</Th>
                    <Th>Detail</Th>
                  </tr>
                </thead>
                <tbody>
                {logs.map((log) => (
                    <React.Fragment key={log.id}>
                      <tr className="border-b border-border/60 hover:bg-muted/40">
                        <td className="whitespace-nowrap px-3 py-2.5 text-[10px] text-muted-foreground">
                          {formatDateTime(log.createdAt)}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="block text-[11px] font-medium">{log.actorName}</span>
                          {log.actorEmail ? (
                            <span className="block text-[9px] text-muted-foreground">{log.actorEmail}</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <TerminalBadge label={log.action} color={actionTone(log.action)} />
                        </td>
                        <td className="px-3 py-2.5 text-[11px] text-muted-foreground">
                          {log.entity}
                          {log.entityId ? (
                            <span className="ml-1.5 font-mono text-[9px] opacity-70">
                              {log.entityId.slice(-8)}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[10px] text-muted-foreground">
                          {log.ip || "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          <button
                            type="button"
                            onClick={() => toggleMeta(log.id)}
                            disabled={!Object.keys(log.meta ?? {}).length}
                            className="rounded border border-border px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground hover:bg-muted disabled:opacity-30"
                          >
                            {expanded.has(log.id) ? "Hide" : "View"}
                          </button>
                        </td>
                      </tr>
                      {expanded.has(log.id) && Object.keys(log.meta ?? {}).length ? (
                        <tr key={`${log.id}-meta`} className="border-b border-border/60 bg-muted/30">
                          <td colSpan={6} className="px-3 py-2.5">
                            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-foreground">
                              {JSON.stringify(log.meta, null, 2)}
                            </pre>
                            {log.userAgent ? (
                              <p className="mt-1.5 break-all text-[9px] text-muted-foreground">
                                {log.userAgent}
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
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
