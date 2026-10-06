import "server-only";
import { CLOSED_STATUS_VALUES } from "../shared/constants";
import { computeSla, slaBand, SLA_BAND_STYLES } from "./sla";

/**
 * Shape sent to the client for a ticket row / detail view.
 *
 * Mirrors the legacy snake_case field names the UI already uses
 * (`ticket_id`, `requestor_name`, ...) so the existing components keep working
 * while the storage layer moves to Mongo.
 */
export type TicketDTO = {
  id: string;
  ticketNumber: string;
  patternVersion: number;
  subject: string;
  description: string;

  requestorId: string | null;
  requestorName: string;
  requestorEmployeeId: string;
  requestorEmail: string;
  requestorDepartment: string;
  requestorSite: string;
  requestorPhone: string;

  department: string;
  requestType: string;
  typeOfConcern: string;
  mode: string;
  servicesGroup: string;
  site: string;

  priority: { label: string; value: string; slaHours: number; color?: string; inactive: boolean };
  status: string;
  statusLabel: string;

  processedBy: string | null;
  processedByName: string;
  technician: string | null;
  technicianName: string;
  closedBy: string | null;
  closedByName: string;
  reopenedBy: string | null;

  scheduledDate: string | null;
  dateCreated: string;
  dateClosed: string | null;
  dateReopened: string | null;

  source: string;
  emailThreadId?: string;
  emailMessageIds: string[];
  attachments: string[];

  isClosed: boolean;

  /** Duration for closed tickets, or time-since-creation for open ones. */
  durationSeconds: number | null;
  durationLabel: string;

  sla: {
    dueAt: string | null;
    remainingSeconds: number | null;
    consumedRatio: number | null;
    breached: boolean;
    warning: boolean;
    paused: boolean;
    band: string;
    bandLabel: string;
  };

  remarks: RemarkDTO[];
  statusHistory: Array<{ status: string; byName: string; at: string }>;
  assignmentHistory: Array<{ technicianName: string; byName: string; at: string }>;

  lastActivityAt: string;
  createdAt: string;
};

export type RemarkDTO = {
  id: string;
  type: string;
  authorName: string;
  authorRef: string | null;
  content: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  attachments: string[];
  emailMessageId?: string;
  createdAt: string;
};

function nameOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const populated = value as { name?: string; fullName?: string; email?: string };
  return populated.name ?? populated.fullName ?? populated.email ?? "";
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Formats seconds into the compact `2d 3h 4m` style used across the UI. */
function formatSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/** Turns a Mongoose ticket document into the client-facing DTO. */
export function toTicketDTO(doc: Record<string, unknown>): TicketDTO {
  const status = String(doc.status ?? "");
  const isClosed = CLOSED_STATUS_VALUES.includes(status.toLowerCase());

  const dateCreated = iso(doc.dateCreated) ?? new Date().toISOString();
  const dateClosed = iso(doc.dateClosed);

  const sla = computeSla({
    slaDueAt: (doc.slaDueAt as Date | null) ?? null,
    slaPausedTotalSeconds: Number(doc.slaPausedTotalSeconds ?? 0),
    slaPausedAt: (doc.slaPausedAt as Date | null) ?? null,
    priority: doc.priority as { slaHours?: number } | null,
    status,
    dateCreated,
  });
  const band = slaBand(sla);

  // Closed tickets show how long they took; open ones show the age so far.
  const durationSeconds = dateClosed
    ? Math.floor((new Date(dateClosed).getTime() - new Date(dateCreated).getTime()) / 1000)
    : Math.floor((Date.now() - new Date(dateCreated).getTime()) / 1000);

  const snapshot = (doc.requestorSnapshot ?? {}) as Record<string, string>;
  const priority = (doc.priority ?? {}) as Record<string, unknown>;

  const remarks = ((doc.remarks ?? []) as Array<Record<string, unknown>>).map((remark) => ({
    id: String(remark._id ?? ""),
    type: String(remark.type ?? "note"),
    authorName: String(remark.authorName ?? ""),
    authorRef: remark.authorRef ? String(remark.authorRef) : null,
    content: String(remark.content ?? ""),
    field: remark.field ? String(remark.field) : undefined,
    oldValue: remark.oldValue ? String(remark.oldValue) : undefined,
    newValue: remark.newValue ? String(remark.newValue) : undefined,
    attachments: ((remark.attachments ?? []) as unknown[]).map(String),
    emailMessageId: remark.emailMessageId ? String(remark.emailMessageId) : undefined,
    createdAt: iso(remark.createdAt) ?? new Date().toISOString(),
  }));

  return {
    id: String(doc._id),
    ticketNumber: String(doc.ticketNumber ?? ""),
    patternVersion: Number(doc.patternVersion ?? 1),
    subject: String(doc.subject ?? ""),
    description: String(doc.description ?? ""),

    requestorId: doc.requestor ? String(doc.requestor) : null,
    requestorName: String(snapshot.fullName ?? ""),
    requestorEmployeeId: String(snapshot.employeeId ?? ""),
    requestorEmail: String(snapshot.email ?? ""),
    requestorDepartment: String(snapshot.department ?? ""),
    requestorSite: String(snapshot.site ?? ""),
    requestorPhone: String(snapshot.phone ?? ""),

    department: String(doc.department ?? ""),
    requestType: String(doc.requestType ?? ""),
    typeOfConcern: String(doc.typeOfConcern ?? ""),
    mode: String(doc.mode ?? ""),
    servicesGroup: String(doc.servicesGroup ?? ""),
    site: String(doc.site ?? ""),

    priority: {
      label: String(priority.label ?? ""),
      value: String(priority.value ?? ""),
      slaHours: Number(priority.slaHours ?? 0),
      color: priority.color ? String(priority.color) : undefined,
      inactive: priority.inactive === true,
    },
    status,
    statusLabel: String((doc.statusLabel as string) ?? status),

    processedBy: doc.processedBy ? String(doc.processedBy) : null,
    processedByName: nameOf(doc.processedBy),
    technician: doc.technician ? String(doc.technician) : null,
    technicianName: doc.technician ? nameOf(doc.technician) : "Unassigned",
    closedBy: doc.closedBy ? String(doc.closedBy) : null,
    closedByName: doc.closedBy ? nameOf(doc.closedBy) : "",
    reopenedBy: doc.reopenedBy ? String(doc.reopenedBy) : null,

    scheduledDate: iso(doc.scheduledDate),
    dateCreated,
    dateClosed,
    dateReopened: iso(doc.dateReopened),

    source: String(doc.source ?? "manual"),
    emailThreadId: doc.emailThreadId ? String(doc.emailThreadId) : undefined,
    emailMessageIds: ((doc.emailMessageIds ?? []) as unknown[]).map(String),
    attachments: ((doc.attachments ?? []) as unknown[]).map(String),

    isClosed,

    durationSeconds,
    durationLabel: formatSeconds(durationSeconds),

    sla: {
      dueAt: sla.dueAt ? sla.dueAt.toISOString() : null,
      remainingSeconds: sla.remainingSeconds,
      consumedRatio: sla.consumedRatio,
      breached: sla.breached,
      warning: sla.warning,
      paused: sla.paused,
      band,
      bandLabel: SLA_BAND_STYLES[band].label,
    },

    remarks,
    statusHistory: ((doc.statusHistory ?? []) as Array<Record<string, unknown>>).map((entry) => ({
      status: String(entry.status ?? ""),
      byName: String(entry.byName ?? ""),
      at: iso(entry.at) ?? new Date().toISOString(),
    })),
    assignmentHistory: ((doc.assignmentHistory ?? []) as Array<Record<string, unknown>>).map(
      (entry) => ({
        technicianName: String(entry.technicianName ?? ""),
        byName: String(entry.byName ?? ""),
        at: iso(entry.at) ?? new Date().toISOString(),
      }),
    ),

    lastActivityAt: iso(doc.lastActivityAt) ?? dateCreated,
    createdAt: iso(doc.createdAt) ?? dateCreated,
  };
}

/** Slim projection for list rows - skips remarks to keep payloads small. */
export function toTicketRowDTO(doc: Record<string, unknown>): Omit<TicketDTO, "remarks" | "statusHistory" | "assignmentHistory"> {
  const full = toTicketDTO(doc);
  const { remarks: _remarks, statusHistory: _s, assignmentHistory: _a, ...rest } = full;
  return rest;
}

export { formatSeconds };