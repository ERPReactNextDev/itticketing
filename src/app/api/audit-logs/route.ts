import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { AuditLog, User } from "@/lib/models";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { withApi, intParam, csvParam } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Lean = Record<string, unknown>;

/** Super Admin (and Admin) only. Read-only by design - the log is immutable. */
export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "viewAuditLogs");

  await connectDB();
  const url = new URL(req.url);

  const search = (url.searchParams.get("search") ?? "").trim();
  const actions = csvParam(url.searchParams.get("action"));
  const entities = csvParam(url.searchParams.get("entity"));
  const actorIds = csvParam(url.searchParams.get("actorId"));

  const filter: Record<string, unknown> = {};
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(safe, "i");
    filter.$or = [
      { actorName: rx },
      { actorEmail: rx },
      { action: rx },
      { entity: rx },
      { entityId: rx },
    ];
  }
  if (actions.length) filter.action = { $in: actions };
  if (entities.length) filter.entity = { $in: entities };
  if (actorIds.length) filter.actor = { $in: actorIds };

  const page = intParam(url.searchParams.get("page"), 1, { min: 1 });
  const pageSize = intParam(url.searchParams.get("pageSize"), 50, { min: 1, max: 200 });

  const [rows, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<Lean[]>(),
    AuditLog.countDocuments(filter),
  ]);

  const actorIdsToResolve = rows
    .map((row) => (row.actor ? String(row.actor) : ""))
    .filter(Boolean);
  const actors = await User.find({ _id: { $in: actorIdsToResolve } })
    .select("name email")
    .lean<Array<{ _id: unknown; name?: string; email?: string }>>();
  const actorById = new Map(actors.map((a) => [String(a._id), a]));

  return NextResponse.json({
    logs: rows.map((row) => {
      const actorRef = row.actor ? String(row.actor) : "";
      const actor = actorById.get(actorRef);
      return {
        id: String(row._id),
        actorId: actorRef || null,
        actorName: String(row.actorName || actor?.name || "system"),
        actorEmail: String(row.actorEmail || actor?.email || ""),
        action: String(row.action ?? ""),
        entity: String(row.entity ?? ""),
        entityId: String(row.entityId ?? ""),
        ip: String(row.ip ?? ""),
        userAgent: String(row.userAgent ?? ""),
        meta: (row.meta ?? {}) as Record<string, unknown>,
        createdAt: String(row.createdAt ?? ""),
      };
    }),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});