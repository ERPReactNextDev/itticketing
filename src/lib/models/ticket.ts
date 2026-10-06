import { Schema, model, models, type InferSchemaType, type HydratedDocument } from "mongoose";
import { REMARK_TYPES, TICKET_SOURCES } from "../shared/constants";

/**
 * One entry in the ticket timeline. Every state change, assignment, priority
 * edit, note and inbound/outbound email is appended here - remarks are the
 * single audit surface of a ticket.
 */
const RemarkSchema = new Schema(
  {
    type: { type: String, enum: REMARK_TYPES, required: true },
    authorName: { type: String, required: true },
    authorRef: { type: Schema.Types.ObjectId, ref: "User", default: null },

    content: { type: String, default: "" },

    /** Set on field-change remarks. */
    field: { type: String, default: "" },
    oldValue: { type: String, default: "" },
    newValue: { type: String, default: "" },

    attachments: [{ type: Schema.Types.ObjectId, ref: "fs.files" }],

    emailMessageId: { type: String, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const PrioritySchema = new Schema(
  {
    label: { type: String, required: true },
    value: { type: String, required: true },
    slaHours: { type: Number, required: true, min: 0 },
    color: { type: String, default: "#ef4444" },
    /** Set when the option has since been deactivated in Configuration. */
    inactive: { type: Boolean, default: false },
  },
  { _id: false },
);

const StatusEventSchema = new Schema(
  {
    status: { type: String, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const AssignmentEventSchema = new Schema(
  {
    technician: { type: Schema.Types.ObjectId, ref: "User", default: null },
    technicianName: { type: String, default: "" },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const TicketSchema = new Schema(
  {
    ticketNumber: { type: String, required: true, unique: true, index: true },
    /**
     * Version of `system_settings.ticketNumberPattern` that produced
     * `ticketNumber`. Stored so a later pattern change never renumbers history.
     */
    patternVersion: { type: Number, default: 1 },

    subject: { type: String, required: true, trim: true },
    description: { type: String, default: "" },

    requestor: { type: Schema.Types.ObjectId, ref: "Requestor", default: null, index: true },
    /**
     * Snapshot of the requestor at creation. The ticket must keep rendering
     * correctly even if the requestor record is later renamed or deactivated.
     */
    requestorSnapshot: {
      employeeId: { type: String, default: "" },
      fullName: { type: String, default: "" },
      email: { type: String, default: "" },
      department: { type: String, default: "" },
      site: { type: String, default: "" },
      phone: { type: String, default: "" },
    },

    department: { type: String, default: "", index: true },
    requestType: { type: String, default: "", index: true },
    typeOfConcern: { type: String, default: "", index: true },
    mode: { type: String, default: "" },
    servicesGroup: { type: String, default: "" },
    site: { type: String, default: "", index: true },

    priority: { type: PrioritySchema, required: true },
    status: { type: String, required: true, index: true },

    /** Auto-set to the logged-in creator, read-only. */
    processedBy: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    /** Auto-defaults to `processedBy`, reassignable with `assignTechnician`. */
    technician: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reopenedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    scheduledDate: { type: Date, default: null, index: true },
    dateCreated: { type: Date, default: Date.now, index: true },
    dateClosed: { type: Date, default: null },
    dateReopened: { type: Date, default: null },

    slaDueAt: { type: Date, default: null, index: true },
    /** Seconds the SLA clock has been frozen by Scheduled status. */
    slaPausedTotalSeconds: { type: Number, default: 0 },
    /** Set while the SLA clock is frozen; cleared when work resumes. */
    slaPausedAt: { type: Date, default: null },

    /** Cached resolution time in seconds, set on close. */
    durationSeconds: { type: Number, default: null },

    attachments: [{ type: Schema.Types.ObjectId, ref: "fs.files" }],

    source: { type: String, enum: TICKET_SOURCES, default: "manual", index: true },
    emailThreadId: { type: String, default: undefined, index: true },
    emailMessageIds: [{ type: String }],

    remarks: { type: [RemarkSchema], default: [] },
    statusHistory: { type: [StatusEventSchema], default: [] },
    assignmentHistory: { type: [AssignmentEventSchema], default: [] },

    lastActivityAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

// Powers the ticket list default sort and the technician/status filters.
TicketSchema.index({ status: 1, technician: 1, dateCreated: -1 });
TicketSchema.index({ requestor: 1, dateCreated: -1 });
// SLA breach scans run constantly on the dashboard.
TicketSchema.index({ status: 1, slaDueAt: 1 });
// Free-text search over the list search box.
TicketSchema.index({ subject: "text", ticketNumber: "text", description: "text" });

export type TicketAttrs = InferSchemaType<typeof TicketSchema>;
export type TicketDoc = HydratedDocument<TicketAttrs>;
export const Ticket = models.Ticket ?? model("Ticket", TicketSchema);
export default Ticket;