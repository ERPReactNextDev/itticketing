import { Schema, model, models, type InferSchemaType, type HydratedDocument } from "mongoose";

/**
 * The standalone employee / end-user directory.
 *
 * This is the "list of users" that used to be missing from the ticketing flow -
 * it is entirely separate from `users`, which only holds login accounts.
 * Populates the Requestor Name dropdown on New Ticket.
 */
const RequestorSchema = new Schema(
  {
    employeeId: { type: String, required: true, unique: true, trim: true, index: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    /** Always "Last, First" to match the legacy display convention. */
    fullName: { type: String, required: true, trim: true, index: true },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      // Sparse: many employees have no shared mailbox on file.
      index: { unique: true, sparse: true },
    },
    department: { type: String, trim: true, default: "", index: true },
    site: { type: String, trim: true, default: "", index: true },
    phone: { type: String, trim: true, default: "" },

    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    notes: { type: String, default: "" },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    /** Set when the record was auto-created from an unknown Gmail sender. */
    isGuest: { type: Boolean, default: false },

    legacyId: { type: String, default: null, sparse: true },
  },
  { timestamps: true },
);

// Powers the async requestor search (name / email / employeeId).
RequestorSchema.index({ status: 1, fullName: 1 });
RequestorSchema.index({ firstName: "text", lastName: "text", email: "text" });

export type RequestorAttrs = InferSchemaType<typeof RequestorSchema>;
export type RequestorDoc = HydratedDocument<RequestorAttrs>;
export const Requestor = models.Requestor ?? model("Requestor", RequestorSchema);
export default Requestor;

/** Builds "Last, First" and trims doubled spaces from empty parts. */
export function buildFullName(firstName: string, lastName: string): string {
  return [lastName, firstName]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}