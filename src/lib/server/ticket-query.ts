import "server-only";
import { getSupabase } from "../db/supabase";
import { composeUserName, mapTicketRow, type NameMap } from "../db/mappers";
import { CLOSED_STATUS_VALUES } from "../shared/constants";
import type { AuthUser } from "../auth/session";
import type { TicketDTO } from "./serialize";

export type TicketListQuery = {
  search?: string;
  status?: string[];
  priority?: string[];
  department?: string[];
  technician?: string[];
  requestType?: string[];
  site?: string[];
  source?: string[];
  /** true = only unresolved tickets. */
  openOnly?: boolean;
  /** true = only breached tickets. */
  breachedOnly?: boolean;
  /** Restricts to a single technician or the signed-in user. */
  assignedTo?: string;
  from?: Date | null;
  to?: Date | null;
  sort?: "newest" | "oldest" | "sla" | "priority";
  page: number;
  pageSize: number;
};

/**
 * Statuses that mean "finished", plus the US spelling legacy rows sometimes use.
 * Kept lowercase because that is how statuses are stored throughout the app.
 */
const CLOSED_STATUSES = Array.from(
  new Set([...CLOSED_STATUS_VALUES, "canceled"].map((s) => s.toLowerCase())),
);

/** Columns the list/export need. `remarks_json` is deliberately excluded. */
const TICKET_COLUMNS = [
  "id",
  "ticket_id",
  "pattern_version",
  "ticket_subject",
  "description",
  "requestor_id",
  "requestor_snapshot",
  "requestor_name",
  "department",
  "request_type",
  "type_concern",
  "mode",
  "group_services",
  "site",
  "priority",
  "priority_data",
  "status",
  "processed_by",
  "processed_by_id",
  "technician_name",
  "technician_id",
  "closed_by",
  "closed_by_id",
  "reopened_by_id",
  "date_scheduled",
  "date_created",
  "date_closed",
  "date_reopened",
  "support_start_time",
  "support_end_time",
  "sla_due_at",
  "sla_paused_total_seconds",
  "sla_paused_at",
  "duration_seconds",
  "attachments",
  "source",
  "email_thread_id",
  "email_message_ids",
  "status_history",
  "assignment_history",
  "last_activity_at",
].join(", ");

