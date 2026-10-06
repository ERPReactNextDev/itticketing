import { Schema, model, models, type InferSchemaType } from "mongoose";
import { DROPDOWN_TYPES } from "../shared/constants";

/**
 * One configurable option for a ticket field (department, priority, ...).
 *
 * Options are never hard-deleted once a ticket references them - deactivate
 * with `active: false` instead. Deactivated options disappear from new-ticket
 * dropdowns but still render on historical tickets as "(inactive)".
 */
const DropdownOptionSchema = new Schema(
  {
    type: {
      type: String,
      enum: DROPDOWN_TYPES,
      required: true,
      index: true,
    },
    label: { type: String, required: true, trim: true },
    /** URL-safe slug. Stable across label renames so tickets keep matching. */
    value: { type: String, required: true, trim: true, index: true },
    order: { type: Number, default: 0, index: true },
    active: { type: Boolean, default: true, index: true },

    /** Priority only - drives `slaDueAt`. */
    slaHours: { type: Number, default: undefined },
    /** Status / priority only - drives badge tinting. */
    color: { type: String, default: undefined },

    legacyValue: { type: String, default: null, sparse: true },
  },
  { timestamps: true },
);

// One label per dropdown type.
DropdownOptionSchema.index({ type: 1, label: 1 }, { unique: true });
// Value is unique per type (labels may repeat across types).
DropdownOptionSchema.index({ type: 1, value: 1 }, { unique: true });

export type DropdownOptionAttrs = InferSchemaType<typeof DropdownOptionSchema>;
export const DropdownOption =
  models.DropdownOption ?? model("DropdownOption", DropdownOptionSchema);
export default DropdownOption;