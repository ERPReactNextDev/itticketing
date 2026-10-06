import "server-only";
import { connectDB } from "../db/mongoose";
import { Ticket, Requestor, User, type TicketDoc } from "../models";
import { DROPDOWN_TICKET_FIELD, type DropdownType } from "../shared/constants";
import { getSettings } from "./settings";
import {
  buildRequestorSnapshot,
  computeDueAt,
  isClosedStatus,
  isPausedStatus,
  resolveDefaultTechnician,
  resolveDropdownField,
  resolveInitialStatus,
  resolvePriority,
  toActor,
} from "./actor";
import type { AuthUser } from "../auth/session";

export type CreateTicketInput = {
  subject: string;
  description?: string;
  requestorId?: string | null;
  department?: string;
  requestType?: string;
  typeOfConcern?: string;
  mode?: string;
  servicesGroup?: string;
  site?: string;
  priority?: string;
  status?: string;
  scheduledDate?: Date | null;
  attachments?: string[];
  source?: "manual" | "email" | "webform";
  emailThreadId?: string;
  emailMessageIds?: string[];
  remarks?: string;
  /** Supplied by the caller after reserving the number. */
  ticketNumber: string;
  patternVersion: number;
  /** Explicit technician for email/webform intake. */
  technicianId?: string | null;
  /** Overrides `defaultTechnicianAssignment` for a single ticket. */
  assignmentMode?: "self" | "round-robin" | "unassigned";
};

export class TicketValidationError extends Error {
  field: string;
  constructor(message: string, field = "") {
    super(message);
    this.name = "TicketValidationError";
    this.field = field;
  }
}

/**
 * Creates a ticket with every derived field populated:
 * processedBy, technician, priority label + SLA, status, requestor snapshot,
 * first system remark and the status/assignment history entries.
 */
export async function createTicket(
  input: CreateTicketInput,
  actor: AuthUser | null,
): Promise<TicketDoc> {
  await connectDB();
  const settings = await getSettings();
  const now = new Date();

  const subject = (input.subject ?? "").trim();
  if (!subject) throw new TicketValidationError("Subject is required.", "subject");
  if (subject.length > 300) {
    throw new TicketValidationError("Subject must be 300 characters or fewer.", "subject");
  }

  // Requestor: resolve by id, or leave the snapshot blank for guest senders.
  let requestorSnapshot = buildRequestorSnapshot(null);
  let requestorId: string | null = null;
  if (input.requestorId) {
    const requestor = await Requestor.findById(input.requestorId).lean<Record<string, unknown>>();
    if (!requestor) {
      throw new TicketValidationError("That requestor no longer exists.", "requestorId");
    }
    requestorId = String(requestor._id);
    requestorSnapshot = buildRequestorSnapshot({
      employeeId: (requestor.employeeId as string) ?? "",
      fullName: (requestor.fullName as string) ?? "",
      email: (requestor.email as string) ?? "",
      department: (requestor.department as string) ?? "",
      site: (requestor.site as string) ?? "",
      phone: (requestor.phone as string) ?? "",
    });
    // Inherit requestor attributes the submitter left blank.
    input.department ||= (requestor.department as string) ?? "";
    input.site ||= (requestor.site as string) ?? "";
  }

  const priority = await resolvePriority(input.priority, settings.slaDefaults);
  const status = await resolveInitialStatus(input.status);

  // Tickets store the option *value* (slug), never the display label. Email
  // intake supplies labels like Email, so they are resolved to values here -
  // otherwise the stored value would not match its dropdown option, and every
  // filter and inactive-check would silently miss.
  const mode = await resolveDropdownField("mode", input.mode);
  const servicesGroup = await resolveDropdownField("servicesGroup", input.servicesGroup);
  const assignmentMode = input.assignmentMode ?? settings.defaultTechnicianAssignment;
  const technicianId =
    input.technicianId !== undefined
      ? input.technicianId
      : ((await resolveDefaultTechnician(actor, assignmentMode)) as string | null);

  const author = toActor(actor);
  const closed = isClosedStatus(status);

  const ticket = new Ticket({
    ticketNumber: input.ticketNumber,
    patternVersion: input.patternVersion,
    subject,
    description: (input.description ?? "").trim(),

    requestor: requestorId,
    requestorSnapshot,

    department: (input.department ?? "").trim(),
    requestType: (input.requestType ?? "").trim(),
    typeOfConcern: (input.typeOfConcern ?? "").trim(),
    mode,
    servicesGroup,
    site: (input.site ?? "").trim(),

    priority,
    status,

    processedBy: author.id,
    technician: technicianId,
    closedBy: closed ? author.id : null,

    scheduledDate: input.scheduledDate ?? null,
    dateCreated: now,
    dateClosed: closed ? now : null,

    slaDueAt: computeDueAt(priority.slaHours, now),
    slaPausedTotalSeconds: 0,
    // Pause immediately if the ticket is created straight into Scheduled.
    slaPausedAt: isPausedStatus(status) ? now : null,

    attachments: input.attachments ?? [],
    source: input.source ?? "manual",
    emailThreadId: input.emailThreadId,
    emailMessageIds: input.emailMessageIds ?? [],

    lastActivityAt: now,

    remarks: [],
    statusHistory: [{ status, by: author.id, byName: author.name, at: now }],
    assignmentHistory: technicianId
      ? [{ technician: technicianId, by: author.id, byName: author.name, at: now }]
      : [],
  });

  const note = (input.remarks ?? "").trim();
  if (note) {
    ticket.remarks.push({
      type: "note",
      authorName: author.name,
      authorRef: author.id,
      content: note,
    } as never);
  }

  ticket.remarks.push({
    type: "system",
    authorName: "System",
    authorRef: null,
    content: `Ticket created by ${author.name}`,
  } as never);

  if (technicianId) {
    ticket.remarks.push({
      type: "assignment",
      authorName: author.name,
      authorRef: author.id,
      content: `Assigned to technician`,
      field: "technician",
      oldValue: "",
      newValue: String(technicianId),
    } as never);
  }

  await ticket.save();
  return ticket;
}

