import "server-only";

/**
 * Row <-> document mappers.
 *
 * The UI and the server helpers were written against the old Mongoose document
 * shape (`_id`, camelCase, nested sub-documents). Supabase returns flat
 * snake_case columns. Everything in this file exists to translate between the
 * two, so the rest of the app keeps working unchanged.
 *
 * The legacy `users` and `tickets` tables keep their original PascalCase /
 * snake_case columns; the app's own columns are the lowercase ones added by
 * `supabase/schema.sql`.
 */

/* ── Primitive coercion ──────────────────────────────────────────────────── */

export function str(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

/** Normalises any date-ish value to an ISO string, or null. */
export function iso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** URL-safe slug, used to derive a dropdown value from a free-form label. */
export function slug(value: unknown): string {
  return str(value)
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => str(v)).filter(Boolean);
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (v) => v && typeof v === "object" && !Array.isArray(v),
    ) as Array<Record<string, unknown>>;
  }
  return [];
}

/* ── users ───────────────────────────────────────────────────────────────── */

export type UserRow = Record<string, unknown>;

export type UserDoc = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  passwordHash: string;
  roleId: string;
  department: string;
  site: string;
  position: string;
  phone: string;
  status: "active" | "suspended";
  avatarUrl: string;
  failedLoginAttempts: number;
  lockUntil: Date | null;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  legacyUserId: string | null;
  createdAt: string | null;
};

export function normalizeUserStatus(value: unknown): "active" | "suspended" {
  const raw = str(value).trim().toLowerCase();
  if (!raw) return "active";
  if (
    raw.includes("suspend") ||
    raw.includes("inactive") ||
    raw.includes("disabled") ||
    raw.includes("blocked")
  ) {
    return "suspended";
  }
  return "active";
}

/** Builds "First Last" from the two legacy name columns. */
export function composeUserName(row: UserRow): string {
  const explicit = str(row.name).trim();
  if (explicit) return explicit;
  const first = str(row.Firstname).trim();
  const last = str(row.Lastname).trim();
  return `${first} ${last}`.trim();
}

