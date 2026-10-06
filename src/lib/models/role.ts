import { Schema, model, models, type InferSchemaType, type HydratedDocument } from "mongoose";
import { PERMISSION_KEYS, normalizePermissions, type PermissionSet } from "../shared/permissions";

const PermissionsSchema = new Schema(
  Object.fromEntries(PERMISSION_KEYS.map((key) => [key, { type: Boolean, default: false }])),
  { _id: false },
);

const RoleSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: "" },
    permissions: { type: PermissionsSchema, required: true },
    /** Seeded roles are protected from deletion; their name is editable. */
    isSystem: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Mongoose casts to the nested schema; re-normalize so any key added to
// PERMISSION_KEYS later materialises as `false` instead of `undefined`.
RoleSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    ret.permissions = normalizePermissions(ret.permissions);
    return ret;
  },
});

export type RoleAttrs = InferSchemaType<typeof RoleSchema>;
export type RoleDoc = HydratedDocument<RoleAttrs>;
export const Role = models.Role ?? model("Role", RoleSchema);
export default Role;

export type { PermissionSet };