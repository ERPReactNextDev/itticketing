import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { asRecord, composeUserName, num, str } from "@/lib/db/mappers";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { withApi } from "@/lib/server/http";
import { computeSla, slaBand } from "@/lib/server/sla";
import { CLOSED_STATUS_VALUES } from "@/lib/shared/constants";

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

/** Columns the aggregates need. Deliberately narrow - no remarks, no snapshots. */
const TICKET_COLUMNS = [
  "id",
  "ticket_id",
  "ticket_subject",
  "status",
  "priority",
  "priority_data",
  "department",
  "requestor_name",
  "processed_by",
  "processed_by_id",
  "technician_id",
  "technician_name",
  "source",
  "sla_due_at",
  "sla_paused_total_seconds",
  "sla_paused_at",
  "date_created",
  "duration_seconds",
].join(", ");

/** Rows per round trip while paging through the selected range. */
const ROW_PAGE_SIZE = 1000;

/**
 * Dashboard aggregates.
 *
 * PostgREST has no `$group`, so the scoped tickets are read once with a narrow
 * projection and every breakdown is derived in JS. That keeps the payload small
 * (the numbers stay correct at scale) without a round trip per chart.
 */
export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "viewDashboard");

  const supabase = await connectDB();
  const url = new URL(req.url);

  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));

  // PostgREST caps a single response, so a wide range is paged in rather than
  // silently truncated - the aggregates must cover every ticket in the range.
  const rows: Row[] = [];
  for (let offset = 0; ; offset += ROW_PAGE_SIZE) {
    let query = supabase.from("tickets").select(TICKET_COLUMNS);
    if (from) query = query.gte("date_created", from.toISOString());
    if (to) query = query.lte("date_created", to.toISOString());

    // Respect the same visibility rule as the ticket list.
    if (!user.permissions.viewAllTickets) {
      query = query.or(`technician_id.eq.${user.id},processed_by_id.eq.${user.id}`);
    }

    const { data, error } = await query
      .order("id")
      .range(offset, offset + ROW_PAGE_SIZE - 1);
    if (error) throw new DatabaseError(error);

    const batch = (data ?? []) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < ROW_PAGE_SIZE) break;
  }

  // The client is untyped, so PostgREST rows arrive with an opaque shape.
  const isClosed = (row: Row) => CLOSED_STATUS_VALUES.includes(str(row.status).toLowerCase());

  const openRows = rows.filter((row) => !isClosed(row));
  const closedRows = rows.filter(isClosed);

  const byStatusMap = new Map<string, number>();
  const byPriorityMap = new Map<string, number>();
  const byTechnicianMap = new Map<string, number>();
  const byDepartmentMap = new Map<string, number>();
  const byRequestorMap = new Map<string, number>();

  for (const row of rows) {
    bump(byStatusMap, str(row.status));
    bump(byPriorityMap, str(asRecord(row.priority_data).label) || str(row.priority));
    // Use the linked ID if available, otherwise fallback to name snapshots.
    // We check both technician and processed-by fields to ensure tickets
    // migrated from other systems or auto-assigned are counted.
    const techKey =
      row.technician_id ? String(row.technician_id) :
      str(row.technician_name) ||
      (row.processed_by_id ? String(row.processed_by_id) : str(row.processed_by));
    bump(byTechnicianMap, techKey);
    bump(byDepartmentMap, str(row.department));
    // `requestor_name` is the snapshot taken when the ticket was filed.
    bump(byRequestorMap, str(row.requestor_name));
  }

  // SLA health + the tickets closest to breaching, over currently-open tickets.
  const slaRows = openRows.filter((row) => row.sla_due_at !== null && row.sla_due_at !== undefined);

  let breached = 0;
  let warning = 0;
  for (const row of slaRows) {
    const state = slaState(row);
    if (state.breached) breached += 1;
    else if (state.warning) warning += 1;
  }

  const atRiskRows = [...slaRows]
    .sort((a, b) => new Date(str(a.sla_due_at)).getTime() - new Date(str(b.sla_due_at)).getTime())
    .slice(0, 5);

  const topTechnicians = topEntries(byTechnicianMap, 10);
  const technicianNameById = await resolveTechnicianNames([
    ...topTechnicians.map(([id]) => id),
    ...atRiskRows.map((row) => (row.technician_id ? String(row.technician_id) : "")),
  ]);

  const atRiskTickets = atRiskRows.map((row) => {
    const state = slaState(row);
    const priority = asRecord(row.priority_data);
    return {
      id: str(row.id),
      ticketNumber: str(row.ticket_id),
      subject: str(row.ticket_subject),
      priorityLabel: str(priority.label),
      priorityColor: str(priority.color) || "#ef4444",
      status: str(row.status),
      technicianName:
        technicianNameById.get(row.technician_id ? String(row.technician_id) : "") ||
        str(row.technician_name) ||
        "Unassigned",
      remainingSeconds: state.remainingSeconds,
      breached: state.breached,
      band: slaBand(state),
    };
  });

  // Average resolution time over closed tickets in range.
  const durations = closedRows
    .map((row) => row.duration_seconds)
    .filter((value) => value !== null && value !== undefined)
    .map((value) => num(value, 0));
  const avgResolutionSeconds = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : null;

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: inboundLast24h } = await supabase
    .from("email_messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "in")
    .eq("auto_created_ticket", true)
    .gte("processed_at", since);

  return NextResponse.json({
    totals: {
      all: rows.length,
      open: openRows.length,
      closed: closedRows.length,
      fromGmail: rows.filter((row) => str(row.source) === "email").length,
      inboundLast24h: inboundLast24h ?? 0,
      breached,
      atRisk: warning,
      avgResolutionSeconds,
    },
    byStatus: topEntries(byStatusMap, 0).map(([key, count]) => ({ key, count })),
    byPriority: topEntries(byPriorityMap, 0).map(([key, count]) => ({ key, count })),
    byTechnician: topTechnicians.map(([id, count]) => ({
      name: id
        ? technicianNameById.get(id) ?? (Number.isNaN(Number(id)) ? id : "Unknown")
        : "Unassigned",
      count,
    })),
    byDepartment: topEntries(byDepartmentMap, 12).map(([key, count]) => ({
      key: key || "Unassigned",
      count,
    })),
    byRequestor: topEntries(byRequestorMap, 12).map(([key, count]) => ({
      name: key || "Unknown requestor",
      count,
    })),
    atRiskTickets,
  });
});

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Sorted `[key, count]` pairs, highest count first. `limit = 0` means no cap. */
function topEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  return limit > 0 ? entries.slice(0, limit) : entries;
}

function slaState(row: Row) {
  return computeSla({
    slaDueAt: row.sla_due_at as string | null,
    slaPausedTotalSeconds: num(row.sla_paused_total_seconds, 0),
    slaPausedAt: row.sla_paused_at as string | null,
    priority: { slaHours: num(asRecord(row.priority_data).slaHours, 0) },
    status: str(row.status),
    dateCreated: row.date_created as string | null,
  });
}

/** Resolves technician ids to display names in one extra query. */
async function resolveTechnicianNames(ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
    .map(Number)
    .filter(Number.isFinite);
  const map = new Map<string, string>();
  if (unique.length === 0) return map;

  const supabase = await connectDB();
  const { data } = await supabase
    .from("users")
    .select("id, Firstname, Lastname")
    .in("id", unique);

  for (const row of (data ?? []) as Row[]) {
    map.set(String(row.id), composeUserName(row));
  }
  return map;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
