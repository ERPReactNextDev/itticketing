/**
 * Single source of truth for RBAC.
 *
 * These keys are written into every `roles` document's `permissions` object, so
 * adding a key here is a backwards-compatible migration (older roles simply
 * lack the new key and fall back to `false`). Never rename or remove a key
 * without writing a migration.
 */
export const PERMISSION_KEYS = [
  "manageUsers",
  "manageRequestors",
  "manageDropdowns",
  "manageSettings",
  "manageRoles",
  "viewDashboard",
  "viewAllTickets",
  "viewAssignedOnly",
  "createTicket",
  "editAnyTicket",
  "assignTechnician",
  "changeStatus",
  "closeTicket",
  "reopenTicket",
  "deleteTicket",
  "exportCsv",
  "viewAuditLogs",
  "sendEmailReply",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionSet = Record<PermissionKey, boolean>;

/** Human labels for the RBAC matrix editor in SuperAdmin. */
export const PERMISSION_LABELS: Record<PermissionKey, { label: string; hint: string }> = {
  manageUsers: { label: "Manage Staff / Agents", hint: "Create, edit, suspend and reset login accounts" },
  manageRequestors: { label: "Manage Requestors", hint: "Edit the employee directory and CSV import" },
  manageDropdowns: { label: "Manage Dropdowns", hint: "Add, reorder and deactivate ticket field options" },
  manageSettings: { label: "Manage Settings", hint: "Ticket numbering, SLA, email and rate limits" },
  manageRoles: { label: "Manage Roles", hint: "Edit roles and the permission matrix" },
  viewDashboard: { label: "View Dashboard", hint: "See aggregate stats and charts" },
  viewAllTickets: { label: "View All Tickets", hint: "Bypass the assigned-only ticket filter" },
  viewAssignedOnly: { label: "View Assigned Only", hint: "Limit lists to tickets assigned to or processed by them" },
  createTicket: { label: "Create Ticket", hint: "Open new tickets" },
  editAnyTicket: { label: "Edit Any Ticket", hint: "Edit fields on tickets they do not own" },
  assignTechnician: { label: "Assign Technician", hint: "Reassign the technician on a ticket" },
  changeStatus: { label: "Change Status", hint: "Move a ticket between Pending / Scheduled / Ongoing" },
  closeTicket: { label: "Close Ticket", hint: "Resolve a ticket (sets closedBy + dateClosed)" },
  reopenTicket: { label: "Reopen Ticket", hint: "Reopen a resolved ticket (resumes SLA)" },
  deleteTicket: { label: "Delete Ticket", hint: "Permanently remove tickets" },
  exportCsv: { label: "Export CSV", hint: "Download ticket and requestor exports" },
  viewAuditLogs: { label: "View Audit Logs", hint: "Read the immutable audit trail" },
  sendEmailReply: { label: "Send Email Reply", hint: "Send outbound replies through Resend" },
};

/** All permissions granted. */
export const ALL_PERMISSIONS: PermissionSet = PERMISSION_KEYS.reduce(
  (acc, key) => {
    acc[key] = true;
    return acc;
  },
  {} as PermissionSet,
);

/** No permissions. */
export const NO_PERMISSIONS: PermissionSet = PERMISSION_KEYS.reduce(
  (acc, key) => {
    acc[key] = false;
    return acc;
  },
  {} as PermissionSet,
);

export type SystemRoleName = "SuperAdmin" | "Admin" | "Agent" | "Viewer";

/**
 * Seeded role templates. SuperAdmin is intentionally the only role that can
 * lock itself out of `manageRoles` / `manageSettings`.
 */
export const SYSTEM_ROLE_DEFAULTS: Record<
  SystemRoleName,
  { name: string; description: string; permissions: PermissionSet }
> = {
  "SuperAdmin": {
    name: "SuperAdmin",
    description: "Unrestricted access. Manages roles, settings and every ticket.",
    permissions: { ...ALL_PERMISSIONS },
  },
  Admin: {
    name: "Admin",
    description: "Supervisor-level access to the directory, configuration and all tickets.",
    permissions: {
      ...NO_PERMISSIONS,
      manageUsers: true,
      manageRequestors: true,
      manageDropdowns: true,
      manageSettings: true,
      // manageRoles stays false - only SuperAdmin may change the matrix.
      manageRoles: false,
      viewDashboard: true,
      viewAllTickets: true,
      viewAssignedOnly: true,
      createTicket: true,
      editAnyTicket: true,
      assignTechnician: true,
      changeStatus: true,
      closeTicket: true,
      reopenTicket: true,
      deleteTicket: true,
      exportCsv: true,
      viewAuditLogs: true,
      sendEmailReply: true,
    },
  },
  Agent: {
    name: "Agent",
    description: "Technician. Works the tickets assigned to or processed by them.",
    permissions: {
      ...NO_PERMISSIONS,
      viewDashboard: true,
      viewAssignedOnly: true,
      createTicket: true,
      assignTechnician: true,
      changeStatus: true,
      closeTicket: true,
      reopenTicket: true,
      exportCsv: true,
      sendEmailReply: true,
    },
  },
  Viewer: {
    name: "Viewer",
    description: "Read-only. Can browse tickets but cannot change them.",
    permissions: {
      ...NO_PERMISSIONS,
      viewDashboard: true,
      viewAllTickets: true,
      viewAssignedOnly: true,
    },
  },
};

/** Fills in any permission key that is missing from a stored role document. */
export function normalizePermissions(input: unknown): PermissionSet {
  const source = (input ?? {}) as Record<string, unknown>;
  const out = {} as PermissionSet;
  for (const key of PERMISSION_KEYS) {
    out[key] = source[key] === true;
  }
  return out;
}

export function isSuperAdminRoleName(name: string | undefined | null): boolean {
  return (name ?? "").trim().toLowerCase() === "superadmin";
}