/** Editable dropdown-backed fields that generate `field-change` remarks. */
export const EDITABLE_DROPDOWN_FIELDS = {
  department: "department",
  requestType: "requestType",
  typeOfConcern: "typeOfConcern",
  mode: "mode",
  servicesGroup: "servicesGroup",
  site: "site",
  status: "status",
  priority: "priority",
} as const satisfies Record<DropdownType, keyof CreateTicketInput>;

type EditableDropdownType = keyof typeof EDITABLE_DROPDOWN_FIELDS;

/**
 * Mutable view of the ticket fields this module writes.
 *
 * Mongoose's inferred document type is intentionally strict about assignment
 * (ObjectId vs string, required subdoc fields, no dynamic keys). This alias
 * describes exactly the fields `patchTicket` touches so the mutations stay
 * type-checked without scattering casts through the function.
 */
type MutableTicket = {
  subject: string;
  description: string;
  department: string;
  requestType: string;
  typeOfConcern: string;
  mode: string;
  servicesGroup: string;
  site: string;
  status: string;
  priority: { label: string; value: string; slaHours: number; color: string; inactive?: boolean };
  /** Allows the dropdown-field loop to index by field name. */
  [key: string]: unknown;
  scheduledDate: Date | null;
  requestor: unknown;
  technician: unknown;
  processedBy: unknown;
  closedBy: unknown;
  reopenedBy: unknown;
  dateCreated: Date;
  dateClosed: Date | null;
  dateReopened: Date | null;
  durationSeconds: number | null;
  slaDueAt: Date | null;
  slaPausedAt: Date | null;
  slaPausedTotalSeconds: number;
  attachments: unknown[];
  requestorSnapshot: Record<string, string>;
  lastActivityAt: Date;
  remarks: Array<Record<string, unknown>>;
  statusHistory: Array<Record<string, unknown>>;
  assignmentHistory: Array<Record<string, unknown>>;
};

export type TicketPatch = Partial<Record<string, unknown>>;

export type PatchOptions = {
  /** Only these keys are permitted; anything else is rejected. */
  allowed: Set<string>;
  /** Skip the remark append (used by bulk operations which write their own). */
  silent?: boolean;
};

/**
 * Applies a partial update and, for every field that actually changed, appends
 * the matching timeline remark. This is the only sanctioned way to mutate a
 * ticket, which is what keeps the timeline complete.
 */
