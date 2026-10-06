import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { Ticket, User } from "@/lib/models";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { patchTicket } from "@/lib/server/tickets";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type BulkBody = {
  ids: string[];
  action: "assign" | "status" | "delete";
  technicianId?: string | null;
  status?: string;
};

/**
 * Bulk assign / bulk status / bulk delete.
 *
 * Each ticket goes through `patchTicket` individually rather than a single
 * `updateMany`, so every ticket still gets its own remark, status history entry
 * and assignment history entry. A bulk action must never be invisible in the
 * timeline.
 */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<BulkBody>(req);
  const ids = (body.ids ?? []).filter(Boolean);

  if (ids.length === 0) {
    return NextResponse.json(
      { error: "bad_request", message: "Select at least one ticket." },
      { status: 400 },
    );
  }
  if (ids.length > 200) {
    return NextResponse.json(
      { error: "bad_request", message: "You can bulk-update at most 200 tickets at a time." },
      { status: 400 },
    );
  }

  await connectDB();

  if (body.action === "delete") {
    requirePermission(user, "deleteTicket");
    const result = await Ticket.deleteMany({ _id: { $in: ids } });
    await writeAuditLog({
      actorId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      action: "ticket.bulk.delete",
      entity: "Ticket",
      ip: clientIp(req),
      userAgent: userAgent(req),
      meta: { count: result.deletedCount },
    });
    return NextResponse.json({ ok: true, updated: result.deletedCount ?? 0 });
  }

  const tickets = await Ticket.find({ _id: { $in: ids } });
  let updated = 0;
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const ticket of tickets) {
    try {
      if (body.action === "assign") {
        requirePermission(user, "assignTechnician");
        await patchTicket(ticket, { technician: body.technicianId ?? null }, user, {
          allowed: new Set(["technician"]),
        });
        updated += 1;
      } else if (body.action === "status") {
        if (!body.status) {
          return NextResponse.json(
            { error: "bad_request", message: "A status value is required." },
            { status: 400 },
          );
        }
        // Closing needs closeTicket; other transitions need changeStatus.
        const permission = isClosingStatus(body.status) ? "closeTicket" : "changeStatus";
        requirePermission(user, permission);
        await patchTicket(ticket, { status: body.status }, user, { allowed: new Set(["status"]) });
        updated += 1;
      }
    } catch (error) {
      skipped.push({
        id: String(ticket._id),
        reason: error instanceof Error ? error.message : "Update failed.",
      });
    }
  }

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: `ticket.bulk.${body.action}`,
    entity: "Ticket",
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { updated, skipped: skipped.length, status: body.status, technicianId: body.technicianId },
  });

  return NextResponse.json({ ok: true, updated, skipped });
});

function isClosingStatus(status: string): boolean {
  return ["resolved", "closed", "cancelled"].includes(status.toLowerCase());
}

/** Technicians available for the bulk-assign picker. */
export const GET = withApi(async () => {
  const user = await requireUser();
  if (!user.permissions.assignTechnician) {
    return NextResponse.json({ technicians: [] });
  }
  const { roleIdsWithPermission } = await import("@/lib/server/actor");
  const roleIds = await roleIdsWithPermission("assignTechnician");
  const technicians = await User.find({ status: "active", role: { $in: roleIds } })
    .select("name email department")
    .sort({ name: 1 })
    .lean<Array<{ _id: unknown; name?: string; email?: string; department?: string }>>();

  return NextResponse.json({
    technicians: technicians.map((tech) => ({
      id: String(tech._id),
      name: tech.name ?? "",
      email: tech.email ?? "",
      department: tech.department ?? "",
    })),
  });
});