/** Strips PostgREST structural characters out of a free-text search term. */
function searchTerm(raw: string): string {
  return raw.replace(/[,()*"\\%]/g, " ").trim();
}

/**
 * Builds the PostgREST query for a ticket list request.
 *
 * The RBAC scope is applied here and nowhere else, so it is impossible for a
 * route to forget it: agents without `viewAllTickets` can only ever match
 * tickets assigned to or processed by them. Both the list and the CSV export
 * call this, which is what keeps the two from diverging.
 */
export function ticketQueryBuilder(
  query: TicketListQuery,
  user: AuthUser,
  opts: { includeRemarks?: boolean; count?: boolean } = {},
) {
  // `getSupabase` (not the async `connectDB`) so this stays a plain builder:
  // returning a thenable from an async function makes `await` run the query and
  // hand back the response instead of the builder.
  const supabase = getSupabase();
  const columns = opts.includeRemarks ? `${TICKET_COLUMNS}, remarks_json` : TICKET_COLUMNS;

  // The count option is only passed when the caller needs a total, so the two
  // cases are spelled out: a conditional argument breaks the SDK's overloads.
  const table = supabase.from("tickets");
  let q = opts.count
    ? table.select(columns, { count: "exact" })
    : table.select(columns);

  if (!user.permissions.viewAllTickets) {
    q = q.or(`technician_id.eq.${user.id},processed_by_id.eq.${user.id}`);
  }

  const term = searchTerm(query.search ?? "");
  if (term) {
    const like = `%${term}%`;
    q = q.or(
      [
        `ticket_id.ilike.${like}`,
        `ticket_subject.ilike.${like}`,
        `description.ilike.${like}`,
        `requestor_snapshot->>fullName.ilike.${like}`,
        `requestor_snapshot->>employeeId.ilike.${like}`,
        `requestor_snapshot->>email.ilike.${like}`,
      ].join(","),
    );
  }

  if (query.status?.length) q = q.in("status", query.status);
  if (query.priority?.length) q = q.in("priority_data->>value", query.priority);
  if (query.department?.length) q = q.in("department", query.department);
  if (query.requestType?.length) q = q.in("request_type", query.requestType);
  if (query.site?.length) q = q.in("site", query.site);
  if (query.source?.length) q = q.in("source", query.source);
  if (query.technician?.length) q = q.in("technician_id", query.technician);

  if (query.openOnly || query.breachedOnly) {
    q = q.not("status", "in", `(${CLOSED_STATUSES.join(",")})`);
  }

  if (query.breachedOnly) {
    q = q
      .not("sla_due_at", "is", null)
      .lt("sla_effective_due_at", new Date().toISOString());
  }

  if (query.assignedTo) q = q.eq("technician_id", query.assignedTo);

  if (query.from) q = q.gte("date_created", query.from.toISOString());
  if (query.to) q = q.lte("date_created", query.to.toISOString());

  switch (query.sort) {
    case "oldest":
      q = q.order("date_created", { ascending: true });
      break;
    case "sla":
      q = q.order("sla_due_at", { ascending: true, nullsFirst: false });
      break;
    case "priority":
      q = q
        .order("priority_sla_hours", { ascending: true, nullsFirst: false })
        .order("date_created", { ascending: false });
      break;
    case "newest":
    default:
      q = q.order("date_created", { ascending: false });
      break;
  }

  return q;
}

/** Resolves user ids to display names so DTOs never show a raw id. */
export async function buildNameMap(ids: Array<string | null>): Promise<NameMap> {
  const unique = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  const map: NameMap = new Map();
  if (unique.length === 0) return map;

  const supabase = getSupabase();
  const { data } = await supabase
    .from("users")
    .select("id, Firstname, Lastname")
    .in("id", unique.map(Number).filter(Number.isFinite));

  for (const row of data ?? []) {
    map.set(String(row.id), composeUserName(row as Record<string, unknown>));
  }
  return map;
}

/** Status/priority display labels, keyed `type:value`, in one extra query. */
async function buildLabelMap(): Promise<Map<string, { label: string; active: boolean }>> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("dropdown_options")
    .select("type, value, label, active")
    .in("type", ["status", "priority"]);

  const options = (data ?? []) as Array<{
    type: string;
    value: string;
    label: string | null;
    active: boolean | null;
  }>;

  return new Map(
    options.map((option) => [
      `${option.type}:${option.value}`,
      { label: String(option.label ?? ""), active: option.active === true },
    ]),
  );
}

export async function queryTickets(
  query: TicketListQuery,
  user: AuthUser,
  opts: { includeRemarks?: boolean } = {},
): Promise<{ tickets: TicketDTO[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  // No `await`: the builder is a thenable, so awaiting it here would run the
  // query immediately and drop the pagination below.
  const builder = ticketQueryBuilder(query, user, {
    includeRemarks: opts.includeRemarks,
    count: true,
  });
  const { data, count } = await builder.range(from, to);
  // The client is untyped, so PostgREST rows arrive with an opaque shape.
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

  const [names, labelByValue] = await Promise.all([
    buildNameMap(
      rows.flatMap((row) => [
        row.processed_by_id ? String(row.processed_by_id) : null,
        row.technician_id ? String(row.technician_id) : null,
        row.closed_by_id ? String(row.closed_by_id) : null,
      ]),
    ),
    buildLabelMap(),
  ]);

  const { toTicketDTO } = await import("./serialize");

  const tickets = rows.map((row) => {
    const enriched = mapTicketRow(row, names);
    const statusValue = String(row.status ?? "");
    enriched.statusLabel = labelByValue.get(`status:${statusValue}`)?.label ?? statusValue;

    const priority = { ...((enriched.priority ?? {}) as Record<string, unknown>) };
    const priorityMeta = labelByValue.get(`priority:${String(priority.value ?? "")}`);
    if (priorityMeta?.active === false) priority.inactive = true;
    enriched.priority = priority;

    const dto = toTicketDTO(enriched);
    if (!opts.includeRemarks) dto.remarks = [];
    return dto;
  });

  const total = count ?? tickets.length;

  return {
    tickets,
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Loads a single ticket with its user refs resolved. */
export async function loadTicketDTO(id: string, user: AuthUser): Promise<TicketDTO | null> {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;

  const supabase = getSupabase();
  const { data: row } = await supabase
    .from("tickets")
    .select("*")
    .eq("id", numericId)
    .maybeSingle<Record<string, unknown>>();

  if (!row) return null;

  // Same authorisation rule as the list: scope applies to direct access too.
  if (!user.permissions.viewAllTickets) {
    const technician = row.technician_id ? String(row.technician_id) : "";
    const processedBy = row.processed_by_id ? String(row.processed_by_id) : "";
    if (technician !== user.id && processedBy !== user.id) return null;
  }

  const [names, labelByValue] = await Promise.all([
    buildNameMap([
      row.processed_by_id ? String(row.processed_by_id) : null,
      row.technician_id ? String(row.technician_id) : null,
      row.closed_by_id ? String(row.closed_by_id) : null,
    ]),
    buildLabelMap(),
  ]);

  const enriched = mapTicketRow(row, names);
  const statusValue = String(row.status ?? "");
  enriched.statusLabel = labelByValue.get(`status:${statusValue}`)?.label ?? statusValue;

  const { toTicketDTO } = await import("./serialize");
  return toTicketDTO(enriched);
}