export function splitUserName(name: string): { first: string; last: string } {
  const parts = str(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** Builds "Last, First" and trims doubled spaces from empty parts. */
export function buildFullName(firstName: string, lastName: string): string {
  return [lastName, firstName]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

export function mapUserRow(row: UserRow, includePassword = false): UserDoc {
  const email = str(row.Email ?? row.email).trim().toLowerCase();
  return {
    id: str(row.id),
    name: composeUserName(row) || email,
    email,
    employeeId: str(row.ReferenceID ?? row.employeeId),
    passwordHash: includePassword ? str(row.Password) : "",
    roleId: row.role_id === null || row.role_id === undefined ? "" : str(row.role_id),
    department: str(row.Department ?? row.department),
    site: str(row.Location ?? row.site),
    position: str(row.Position ?? row.position),
    phone: str(row.ContactNumber ?? row.phone),
    status: normalizeUserStatus(row.Status ?? row.status),
    avatarUrl: str(row.profilePicture ?? row.avatar_url),
    failedLoginAttempts: num(row.LoginAttempts ?? row.failed_login_attempts, 0),
    lockUntil: row.lock_until ? new Date(str(row.lock_until)) : null,
    lastLoginAt: row.LastLoginAt ? new Date(str(row.LastLoginAt)) : null,
    mustChangePassword: bool(row.must_change_password, false),
    legacyUserId: row.legacy_user_id ? str(row.legacy_user_id) : null,
    createdAt: iso(row.createdAt ?? row.created_at),
  };
}

/** App user fields -> legacy Supabase columns (for writes). */
export function userFieldsToRow(fields: Record<string, unknown>): UserRow {
  const row: UserRow = {};
  if ("name" in fields) {
    const { first, last } = splitUserName(str(fields.name));
    row.Firstname = first;
    row.Lastname = last;
  }
  if ("email" in fields) row.Email = str(fields.email).trim().toLowerCase();
  if ("employeeId" in fields) row.ReferenceID = str(fields.employeeId);
  if ("passwordHash" in fields) row.Password = str(fields.passwordHash);
  if ("roleId" in fields) {
    row.role_id = fields.roleId === null || fields.roleId === "" ? null : Number(fields.roleId);
  }
  if ("department" in fields) row.Department = str(fields.department);
  if ("site" in fields) row.Location = str(fields.site);
  if ("position" in fields) row.Position = str(fields.position);
  if ("phone" in fields) row.ContactNumber = str(fields.phone);
  if ("status" in fields) row.Status = str(fields.status);
  if ("avatarUrl" in fields) row.profilePicture = str(fields.avatarUrl);
  if ("failedLoginAttempts" in fields) row.LoginAttempts = num(fields.failedLoginAttempts, 0);
  if ("lockUntil" in fields) {
    row.lock_until = fields.lockUntil ? new Date(fields.lockUntil as string).toISOString() : null;
  }
  if ("lastLoginAt" in fields) {
    row.LastLoginAt = fields.lastLoginAt
      ? new Date(fields.lastLoginAt as string).toISOString().slice(0, 10)
      : null;
  }
  if ("mustChangePassword" in fields) row.must_change_password = bool(fields.mustChangePassword);
  if ("legacyUserId" in fields) row.legacy_user_id = fields.legacyUserId ?? null;
  return row;
}

/* ── tickets ─────────────────────────────────────────────────────────────── */

export type TicketRow = Record<string, unknown>;

export type TicketRemarkDoc = {
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

/** Detail DTO's view of a ticket, keyed the way `toTicketDTO` expects. */
export type TicketDocForDTO = Record<string, unknown>;

export type NameMap = Map<string, string>;

function nameOfRef(names: NameMap | undefined, id: unknown, fallback: string): string {
  if (!id) return fallback;
  const key = str(id);
  return names?.get(key) ?? fallback;
}

export function normalizeRemarks(value: unknown): TicketRemarkDoc[] {
  return asRecordArray(value).map((remark, index) => ({
    id: str(remark.id ?? remark._id ?? index),
    type: str(remark.type, "note"),
    authorName: str(remark.authorName),
    authorRef: remark.authorRef ? str(remark.authorRef) : null,
    content: str(remark.content),
    field: remark.field ? str(remark.field) : undefined,
    oldValue: remark.oldValue ? str(remark.oldValue) : undefined,
    newValue: remark.newValue ? str(remark.newValue) : undefined,
    attachments: asStringArray(remark.attachments),
    emailMessageId: remark.emailMessageId ? str(remark.emailMessageId) : undefined,
    createdAt: iso(remark.createdAt) ?? new Date().toISOString(),
  }));
}

/**
 * Supabase row -> the shape `toTicketDTO` reads.
 *
 * `names` maps user ids to display names so the DTO can label
 * processed-by / technician / closed-by without N+1 lookups.
 */
export function mapTicketRow(row: TicketRow, names?: NameMap): TicketDocForDTO {
  const snapshot = asRecord(row.requestor_snapshot);
  const requestorName = str(row.requestor_name);

  const priorityData = asRecord(row.priority_data);
  const priorityLabel = str(row.priority);
  const priority: Record<string, unknown> =
    Object.keys(priorityData).length > 0
      ? priorityData
      : {
          label: priorityLabel,
          value: slug(priorityLabel),
          slaHours: 0,
          color: "#eab308",
          inactive: true,
        };

  return {
    _id: str(row.id),
    ticketNumber: str(row.ticket_id),
    patternVersion: num(row.pattern_version, 1),
    subject: str(row.ticket_subject),
    description: str(row.description),

    requestor: row.requestor_id ? str(row.requestor_id) : null,
    requestorSnapshot:
      Object.keys(snapshot).length > 0
        ? snapshot
        : {
            employeeId: "",
            fullName: requestorName,
            email: "",
            department: str(row.department),
            site: str(row.site),
            phone: "",
          },

    department: str(row.department),
    requestType: str(row.request_type),
    typeOfConcern: str(row.type_concern),
    mode: str(row.mode),
    servicesGroup: str(row.group_services),
    site: str(row.site),

    priority,
    status: str(row.status),

    processedBy: row.processed_by_id ? str(row.processed_by_id) : null,
    processedByName: nameOfRef(names, row.processed_by_id, str(row.processed_by)),
    technician: row.technician_id ? str(row.technician_id) : null,
    technicianName: nameOfRef(names, row.technician_id, str(row.technician_name)),
    closedBy: row.closed_by_id ? str(row.closed_by_id) : null,
    closedByName: nameOfRef(names, row.closed_by_id, str(row.closed_by)),
    reopenedBy: row.reopened_by_id ? str(row.reopened_by_id) : null,

    scheduledDate: iso(row.date_scheduled),
    dateCreated: iso(row.date_created),
    dateClosed: iso(row.date_closed),
    dateReopened: iso(row.date_reopened),
    supportStartTime: iso(row.support_start_time),
    supportEndTime: iso(row.support_end_time),

    slaDueAt: iso(row.sla_due_at),
    slaPausedTotalSeconds: num(row.sla_paused_total_seconds, 0),
    slaPausedAt: iso(row.sla_paused_at),
    durationSeconds:
      row.duration_seconds === null || row.duration_seconds === undefined
        ? null
        : num(row.duration_seconds, 0),

    attachments: asStringArray(row.attachments),
    source: str(row.source, "manual"),
    emailThreadId: row.email_thread_id ? str(row.email_thread_id) : undefined,
    emailMessageIds: asStringArray(row.email_message_ids),

    remarks: normalizeRemarks(row.remarks_json),
    statusHistory: asRecordArray(row.status_history),
    assignmentHistory: asRecordArray(row.assignment_history),

    lastActivityAt: iso(row.last_activity_at) ?? iso(row.date_created),
    createdAt: iso(row.date_created),
  };
}

/* ── requestors ──────────────────────────────────────────────────────────── */

export type RequestorDoc = {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  department: string;
  site: string;
  phone: string;
  status: "active" | "inactive";
  notes: string;
  createdBy: string | null;
  isGuest: boolean;
  createdAt: string | null;
};

export function mapRequestorRow(row: Record<string, unknown>): RequestorDoc {
  return {
    id: str(row.id),
    employeeId: str(row.employee_id),
    firstName: str(row.first_name),
    lastName: str(row.last_name),
    fullName: str(row.full_name),
    email: str(row.email).trim().toLowerCase(),
    department: str(row.department),
    site: str(row.site),
    phone: str(row.phone),
    status: str(row.status, "active") === "inactive" ? "inactive" : "active",
    notes: str(row.notes),
    createdBy: row.created_by ? str(row.created_by) : null,
    isGuest: bool(row.is_guest),
    createdAt: iso(row.created_at),
  };
}

export function requestorFieldsToRow(fields: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const map: Record<string, string> = {
    employeeId: "employee_id",
    firstName: "first_name",
    lastName: "last_name",
    fullName: "full_name",
    email: "email",
    department: "department",
    site: "site",
    phone: "phone",
    status: "status",
    notes: "notes",
    createdBy: "created_by",
    isGuest: "is_guest",
    legacyId: "legacy_id",
  };
  for (const [key, column] of Object.entries(map)) {
    if (key in fields) row[column] = fields[key];
  }
  if (typeof row.email === "string") row.email = row.email.trim().toLowerCase();
  return row;
}

/* ── roles ───────────────────────────────────────────────────────────────── */

export type RoleDoc = {
  id: string;
  name: string;
  description: string;
  permissions: Record<string, unknown>;
  isSystem: boolean;
  order: number;
  createdAt: string | null;
};

export function mapRoleRow(row: Record<string, unknown>): RoleDoc {
  return {
    id: str(row.id),
    name: str(row.name),
    description: str(row.description),
    permissions: asRecord(row.permissions),
    isSystem: bool(row.is_system),
    order: num(row.sort_order, 0),
    createdAt: iso(row.created_at),
  };
}

export function roleFieldsToRow(fields: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if ("name" in fields) row.name = str(fields.name);
  if ("description" in fields) row.description = str(fields.description);
  if ("permissions" in fields) row.permissions = asRecord(fields.permissions);
  if ("isSystem" in fields) row.is_system = bool(fields.isSystem);
  if ("order" in fields) row.sort_order = num(fields.order, 0);
  return row;
}

/* ── dropdown options ────────────────────────────────────────────────────── */

export type DropdownDoc = {
  id: string;
  type: string;
  label: string;
  value: string;
  order: number;
  active: boolean;
  slaHours?: number;
  color?: string;
  legacyValue: string | null;
};

export function mapDropdownRow(row: Record<string, unknown>): DropdownDoc {
  return {
    id: str(row.id),
    type: str(row.type),
    label: str(row.label),
    value: str(row.value),
    order: num(row.sort_order, 0),
    active: bool(row.active, true),
    slaHours:
      row.sla_hours === null || row.sla_hours === undefined ? undefined : num(row.sla_hours, 0),
    color: row.color ? str(row.color) : undefined,
    legacyValue: row.legacy_value ? str(row.legacy_value) : null,
  };
}

export function dropdownFieldsToRow(fields: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if ("type" in fields) row.type = str(fields.type);
  if ("label" in fields) row.label = str(fields.label);
  if ("value" in fields) row.value = str(fields.value);
  if ("order" in fields) row.sort_order = num(fields.order, 0);
  if ("active" in fields) row.active = bool(fields.active, true);
  if ("slaHours" in fields) {
    row.sla_hours =
      fields.slaHours === null || fields.slaHours === undefined ? null : num(fields.slaHours, 0);
  }
  if ("color" in fields) row.color = fields.color ? str(fields.color) : null;
  if ("legacyValue" in fields) row.legacy_value = fields.legacyValue ?? null;
  return row;
}

/* ── email messages ──────────────────────────────────────────────────────── */

export function mapEmailMessageRow(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    ticketId: row.ticket_id ? str(row.ticket_id) : null,
    direction: str(row.direction, "in"),
    provider: str(row.provider, "resend"),
    resendId: row.resend_id ? str(row.resend_id) : null,
    messageId: str(row.message_id),
    threadId: row.thread_id ? str(row.thread_id) : null,
    from: str(row.from_address),
    to: asStringArray(row.to_addresses),
    cc: asStringArray(row.cc_addresses),
    subject: str(row.subject),
    textBody: str(row.text_body),
    htmlBody: str(row.html_body),
    attachments: asStringArray(row.attachments),
    rawPayloadHash: str(row.raw_payload_hash),
    processedAt: iso(row.processed_at),
    autoCreatedTicket: bool(row.auto_created_ticket),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
  };
}

/* ── audit logs ──────────────────────────────────────────────────────────── */

export function mapAuditRow(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    actor: row.actor_id ? str(row.actor_id) : null,
    actorName: str(row.actor_name, "system"),
    actorEmail: str(row.actor_email),
    action: str(row.action),
    entity: str(row.entity),
    entityId: str(row.entity_id),
    ip: str(row.ip),
    userAgent: str(row.user_agent),
    meta: asRecord(row.meta),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
  };
}

/* ── settings ────────────────────────────────────────────────────────────── */

export function mapSettingsRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ticketNumberPattern: row.ticket_number_pattern,
    ticketPrefix: row.ticket_prefix,
    dateFormatInNumber: row.date_format_in_number,
    seqPadLength: row.seq_pad_length,
    resetSeqPerDay: row.reset_seq_per_day,
    patternVersion: row.pattern_version,
    resendFromEmail: row.resend_from_email,
    inboundEmail: row.inbound_email,
    rateLimits: asRecord(row.rate_limits),
    slaDefaults: asRecord(row.sla_defaults),
    pauseSlaOnScheduled: row.pause_sla_on_scheduled,
    defaultTechnicianAssignment: row.default_technician_assignment,
    sessionTimeoutMin: row.session_timeout_min,
    email: asRecord(row.email),
    resendInboundSecret: row.resend_inbound_secret,
  };
}

export function settingsFieldsToRow(fields: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const map: Record<string, string> = {
    ticketNumberPattern: "ticket_number_pattern",
    ticketPrefix: "ticket_prefix",
    dateFormatInNumber: "date_format_in_number",
    seqPadLength: "seq_pad_length",
    resetSeqPerDay: "reset_seq_per_day",
    patternVersion: "pattern_version",
    resendFromEmail: "resend_from_email",
    inboundEmail: "inbound_email",
    rateLimits: "rate_limits",
    slaDefaults: "sla_defaults",
    pauseSlaOnScheduled: "pause_sla_on_scheduled",
    defaultTechnicianAssignment: "default_technician_assignment",
    sessionTimeoutMin: "session_timeout_min",
    email: "email",
    resendInboundSecret: "resend_inbound_secret",
  };
  for (const [key, column] of Object.entries(map)) {
    if (key in fields) row[column] = fields[key];
  }
  return row;
}

export { asRecord, asRecordArray, asStringArray };
