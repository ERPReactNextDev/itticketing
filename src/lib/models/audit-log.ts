import { Schema, model, models, type InferSchemaType } from "mongoose";

/**
 * Immutable audit trail. There is intentionally no update or delete helper -
 * writes happen through `writeAuditLog` and nothing else touches the
 * collection.
 */
const AuditLogSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    actorName: { type: String, default: "system" },
    actorEmail: { type: String, default: "" },
    /** e.g. `ticket.create`, `user.login`, `settings.update`. */
    action: { type: String, required: true, index: true },
    entity: { type: String, required: true, index: true },
    entityId: { type: String, default: "", index: true },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });

export type AuditLogAttrs = InferSchemaType<typeof AuditLogSchema>;
export const AuditLog = models.AuditLog ?? model("AuditLog", AuditLogSchema);
export default AuditLog;