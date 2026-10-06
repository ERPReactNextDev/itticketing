import { Schema, model, models, type InferSchemaType } from "mongoose";
import { DEFAULT_TICKET_NUMBER_PATTERN, DEFAULT_TICKET_PREFIX } from "../shared/constants";

/**
 * Singleton configuration document (always `_id: "singleton"`).
 *
 * Every value here is editable at runtime from Super Admin > Configuration and
 * is read live - changing a threshold never requires a redeploy.
 */
const SystemSettingSchema = new Schema(
  {
    _id: { type: String, default: "singleton" },

    ticketNumberPattern: { type: String, default: DEFAULT_TICKET_NUMBER_PATTERN },
    ticketPrefix: { type: String, default: DEFAULT_TICKET_PREFIX },
    /** Date format used when a ticket number falls back to a date-only render. */
    dateFormatInNumber: { type: String, default: "YYYY-MM-DD" },
    seqPadLength: { type: Number, default: 3, min: 1, max: 10 },
    /** false = one continuous counter that never resets. */
    resetSeqPerDay: { type: Boolean, default: true },
    /**
     * Bumped whenever the numbering settings change. Stored on each ticket so
     * existing numbers are never retroactively rewritten.
     */
    patternVersion: { type: Number, default: 1 },

    resendFromEmail: { type: String, default: "" },
    inboundEmail: { type: String, default: "" },

    rateLimits: {
      loginWindowMin: { type: Number, default: 15 },
      loginMaxAttempts: { type: Number, default: 5 },
      /** Consecutive failures that trigger `user.lockUntil`. */
      loginLockAfterFails: { type: Number, default: 10 },
      ticketCreateWindowMin: { type: Number, default: 60 },
      ticketCreateMax: { type: Number, default: 10 },
      ticketCreateMaxUnauthenticated: { type: Number, default: 3 },
      globalPerMin: { type: Number, default: 100 },
      /** Generous ceiling for the inbound email webhook. */
      webhookPerMin: { type: Number, default: 600 },
    },

    /** SLA hours per priority value. Falls back to dropdown `slaHours`. */
    slaDefaults: {
      type: Map,
      of: Number,
      default: () => new Map(),
    },

    /** Freeze the SLA clock while a ticket sits in Scheduled. */
    pauseSlaOnScheduled: { type: Boolean, default: true },

    defaultTechnicianAssignment: {
      type: String,
      enum: ["self", "round-robin", "unassigned"],
      default: "self",
    },

    sessionTimeoutMin: { type: Number, default: 480, min: 5 },

    email: {
      /** Priority applied to tickets auto-created from inbound email. */
      autoTicketPriority: { type: String, default: "" },
      autoTicketStatus: { type: String, default: "Pending" },
      autoTicketMode: { type: String, default: "Email" },
      autoTicketServicesGroup: { type: String, default: "" },
      sendAutoAcknowledgement: { type: Boolean, default: true },
      /** Notify the assigned technician on inbound mail. */
      notifyTechnicianOnInbound: { type: Boolean, default: true },
    },

    /** Header name/secret used to verify Resend inbound webhooks. */
    resendInboundSecret: { type: String, default: "" },
  },
  { timestamps: true },
);

export type SystemSettingAttrs = InferSchemaType<typeof SystemSettingSchema>;
export const SystemSetting =
  models.SystemSetting ?? model("SystemSetting", SystemSettingSchema);
export default SystemSetting;

/** Filters the full schema down to the persisted defaults. */
export function defaultSettingsShape() {
  return {
    ticketNumberPattern: DEFAULT_TICKET_NUMBER_PATTERN,
    ticketPrefix: DEFAULT_TICKET_PREFIX,
    dateFormatInNumber: "YYYY-MM-DD",
    seqPadLength: 3,
    resetSeqPerDay: true,
    patternVersion: 1,
    resendFromEmail: process.env.EMAIL_FROM ?? "",
    inboundEmail: process.env.INBOUND_EMAIL ?? "",
    rateLimits: {
      loginWindowMin: Number(process.env.RATE_LIMIT_LOGIN_WINDOW_MIN ?? 15),
      loginMaxAttempts: Number(process.env.RATE_LIMIT_LOGIN_MAX_ATTEMPTS ?? 5),
      loginLockAfterFails: Number(process.env.RATE_LIMIT_LOGIN_LOCK_AFTER ?? 10),
      ticketCreateWindowMin: Number(process.env.RATE_LIMIT_TICKET_WINDOW_MIN ?? 60),
      ticketCreateMax: Number(process.env.RATE_LIMIT_TICKET_MAX ?? 10),
      ticketCreateMaxUnauthenticated: Number(
        process.env.RATE_LIMIT_TICKET_MAX_UNAUTH ?? 3,
      ),
      globalPerMin: Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN ?? 100),
      webhookPerMin: Number(process.env.RATE_LIMIT_WEBHOOK_PER_MIN ?? 600),
    },
    pauseSlaOnScheduled: true,
    defaultTechnicianAssignment: "self" as const,
    sessionTimeoutMin: Number(process.env.SESSION_TIMEOUT_MIN ?? 480),
    sendAutoAcknowledgement: true,
    notifyTechnicianOnInbound: true,
  };
}