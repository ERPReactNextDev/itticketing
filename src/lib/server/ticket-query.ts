import "server-only";
import { connectDB } from "../db/mongoose";
import { Ticket, DropdownOption } from "../models";
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
 * Builds the Mongo filter for a ticket list request.
 *
 * The RBAC scope is applied here and nowhere else, so it is impossible for a
 * route to forget it: agents without `viewAllTickets` can only ever match
 * tickets assigned to or processed by them.
 */
export function buildTicketFilter(query: TicketListQuery, user: AuthUser): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];

  if (!user.permissions.viewAllTickets) {
    and.push({
      $or: [{ technician: user.id }, { processedBy: user.id }],
    });
  }

  if (query.search) {
    const term = query.search.trim();
    // Regex-escape so a user typing `(` cannot break the query.
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    and.push({
      $or: [
        { ticketNumber: rx },
        { subject: rx },
        { description: rx },
        { "requestorSnapshot.fullName": rx },
        { "requestorSnapshot.employeeId": rx },
        { "requestorSnapshot.email": rx },
      ],
    });
  }

  const inFilter = (values: string[] | undefined, field: string) => {
    if (values?.length) and.push({ [field]: { $in: values } });
  };

  inFilter(query.status, "status");
  inFilter(query.priority, "priority.value");
  inFilter(query.department, "department");
  inFilter(query.requestType, "requestType");
  inFilter(query.site, "site");
  inFilter(query.source, "source");
  inFilter(query.technician, "technician");

  if (query.openOnly) {
    and.push({ status: { $nin: CLOSED_STATUS_VALUES } });
  }

  if (query.breachedOnly) {
    and.push({ slaDueAt: { $ne: null }, status: { $nin: CLOSED_STATUS_VALUES } });
    and.push({
      $expr: {
        $lt: [
          { $add: ["$slaDueAt", { $multiply: [{ $ifNull: ["$slaPausedTotalSeconds", 0] }, 1000] }] },
          "$$NOW",
        ],
      },
    });
  }

  if (query.assignedTo) {
    and.push({ technician: query.assignedTo });
  }

  if (query.from || query.to) {
    const range: Record<string, Date> = {};
    if (query.from) range.$gte = query.from;
    if (query.to) range.$lte = query.to;
    and.push({ dateCreated: range });
  }

  if (and.length === 0) return {};
  return and.length === 1 ? and[0] : { $and: and };
}

export function buildTicketSort(
  sort: TicketListQuery["sort"],
): Record<string, 1 | -1> {
  switch (sort) {
    case "oldest":
      return { dateCreated: 1 };
    case "sla":
      return { slaDueAt: 1 };
    case "priority":
      return { "priority.slaHours": 1, dateCreated: -1 };
    case "newest":
    default:
      return { dateCreated: -1 };
  }
}

/** Field list that populates the referenced users for the UI labels. */
const LIST_POPULATE = [
  { path: "processedBy", select: "name email" },
  { path: "technician", select: "name email" },
  { path: "closedBy", select: "name email" },
];

export async function queryTickets(
  query: TicketListQuery,
  user: AuthUser,
  opts: { includeRemarks?: boolean } = {},
): Promise<{ tickets: TicketDTO[]; total: number; page: number; pageSize: number; totalPages: number }> {
  await connectDB();
  const TicketModel = Ticket;
  const filter = buildTicketFilter(query, user);

  const [docs, total] = await Promise.all([
    TicketModel.find(filter)
      .sort(buildTicketSort(query.sort))
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .populate(LIST_POPULATE)
      .lean<Record<string, unknown>[]>(),
    TicketModel.countDocuments(filter),
  ]);

  // Resolve status/priority display labels in one extra query rather than
  // embedding a lookup per row.
  const optionDocs = await DropdownOption.find({
    type: { $in: ["status", "priority"] },
  }).lean<Array<{ type: string; value: string; label: string; active: boolean }>>();

  const labelByValue = new Map(
    optionDocs.map((option) => [`${option.type}:${option.value}`, { label: option.label, active: option.active }]),
  );

  const { toTicketDTO } = await import("./serialize");

  const tickets = docs.map((doc) => {
    const enriched = { ...doc } as Record<string, unknown>;
    const statusValue = String(doc.status ?? "");
    const statusMeta = labelByValue.get(`status:${statusValue}`);
    enriched.statusLabel = statusMeta?.label ?? statusValue;
    const priority = { ...((doc.priority ?? {}) as Record<string, unknown>) };
    const priorityMeta = labelByValue.get(`priority:${String(priority.value ?? "")}`);
    if (priorityMeta && priorityMeta.active === false) priority.inactive = true;
    enriched.priority = priority;
    const dto = toTicketDTO(enriched);
    if (!opts.includeRemarks) dto.remarks = [];
    return dto;
  });

  return {
    tickets,
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Loads a single ticket with its user refs populated. */
export async function loadTicketDTO(
  id: string,
  user: AuthUser,
): Promise<TicketDTO | null> {
  await connectDB();
  const doc = await Ticket.findById(id)
    .populate(LIST_POPULATE)
    .lean<Record<string, unknown>>();
  if (!doc) return null;

  // Same authorisation rule as the list: scope applies to direct access too.
  if (!user.permissions.viewAllTickets) {
    const technician = doc.technician ? String(doc.technician) : "";
    const processedBy = doc.processedBy ? String(doc.processedBy) : "";
    if (technician !== user.id && processedBy !== user.id) return null;
  }

  const optionDocs = await DropdownOption.find({
    type: { $in: ["status", "priority"] },
  }).lean<Array<{ type: string; value: string; label: string }>>();
  const labelByValue = new Map(
    optionDocs.map((option) => [`${option.type}:${option.value}`, option.label]),
  );

  const enriched = { ...doc } as Record<string, unknown>;
  const statusValue = String(doc.status ?? "");
  enriched.statusLabel = labelByValue.get(`status:${statusValue}`) ?? statusValue;

  const { toTicketDTO } = await import("./serialize");
  return toTicketDTO(enriched);
}