export async function patchTicket(
  ticket: TicketDoc,
  patch: TicketPatch,
  actor: AuthUser | null,
  options: PatchOptions,
): Promise<TicketDoc> {
  await connectDB();
  const settings = await getSettings();
  const author = toActor(actor);
  const now = new Date();
  const doc = ticket as unknown as MutableTicket;

  const rejected = Object.keys(patch).filter((key) => !options.allowed.has(key));
  if (rejected.length > 0) {
    throw new TicketValidationError(
      `You cannot change: ${rejected.join(", ")}.`,
      rejected[0],
    );
  }

  const pushRemark = (remark: Record<string, unknown>) => {
    if (options.silent) return;
    doc.remarks.push({ ...remark, authorName: author.name, authorRef: author.id });
  };

  const fieldLabel = (key: string): string => {
    const map: Record<string, string> = {
      subject: "Subject",
      description: "Description",
      department: "Department",
      requestType: "Request Type",
      typeOfConcern: "Type of Concern",
      mode: "Mode",
      servicesGroup: "Services Group",
      site: "Site",
      scheduledDate: "Scheduled Date",
      technician: "Technician",
      requestor: "Requestor",
    };
    return map[key] ?? key;
  };

  // ── Plain text fields ────────────────────────────────────────────────────
  for (const key of ["subject", "description"] as const) {
    if (patch[key] === undefined) continue;
    const nextValue = String(patch[key] ?? "").trim();
    const previousValue = String(ticket[key] ?? "").trim();
    if (nextValue === previousValue) continue;
    if (key === "subject" && !nextValue) {
      throw new TicketValidationError("Subject cannot be empty.", "subject");
    }
    ticket[key] = nextValue as never;
    pushRemark({
      type: "field-change",
      content: `${fieldLabel(key)} changed`,
      field: key,
      oldValue: previousValue,
      newValue: nextValue,
    });
  }

  // ── Dropdown-backed fields ───────────────────────────────────────────────
  for (const type of Object.keys(EDITABLE_DROPDOWN_FIELDS) as EditableDropdownType[]) {
    if (patch[type] === undefined) continue;
    const nextValue = String(patch[type] ?? "").trim();
    const currentValue = String(doc[DROPDOWN_TICKET_FIELD[type]] ?? "").trim();
    if (nextValue === currentValue) continue;

    if (type === "priority") {
      const previousLabel = doc.priority?.label ?? currentValue;
      const priority = await resolvePriority(nextValue, settings.slaDefaults);
      doc.priority = priority;
      // Re-base the SLA deadline from the original creation time so a priority
      // change applies to the whole life of the ticket.
      doc.slaDueAt = computeDueAt(priority.slaHours, doc.dateCreated ?? now);
      pushRemark({
        type: "priority-change",
        content: `Priority ${previousLabel} → ${priority.label}`,
        field: "priority",
        oldValue: previousLabel,
        newValue: priority.label,
      });
      continue;
    }

    if (type === "status") {
      const previousStatus = doc.status;
      doc.status = nextValue;
      doc.statusHistory.push({
        status: nextValue,
        by: author.id,
        byName: author.name,
        at: now,
      } as never);

      const nowClosed = isClosedStatus(nextValue);
      const wasClosed = isClosedStatus(previousStatus);

      if (nowClosed && !wasClosed) {
        doc.closedBy = author.id;
        doc.dateClosed = now;
        doc.durationSeconds = doc.dateCreated
          ? Math.floor((now.getTime() - new Date(doc.dateCreated).getTime()) / 1000)
          : null;
        pushRemark({
          type: "status-change",
          content: `Closed by ${author.name}`,
          field: "status",
          oldValue: previousStatus,
          newValue: nextValue,
        });
      } else if (!nowClosed && wasClosed) {
        // Reopen: clear the closure and restart the SLA clock.
        doc.closedBy = null;
        doc.reopenedBy = author.id;
        doc.dateReopened = now;
        doc.dateClosed = null;
        doc.durationSeconds = null;
        pushRemark({
          type: "system",
          content: `Status ${previousStatus} → ${nextValue} · reopened by ${author.name}`,
          field: "status",
          oldValue: previousStatus,
          newValue: nextValue,
        });
      } else {
        pushRemark({
          type: "status-change",
          content: `${fieldLabel(type)} changed`,
          field: "status",
          oldValue: previousStatus,
          newValue: nextValue,
        });
      }

      // SLA pause handling.
      const shouldPause = isPausedStatus(nextValue) && !nowClosed;
      if (shouldPause && !doc.slaPausedAt) {
        doc.slaPausedAt = now;
        pushRemark({
          type: "system",
          content: "SLA clock paused while ticket is Scheduled",
        });
      } else if (!shouldPause && doc.slaPausedAt) {
        const pausedSeconds = Math.floor(
          (now.getTime() - new Date(doc.slaPausedAt as Date).getTime()) / 1000,
        );
        doc.slaPausedTotalSeconds = Number(doc.slaPausedTotalSeconds ?? 0) + pausedSeconds;
        doc.slaPausedAt = null;
        pushRemark({
          type: "system",
          content: "SLA clock resumed",
        });
      }
      continue;
    }

    doc[DROPDOWN_TICKET_FIELD[type]] = nextValue;
    pushRemark({
      type: "field-change",
      content: `${fieldLabel(type)} changed`,
      field: type,
      oldValue: currentValue,
      newValue: nextValue,
    });
  }

  // ── Scheduled date ───────────────────────────────────────────────────────
  if (patch.scheduledDate !== undefined) {
    const nextValue = patch.scheduledDate ? new Date(patch.scheduledDate as string) : null;
    const currentIso = doc.scheduledDate ? new Date(doc.scheduledDate).toISOString() : "";
    const nextIso = nextValue && !Number.isNaN(nextValue.getTime()) ? nextValue.toISOString() : "";
    if (nextIso !== currentIso) {
      doc.scheduledDate = nextIso ? nextValue : null;
      pushRemark({
        type: "field-change",
        content: "Scheduled Date changed",
        field: "scheduledDate",
        oldValue: currentIso,
        newValue: nextIso,
      });
    }
  }

  // ── Requestor ────────────────────────────────────────────────────────────
  if (patch.requestorId !== undefined) {
    const nextId = patch.requestorId ? String(patch.requestorId) : "";
    const currentId = doc.requestor ? String(doc.requestor) : "";
    if (nextId !== currentId) {
      const requestor = nextId
        ? await Requestor.findById(nextId).lean<Record<string, unknown>>()
        : null;
      if (nextId && !requestor) {
        throw new TicketValidationError("That requestor no longer exists.", "requestorId");
      }
      const previousName = doc.requestorSnapshot?.fullName ?? "";
      const nextName = (requestor?.fullName as string) ?? "";

      doc.requestor = nextId || null;
      doc.requestorSnapshot = buildRequestorSnapshot(
        requestor
          ? {
              employeeId: (requestor.employeeId as string) ?? "",
              fullName: (requestor.fullName as string) ?? "",
              email: (requestor.email as string) ?? "",
              department: (requestor.department as string) ?? "",
              site: (requestor.site as string) ?? "",
              phone: (requestor.phone as string) ?? "",
            }
          : null,
      );
      pushRemark({
        type: "field-change",
        content: "Requestor changed",
        field: "requestor",
        oldValue: previousName,
        newValue: nextName,
      });
    }
  }

  // ── Technician ───────────────────────────────────────────────────────────
  if (patch.technician !== undefined) {
    const nextId = patch.technician ? String(patch.technician) : null;
    const currentId = doc.technician ? String(doc.technician) : null;
    if ((nextId ?? "") !== (currentId ?? "")) {
      let nextName = "Unassigned";
      if (nextId) {
        const tech = await User.findById(nextId).select("name").lean<{ name?: string }>();
        if (!tech) throw new TicketValidationError("That technician no longer exists.", "technician");
        nextName = tech.name ?? String(nextId);
      }

      let previousName = "Unassigned";
      if (currentId) {
        const previous = await User.findById(currentId).select("name").lean<{ name?: string }>();
        previousName = previous?.name ?? String(currentId);
      }

      doc.technician = nextId;
      doc.assignmentHistory.push({
        technician: nextId,
        technicianName: nextName,
        by: author.id,
        byName: author.name,
        at: now,
      } as never);
      pushRemark({
        type: "assignment",
        content: `Reassigned: ${previousName} → ${nextName}`,
        field: "technician",
        oldValue: previousName,
        newValue: nextName,
      });
    }
  }

  // ── Attachments ──────────────────────────────────────────────────────────
  if (patch.attachments !== undefined) {
    const next = Array.isArray(patch.attachments) ? (patch.attachments as string[]) : [];
    const current = ((doc.attachments ?? []) as unknown[]).map(String);
    const added = next.filter((id) => !current.includes(id));
    if (added.length > 0 || next.length !== current.length) {
      doc.attachments = next as never;
      pushRemark({
        type: "field-change",
        content: `${added.length} attachment(s) added`,
        field: "attachments",
        oldValue: `${current.length} file(s)`,
        newValue: `${next.length} file(s)`,
      });
    }
  }

  doc.lastActivityAt = now;
  await ticket.save();
  return ticket;
}

/** Appends a single remark. Used by notes, email in/out and system events. */
export async function appendRemark(
  ticket: { _id: unknown },
  remark: {
    type: string;
    content: string;
    authorName: string;
    authorRef?: string | null;
    field?: string;
    oldValue?: string;
    newValue?: string;
    attachments?: string[];
    emailMessageId?: string;
  },
): Promise<void> {
  await connectDB();
  await Ticket.updateOne(
    { _id: ticket._id },
    {
      $push: {
        remarks: {
          type: remark.type,
          authorName: remark.authorName,
          authorRef: remark.authorRef ?? null,
          content: remark.content,
          field: remark.field ?? "",
          oldValue: remark.oldValue ?? "",
          newValue: remark.newValue ?? "",
          attachments: remark.attachments ?? [],
          emailMessageId: remark.emailMessageId,
        },
      } as never,
      $set: { lastActivityAt: new Date() },
    },
  );
}

export { Requestor };
