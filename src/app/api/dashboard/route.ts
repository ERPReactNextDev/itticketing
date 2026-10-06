import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { Ticket, EmailMessage, User } from "@/lib/models";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { withApi } from "@/lib/server/http";
import { computeSla, slaBand } from "@/lib/server/sla";
import { CLOSED_STATUS_VALUES } from "@/lib/shared/constants";

export const dynamic = "force-dynamic";

/**
 * Dashboard aggregates.
 *
 * Previously this page pulled the entire `tickets` collection into the browser
 * and derived every chart client-side. All aggregation now happens in Mongo, so
 * the payload stays small and the numbers are correct at scale.
 */
export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "viewDashboard");

  await connectDB();
  const url = new URL(req.url);

  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));

  const baseFilter: Record<string, unknown> = {};
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    baseFilter.dateCreated = range;
  }

  // Respect the same visibility rule as the ticket list.
  const scopeFilter: Record<string, unknown> = { ...baseFilter };
  if (!user.permissions.viewAllTickets) {
    scopeFilter.$or = [{ technician: user.id }, { processedBy: user.id }];
  }

  const [
    totalTickets,
    openTickets,
    closedTickets,
    fromGmail,
    byStatus,
    byPriority,
    byTechnician,
    byDepartment,
    slaStats,
    atRisk,
    recentInbound,
  ] = await Promise.all([
    Ticket.countDocuments(scopeFilter),
    Ticket.countDocuments({ ...scopeFilter, status: { $nin: CLOSED_STATUS_VALUES } }),
    Ticket.countDocuments({ ...scopeFilter, status: { $in: CLOSED_STATUS_VALUES } }),
    Ticket.countDocuments({ ...scopeFilter, source: "email" }),

    Ticket.aggregate<{ _id: string; count: number }>([
      { $match: scopeFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    Ticket.aggregate<{ _id: string; count: number }>([
      { $match: scopeFilter },
      { $group: { _id: "$priority.label", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    Ticket.aggregate<{ _id: unknown; name?: string; count: number }>([
      { $match: scopeFilter },
      { $group: { _id: "$technician", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),

    Ticket.aggregate<{ _id: string; count: number }>([
      { $match: scopeFilter },
      { $group: { _id: "$department", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 12 },
    ]),

    // SLA health over currently-open tickets.
    Ticket.aggregate<{ breached: number; total: number; ratios: number[] }>([
      {
        $match: {
          ...scopeFilter,
          status: { $nin: CLOSED_STATUS_VALUES },
          slaDueAt: { $ne: null },
        },
      },
      {
        $project: {
          effectiveDue: {
            $add: [
              "$slaDueAt",
              { $multiply: [{ $ifNull: ["$slaPausedTotalSeconds", 0] }, 1000] },
            ],
          },
          slaHours: "$priority.slaHours",
          dateCreated: 1,
        },
      },
      {
        $project: {
          breached: { $lt: ["$effectiveDue", "$$NOW"] },
          slaHours: 1,
          dateCreated: 1,
        },
      },
      {
        $group: {
          _id: null,
          breached: { $sum: { $cond: ["$breached", 1, 0] } },
          total: { $sum: 1 },
        },
      },
    ]),

    // The tickets closest to breaching, for the alerting banner.
    Ticket.find({
      ...scopeFilter,
      status: { $nin: CLOSED_STATUS_VALUES },
      slaDueAt: { $ne: null },
    })
      .sort({ slaDueAt: 1 })
      .limit(5)
      .select("ticketNumber subject priority status slaDueAt slaPausedTotalSeconds slaPausedAt dateCreated technician")
      .populate("technician", "name")
      .lean<Array<Record<string, unknown>>>(),

    EmailMessage.countDocuments({
      direction: "in",
      processedAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
      autoCreatedTicket: true,
    }),
  ]);

  // Technician names need one extra lookup keyed by id.
  const technicianIds = byTechnician.map((row) => (row._id ? String(row._id) : "")).filter(Boolean);
  const technicians = await User.find({ _id: { $in: technicianIds } })
    .select("name")
    .lean<Array<{ _id: unknown; name?: string }>>();
  const technicianNameById = new Map(technicians.map((t) => [String(t._id), t.name ?? ""]));

  const slaRows = await Ticket.find({
    ...scopeFilter,
    status: { $nin: CLOSED_STATUS_VALUES },
    slaDueAt: { $ne: null },
  })
    .select("slaDueAt slaPausedTotalSeconds slaPausedAt priority status dateCreated")
    .lean<Array<Record<string, unknown>>>();

  let breached = 0;
  let warning = 0;
  for (const row of slaRows) {
    const state = computeSla({
      slaDueAt: row.slaDueAt as Date,
      slaPausedTotalSeconds: Number(row.slaPausedTotalSeconds ?? 0),
      slaPausedAt: row.slaPausedAt as Date,
      priority: row.priority as { slaHours?: number },
      status: String(row.status ?? ""),
      dateCreated: row.dateCreated as Date,
    });
    if (state.breached) breached += 1;
    else if (state.warning) warning += 1;
  }

  const atRiskDtos = atRisk.map((row) => {
    const state = computeSla({
      slaDueAt: row.slaDueAt as Date,
      slaPausedTotalSeconds: Number(row.slaPausedTotalSeconds ?? 0),
      slaPausedAt: row.slaPausedAt as Date,
      priority: row.priority as { slaHours?: number },
      status: String(row.status ?? ""),
      dateCreated: row.dateCreated as Date,
    });
    const technician = row.technician as { name?: string } | null;
    return {
      id: String(row._id),
      ticketNumber: String(row.ticketNumber),
      subject: String(row.subject),
      priorityLabel: String((row.priority as { label?: string })?.label ?? ""),
      priorityColor: (row.priority as { color?: string })?.color ?? "#ef4444",
      status: String(row.status),
      technicianName: technician?.name ?? "Unassigned",
      remainingSeconds: state.remainingSeconds,
      breached: state.breached,
      band: slaBand(state),
    };
  });

  // Average resolution time over closed tickets in range.
  const closedDurations = await Ticket.find({
    ...scopeFilter,
    status: { $in: CLOSED_STATUS_VALUES },
    durationSeconds: { $ne: null },
  })
    .select("durationSeconds")
    .lean<Array<{ durationSeconds?: number }>>();
  const avgResolutionSeconds = closedDurations.length
    ? Math.round(
        closedDurations.reduce((sum, row) => sum + Number(row.durationSeconds ?? 0), 0) /
          closedDurations.length,
      )
    : null;

  return NextResponse.json({
    totals: {
      all: totalTickets,
      open: openTickets,
      closed: closedTickets,
      fromGmail,
      inboundLast24h: recentInbound,
      breached,
      atRisk: warning,
      avgResolutionSeconds,
    },
    byStatus: byStatus.map((row) => ({ key: String(row._id), count: row.count })),
    byPriority: byPriority.map((row) => ({ key: String(row._id), count: row.count })),
    byTechnician: byTechnician.map((row) => ({
      name: row._id ? (technicianNameById.get(String(row._id)) ?? "Unknown") : "Unassigned",
      count: row.count,
    })),
    byDepartment: byDepartment.map((row) => ({
      key: String(row._id) || "Unassigned",
      count: row.count,
    })),
    atRiskTickets: atRiskDtos,
  });
});

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}