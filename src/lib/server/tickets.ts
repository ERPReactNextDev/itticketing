import "server-only";
import { randomUUID } from "crypto";
import { connectDB, unwrap, DatabaseError } from "../db/supabase";
import {
  asRecord,
  asRecordArray,
  asStringArray,
  composeUserName,
  mapRequestorRow,
  mapTicketRow,
  num,
  slug,
  str,
  type TicketDocForDTO,
} from "../db/mappers";
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
  type PriorityValue,
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

/** Anything that can identify a ticket: a DTO, a mapped row, a raw row. */
export type PatchableTicket = {
  id?: string | number;
  _id?: string | number;
  [key: string]: unknown;
};

/** Resolves the numeric primary key from any ticket-shaped object. */
function ticketIdOf(ticket: PatchableTicket): number | null {
  const raw = ticket.id ?? ticket._id;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Mutable view of the ticket fields this module writes.
 *
 * The helpers below talk in the app's camelCase names while the table is flat
 * snake_case; `rowToMutable` / `mutableToRow` are the only places that know the
 * difference. The index signature lets the dropdown-field loop index by name.
 */
type MutableTicket = {
  id: number;
  subject: string;
  description: string;
  department: string;
  requestType: string;
  typeOfConcern: string;
  mode: string;
  servicesGroup: string;
  site: string;
  status: string;
  priority: PriorityValue;
  [key: string]: unknown;
  scheduledDate: Date | null;
  requestor: string | null;
  technician: string | null;
  processedBy: string | null;
  closedBy: string | null;
  reopenedBy: string | null;
  dateCreated: Date | null;
  dateClosed: Date | null;
  dateReopened: Date | null;
  durationSeconds: number | null;
  slaDueAt: Date | null;
  slaPausedAt: Date | null;
  slaPausedTotalSeconds: number;
  attachments: string[];
  requestorSnapshot: Record<string, string>;
  lastActivityAt: Date | null;
  remarks: Array<Record<string, unknown>>;
  statusHistory: Array<Record<string, unknown>>;
  assignmentHistory: Array<Record<string, unknown>>;
};

/** Supabase row -> the mutable camelCase working copy. */
function rowToMutable(row: Record<string, unknown>): MutableTicket {
  const snapshot = asRecord(row.requestor_snapshot);
  const priorityData = asRecord(row.priority_data);
  const priorityLabel = str(row.priority);
  const priority: PriorityValue =
    Object.keys(priorityData).length > 0
      ? {
          label: str(priorityData.label),
          value: str(priorityData.value),
          slaHours: num(priorityData.slaHours, 0),
          color: priorityData.color ? str(priorityData.color) : "#ef4444",
          inactive: priorityData.inactive === true,
        }
      : {
          label: priorityLabel,
          value: slug(priorityLabel),
          slaHours: 0,
          color: "#eab308",
          inactive: true,
        };

  return {
    id: Number(row.id),
    subject: str(row.ticket_subject),
    description: str(row.description),
    department: str(row.department),
    requestType: str(row.request_type),
    typeOfConcern: str(row.type_concern),
    mode: str(row.mode),
    servicesGroup: str(row.group_services),
    site: str(row.site),
    status: str(row.status),
    priority,
    scheduledDate: toDate(row.date_scheduled),
    requestor: row.requestor_id ? str(row.requestor_id) : null,
    technician: row.technician_id ? str(row.technician_id) : null,
    processedBy: row.processed_by_id ? str(row.processed_by_id) : null,
    closedBy: row.closed_by_id ? str(row.closed_by_id) : null,
    reopenedBy: row.reopened_by_id ? str(row.reopened_by_id) : null,
    dateCreated: toDate(row.date_created),
    dateClosed: toDate(row.date_closed),
    dateReopened: toDate(row.date_reopened),
    durationSeconds:
      row.duration_seconds === null || row.duration_seconds === undefined
        ? null
        : num(row.duration_seconds, 0),
    slaDueAt: toDate(row.sla_due_at),
    slaPausedAt: toDate(row.sla_paused_at),
    slaPausedTotalSeconds: num(row.sla_paused_total_seconds, 0),
    attachments: asStringArray(row.attachments),
    requestorSnapshot: {
      employeeId: str(snapshot.employeeId),
      fullName: str(snapshot.fullName),
      email: str(snapshot.email),
      department: str(snapshot.department),
      site: str(snapshot.site),
      phone: str(snapshot.phone),
    },
    lastActivityAt: toDate(row.last_activity_at),
    remarks: asRecordArray(row.remarks_json),
    statusHistory: asRecordArray(row.status_history),
    assignmentHistory: asRecordArray(row.assignment_history),
  };
}

/** The writable columns, serialised back to snake_case for an UPDATE. */
function mutableToRow(doc: MutableTicket): Record<string, unknown> {
  return {
    ticket_subject: doc.subject,
    description: doc.description,
    department: doc.department,
    request_type: doc.requestType,
    type_concern: doc.typeOfConcern,
    mode: doc.mode,
    group_services: doc.servicesGroup,
    site: doc.site,
    status: doc.status,
    // The legacy label column is kept in sync with the structured value.
    priority: doc.priority.label,
    priority_data: doc.priority,
    requestor_id: doc.requestor,
    requestor_snapshot: doc.requestorSnapshot,
    requestor_name: doc.requestorSnapshot.fullName ?? "",
    technician_id: doc.technician,
    closed_by_id: doc.closedBy,
    reopened_by_id: doc.reopenedBy,
    date_closed: isoOrNull(doc.dateClosed),
    date_reopened: isoOrNull(doc.dateReopened),
    duration_seconds: doc.durationSeconds,
    sla_due_at: isoOrNull(doc.slaDueAt),
    sla_paused_at: isoOrNull(doc.slaPausedAt),
    sla_paused_total_seconds: doc.slaPausedTotalSeconds,
    date_scheduled: isoOrNull(doc.scheduledDate),
    attachments: doc.attachments,
    remarks_json: doc.remarks,
    status_history: doc.statusHistory,
    assignment_history: doc.assignmentHistory,
    last_activity_at: isoOrNull(doc.lastActivityAt) ?? new Date().toISOString(),
    date_updated: new Date().toISOString(),
  };
}

/** Builds a timeline remark with a stable id and creation timestamp. */
function buildRemark(
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
  at: Date,
): Record<string, unknown> {
  return {
    id: randomUUID(),
    type: remark.type,
    authorName: remark.authorName,
    authorRef: remark.authorRef ?? null,
    content: remark.content,
    field: remark.field ?? "",
    oldValue: remark.oldValue ?? "",
    newValue: remark.newValue ?? "",
    attachments: remark.attachments ?? [],
    ...(remark.emailMessageId ? { emailMessageId: remark.emailMessageId } : {}),
    createdAt: at.toISOString(),
  };
}

/**
 * Creates a ticket with every derived field populated:
 * processedBy, technician, priority label + SLA, status, requestor snapshot,
 * first system remark and the status/assignment history entries.
 */
export async function createTicket(
  input: CreateTicketInput,
  actor: AuthUser | null,
): Promise<TicketDocForDTO> {
  const supabase = await connectDB();
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
    const numeric = Number(input.requestorId);
    const { data: requestorRow } = Number.isFinite(numeric)
      ? await supabase
          .from("requestors")
          .select("*")
          .eq("id", numeric)
          .maybeSingle<Record<string, unknown>>()
      : { data: null };
    if (!requestorRow) {
      throw new TicketValidationError("That requestor no longer exists.", "requestorId");
    }
    const requestor = mapRequestorRow(requestorRow);
    requestorId = requestor.id;
    requestorSnapshot = buildRequestorSnapshot({
      employeeId: requestor.employeeId,
      fullName: requestor.fullName,
      email: requestor.email,
      department: requestor.department,
      site: requestor.site,
      phone: requestor.phone,
    });
    // Inherit requestor attributes the submitter left blank.
    input.department ||= requestor.department;
    input.site ||= requestor.site;
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
      : await resolveDefaultTechnician(actor, assignmentMode);

  const author = toActor(actor);
  const closed = isClosedStatus(status);

  const remarks: Array<Record<string, unknown>> = [];
  const note = (input.remarks ?? "").trim();
  if (note) {
    remarks.push(
      buildRemark(
        {
          type: "note",
          authorName: author.name,
          authorRef: author.id,
          content: note,
        },
        now,
      ),
    );
  }
  remarks.push(
    buildRemark(
      {
        type: "system",
        authorName: "System",
        authorRef: null,
        content: `Ticket created by ${author.name}`,
      },
      now,
    ),
  );
  if (technicianId) {
    remarks.push(
      buildRemark(
        {
          type: "assignment",
          authorName: author.name,
          authorRef: author.id,
          content: `Assigned to technician`,
          field: "technician",
          oldValue: "",
          newValue: String(technicianId),
        },
        now,
      ),
    );
  }

  const row = {
    ticket_id: input.ticketNumber,
    pattern_version: input.patternVersion,
    ticket_subject: subject,
    description: (input.description ?? "").trim(),

    requestor_id: requestorId,
    requestor_snapshot: requestorSnapshot,
    requestor_name: requestorSnapshot.fullName,

    department: (input.department ?? "").trim(),
    request_type: (input.requestType ?? "").trim(),
    type_concern: (input.typeOfConcern ?? "").trim(),
    mode,
    group_services: servicesGroup,
    site: (input.site ?? "").trim(),

    priority: priority.label,
    priority_data: priority,
    status,

    processed_by: author.name,
    processed_by_id: author.id,
    technician_id: technicianId,
    technician_name: "",
    closed_by: closed ? author.name : "",
    closed_by_id: closed ? author.id : null,

    date_scheduled: input.scheduledDate ? input.scheduledDate.toISOString() : null,
    date_created: now.toISOString(),
    date_updated: now.toISOString(),
    date_closed: closed ? now.toISOString() : null,

    sla_due_at: computeDueAt(priority.slaHours, now).toISOString(),
    sla_paused_total_seconds: 0,
    // Pause immediately if the ticket is created straight into Scheduled.
    sla_paused_at: isPausedStatus(status) ? now.toISOString() : null,

    attachments: input.attachments ?? [],
    source: input.source ?? "manual",
    email_thread_id: input.emailThreadId ?? null,
    email_message_ids: input.emailMessageIds ?? [],

    last_activity_at: now.toISOString(),

    remarks_json: remarks,
    status_history: [
      { status, by: author.id, byName: author.name, at: now.toISOString() },
    ],
    assignment_history: technicianId
      ? [
          {
            technician: technicianId,
            technicianName: "",
            by: author.id,
            byName: author.name,
            at: now.toISOString(),
          },
        ]
      : [],
  };

  const data = unwrap(
    await supabase.from("tickets").insert(row).select("*").single<Record<string, unknown>>(),
  );
  return mapTicketRow(data);
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
 *
 * The row is re-read and written back in one round trip rather than issuing a
 * separate UPDATE per column: the ticket is loaded, mutated, and persisted once.
 */
export async function patchTicket(
  ticket: PatchableTicket,
  patch: TicketPatch,
  actor: AuthUser | null,
  options: PatchOptions,
): Promise<TicketDocForDTO> {
  const supabase = await connectDB();
  const settings = await getSettings();
  const author = toActor(actor);
  const now = new Date();

  const id = ticketIdOf(ticket);
  if (id === null) throw new TicketValidationError("Ticket not found.", "id");

  const rejected = Object.keys(patch).filter((key) => !options.allowed.has(key));
  if (rejected.length > 0) {
    throw new TicketValidationError(`You cannot change: ${rejected.join(", ")}.`, rejected[0]);
  }

  const { data: currentRow } = await supabase
    .from("tickets")
    .select("*")
    .eq("id", id)
    .maybeSingle<Record<string, unknown>>();
  if (!currentRow) throw new TicketValidationError("Ticket not found.", "id");

  const doc = rowToMutable(currentRow);

  const pushRemark = (remark: Record<string, unknown>) => {
    if (options.silent) return;
    doc.remarks.push(
      buildRemark(
        {
          ...(remark as { type: string; content: string }),
          authorName: author.name,
          authorRef: author.id,
        },
        now,
      ),
    );
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
    const previousValue = String(doc[key] ?? "").trim();
    if (nextValue === previousValue) continue;
    if (key === "subject" && !nextValue) {
      throw new TicketValidationError("Subject cannot be empty.", "subject");
    }
    doc[key] = nextValue;
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
        at: now.toISOString(),
      });

      const nowClosed = isClosedStatus(nextValue);
      const wasClosed = isClosedStatus(previousStatus);

      if (nowClosed && !wasClosed) {
        doc.closedBy = author.id;
        doc.dateClosed = now;
        doc.durationSeconds = doc.dateCreated
          ? Math.floor((now.getTime() - doc.dateCreated.getTime()) / 1000)
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
        const pausedSeconds = Math.floor((now.getTime() - doc.slaPausedAt.getTime()) / 1000);
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
    const currentIso = doc.scheduledDate ? doc.scheduledDate.toISOString() : "";
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
      let requestor: ReturnType<typeof mapRequestorRow> | null = null;
      if (nextId) {
        const numeric = Number(nextId);
        const { data: requestorRow } = Number.isFinite(numeric)
          ? await supabase
              .from("requestors")
              .select("*")
              .eq("id", numeric)
              .maybeSingle<Record<string, unknown>>()
          : { data: null };
        if (!requestorRow) {
          throw new TicketValidationError("That requestor no longer exists.", "requestorId");
        }
        requestor = mapRequestorRow(requestorRow);
      }
      const previousName = doc.requestorSnapshot?.fullName ?? "";
      const nextName = requestor?.fullName ?? "";

      doc.requestor = nextId || null;
      doc.requestorSnapshot = buildRequestorSnapshot(
        requestor
          ? {
              employeeId: requestor.employeeId,
              fullName: requestor.fullName,
              email: requestor.email,
              department: requestor.department,
              site: requestor.site,
              phone: requestor.phone,
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
        const numeric = Number(nextId);
        const { data: tech } = Number.isFinite(numeric)
          ? await supabase
              .from("users")
              .select("id, Firstname, Lastname")
              .eq("id", numeric)
              .maybeSingle<Record<string, unknown>>()
          : { data: null };
        if (!tech) throw new TicketValidationError("That technician no longer exists.", "technician");
        nextName = composeUserName(tech) || String(nextId);
      }

      let previousName = "Unassigned";
      if (currentId) {
        const numeric = Number(currentId);
        const { data: previous } = Number.isFinite(numeric)
          ? await supabase
              .from("users")
              .select("id, Firstname, Lastname")
              .eq("id", numeric)
              .maybeSingle<Record<string, unknown>>()
          : { data: null };
        previousName = previous ? composeUserName(previous) || String(currentId) : String(currentId);
      }

      doc.technician = nextId;
      doc.assignmentHistory.push({
        technician: nextId,
        technicianName: nextName,
        by: author.id,
        byName: author.name,
        at: now.toISOString(),
      });
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
    const current = (doc.attachments ?? []).map(String);
    const added = next.filter((fileId) => !current.includes(fileId));
    if (added.length > 0 || next.length !== current.length) {
      doc.attachments = next;
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

  const updated = unwrap(
    await supabase
      .from("tickets")
      .update(mutableToRow(doc))
      .eq("id", id)
      .select("*")
      .single<Record<string, unknown>>(),
  );
  return mapTicketRow(updated);
}

/**
 * Appends a single remark. Used by notes, email in/out and system events.
 *
 * The append happens inside `append_ticket_remark()` so two concurrent events
 * cannot overwrite each other's remark (a read-modify-write in JS could).
 */
export async function appendRemark(
  ticket: PatchableTicket,
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
  const id = ticketIdOf(ticket);
  if (id === null) return;

  const supabase = await connectDB();
  const { error } = await supabase.rpc("append_ticket_remark", {
    p_ticket_id: id,
    p_remark: buildRemark(remark, new Date()),
  });
  if (error) throw new DatabaseError(error);
}
