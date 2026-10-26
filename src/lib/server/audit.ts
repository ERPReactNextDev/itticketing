import "server-only";
import { connectDB } from "../db/supabase";

export type AuditInput = {
  actorId?: string | null;
  /** Display name captured at write time, so the trail stays readable. */
  actorName?: string | null;
  actorEmail?: string | null;
  action: string;
  /** Domain object the action touched, e.g. "User", "Ticket". */
  entity?: string | null;
  entityId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown> | null;
};

/**
 * Writes to `system_audit_logs`.
 *
 * This is fire-and-forget: we don't await it in the main request flow so audit
 * logging never slows down the UI or blocks a response, even if the store is
 * slow.
 */
export function writeAuditLog(input: AuditInput): void {
  // We don't await this promise.
  (async () => {
    try {
      const supabase = await connectDB();
      const { error } = await supabase.from("system_audit_logs").insert({
        actor_id: input.actorId ?? null,
        // The column is NOT NULL with a "system" default, but an explicit
        // blank would defeat it, so fall back here.
        actor_name: input.actorName?.trim() || "system",
        actor_email: input.actorEmail ?? "",
        action: input.action,
        entity: input.entity ?? "",
        entity_id: input.entityId ?? "",
        ip: input.ip ?? "",
        user_agent: input.userAgent ?? "",
        meta: input.meta ?? {},
      });
      if (error) throw error;
    } catch (error) {
      console.error("[audit] failed to write audit log:", error);
    }
  })();
}
