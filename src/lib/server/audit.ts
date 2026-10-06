import "server-only";
import { connectDB } from "../db/mongoose";
import { AuditLog } from "../models";

export type AuditInput = {
  actorId?: string | null;
  actorName?: string;
  actorEmail?: string;
  action: string;
  entity: string;
  entityId?: string | null;
  ip?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
};

/**
 * Appends an audit entry.
 *
 * Deliberately never throws: auditing must not be able to fail the operation it
 * is recording, or a Mongo hiccup would roll back a legitimate user action.
 */
export async function writeAuditLog(input: AuditInput): Promise<void> {
  try {
    await connectDB();
    await AuditLog.create({
      actor: input.actorId ?? null,
      actorName: input.actorName ?? (input.actorId ? "" : "system"),
      actorEmail: input.actorEmail ?? "",
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? "",
      ip: input.ip ?? "",
      userAgent: input.userAgent ?? "",
      meta: input.meta ?? {},
    });
  } catch (error) {
    console.error("[audit] failed to write audit log:", error);
  }
}