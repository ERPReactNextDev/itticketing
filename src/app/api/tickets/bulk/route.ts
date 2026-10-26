import { NextResponse } from "next/server";
import { connectDB, unwrap } from "@/lib/db/supabase";
import { composeUserName, normalizeUserStatus } from "@/lib/db/mappers";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { patchTicket } from "@/lib/server/tickets";
import { roleIdsWithPermission } from "@/lib/server/actor";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson } from "@/lib/server/http";
import { deleteFile } from "@/lib/server/storage";

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

  const numericIds = ids.map(Number).filter((value) => Number.isFinite(value));
  const supabase = await connectDB();

  if (body.action === "delete") {
    requirePermission(user, "deleteTicket");

    // Attachment ids are read *before* the delete so their stored objects can be
    // cleaned up; the delete itself only returns the ticket rows.
    const { data: rows } = await supabase
      .from("tickets")
      .select("id, attachments")
      .in("id", numericIds);
    const attachmentIds = (rows ?? []).flatMap((row) =>
      (Array.isArray(row.attachments) ? row.attachments : []).map(String),
    );

    const deleted = unwrap(
      await supabase.from("tickets").delete().in("id", numericIds).select("id"),
    );
    for (const fileId of attachmentIds) {
      await deleteFile(fileId);
    }

    await writeAuditLog({
      actorId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      action: "ticket.bulk.delete",
      entity: "Ticket",
      ip: clientIp(req),
      userAgent: userAgent(req),
      meta: { count: deleted.length },
    });
    return NextResponse.json({ ok: true, updated: deleted.length });
  }

  // Check the permission once, before the loop: an action the caller is not
  // allowed to perform must fail the whole request, not silently skip tickets.
  if (body.action === "assign") {
    requirePermission(user, "assignTechnician");
  } else if (body.action === "status") {
    if (!body.status) {
      return NextResponse.json(
        { error: "bad_request", message: "A status value is required." },
        { status: 400 },
      );
    }
    // Closing needs closeTicket; other transitions need changeStatus.
    requirePermission(user, isClosingStatus(body.status) ? "closeTicket" : "changeStatus");
  }

  const { data: rows } = await supabase.from("tickets").select("id").in("id", numericIds);

  let updated = 0;
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const row of rows ?? []) {
    const ticketId = String(row.id);
    try {
      if (body.action === "assign") {
        await patchTicket({ id: ticketId }, { technician: body.technicianId ?? null }, user, {
          allowed: new Set(["technician"]),
        });
      } else {
        await patchTicket({ id: ticketId }, { status: body.status }, user, {
          allowed: new Set(["status"]),
        });
      }
      updated += 1;
    } catch (error) {
      skipped.push({
        id: ticketId,
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

  const roleIds = await roleIdsWithPermission("assignTechnician");
  if (roleIds.length === 0) {
    return NextResponse.json({ technicians: [] });
  }

  const supabase = await connectDB();
  const { data } = await supabase
    .from("users")
    .select("id, Firstname, Lastname, Email, Department, Status")
    .in("role_id", roleIds.map(Number));

  const technicians = (data ?? [])
    // The legacy `Status` column is free-form, so the active check runs through
    // the same normaliser the rest of the app uses.
    .filter((row) => normalizeUserStatus(row.Status) === "active")
    .map((row) => ({
      id: String(row.id),
      name: composeUserName(row),
      email: String(row.Email ?? ""),
      department: String(row.Department ?? ""),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ technicians });
});
