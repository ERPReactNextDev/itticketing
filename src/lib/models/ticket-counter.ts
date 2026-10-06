import { Schema, model, models, type InferSchemaType } from "mongoose";

/**
 * Atomic sequence generator backing `{SEQ}` in the ticket number pattern.
 *
 * `dateKey` is the Asia/Manila calendar date so sequences reset at local
 * midnight. When `resetSeqPerDay` is disabled the generator uses the reserved
 * key `GLOBAL` instead, producing one continuous sequence.
 */
export const GLOBAL_COUNTER_KEY = "GLOBAL";

const TicketCounterSchema = new Schema(
  {
    dateKey: { type: String, required: true, unique: true, index: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

export type TicketCounterAttrs = InferSchemaType<typeof TicketCounterSchema>;
export const TicketCounter =
  models.TicketCounter ?? model("TicketCounter", TicketCounterSchema);
export default TicketCounter;