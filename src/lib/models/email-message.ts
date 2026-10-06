import { Schema, model, models, type InferSchemaType } from "mongoose";

/**
 * Every inbound and outbound email, kept independently of the ticket it
 * belongs to so the thread survives a ticket deletion and can be replayed.
 */
const EmailMessageSchema = new Schema(
  {
    /** null for inbound mail that could not be attached to a ticket. */
    ticket: { type: Schema.Types.ObjectId, ref: "Ticket", default: null, index: true },
    direction: { type: String, enum: ["in", "out"], required: true, index: true },
    provider: { type: String, enum: ["resend"], default: "resend" },

    /** Provider-side id (Resend). */
    resendId: { type: String, default: undefined, index: true },
    /** RFC 5322 Message-ID. The inbound dedupe key. */
    messageId: { type: String, required: true, unique: true, index: true },
    threadId: { type: String, default: undefined, index: true },

    from: { type: String, default: "" },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    subject: { type: String, default: "" },
    textBody: { type: String, default: "" },
    /** Sanitized before storage. Always paired with `textBody`. */
    htmlBody: { type: String, default: "" },

    attachments: [{ type: Schema.Types.ObjectId, ref: "fs.files" }],

    /** sha256 of the raw payload - secondary dedupe / tamper check. */
    rawPayloadHash: { type: String, default: "" },
    processedAt: { type: Date, default: null },
    autoCreatedTicket: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

EmailMessageSchema.index({ ticket: 1, createdAt: -1 });
EmailMessageSchema.index({ threadId: 1, createdAt: -1 });

export type EmailMessageAttrs = InferSchemaType<typeof EmailMessageSchema>;
export const EmailMessage =
  models.EmailMessage ?? model("EmailMessage", EmailMessageSchema);
export default EmailMessage;