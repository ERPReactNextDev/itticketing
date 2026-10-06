import { Schema, model, models, type InferSchemaType, type HydratedDocument } from "mongoose";
import { PERMISSION_KEYS } from "../shared/permissions";

/**
 * Login accounts only (agents, supervisors, admins).
 * The employee/end-user directory lives in `requestors`.
 */
const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    employeeId: { type: String, trim: true, default: "" },

    passwordHash: { type: String, required: true, select: false },
    /** Forces a password change on first login (seeded + reset accounts). */
    mustChangePassword: { type: Boolean, default: false },

    role: { type: Schema.Types.ObjectId, ref: "Role", required: true, index: true },
    department: { type: String, trim: true, default: "" },
    site: { type: String, trim: true, default: "" },
    position: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },

    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
      index: true,
    },
    avatarUrl: { type: String, default: "" },

    // Login throttling - mirrors the Mongo rate-limit collection so the
    // account survives an IP change and the limiter survives a restart.
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },

    lastLoginAt: { type: Date, default: null },

    /** Ids mapped over from the legacy Supabase user during migration. */
    legacyUserId: { type: String, default: null, sparse: true },
  },
  { timestamps: true },
);

UserSchema.index({ status: 1, role: 1 });

export type UserAttrs = InferSchemaType<typeof UserSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = models.User ?? model("User", UserSchema);
export default User;

/** Shape returned to the client - never includes `passwordHash`. */
export type PublicUser = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  roleId: string;
  roleName: string;
  permissions: Record<string, boolean>;
  department: string;
  site: string;
  position: string;
  phone: string;
  status: "active" | "suspended";
  avatarUrl: string;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
};

export { PERMISSION_KEYS };