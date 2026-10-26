/** Client-side view models shared across pages. */

export type PermissionKey =
  | "manageUsers"
  | "manageRequestors"
  | "manageDropdowns"
  | "manageSettings"
  | "manageRoles"
  | "viewDashboard"
  | "viewAllTickets"
  | "viewAssignedOnly"
  | "createTicket"
  | "editAnyTicket"
  | "assignTechnician"
  | "changeStatus"
  | "closeTicket"
  | "reopenTicket"
  | "deleteTicket"
  | "exportCsv"
  | "viewAuditLogs"
  | "sendEmailReply";

export type Permissions = Record<PermissionKey, boolean>;

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  roleId: string;
  roleName: string;
  permissions: Permissions;
  department: string;
  site: string;
  status: string;
  avatarUrl: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
};

export type DropdownOption = {
  id: string;
  type: string;
  label: string;
  value: string;
  order: number;
  active: boolean;
  slaHours?: number;
  color?: string;
};

export type TicketRemark = {
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

export type Ticket = {
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

  priority: {
    label: string;
    value: string;
    slaHours: number;
    color?: string;
    inactive: boolean;
  };
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

  remarks: TicketRemark[];
  statusHistory: Array<{ status: string; byName: string; at: string }>;
  assignmentHistory: Array<{ technicianName: string; byName: string; at: string }>;

  lastActivityAt: string;
  createdAt: string;
};

export type TicketListResponse = {
  tickets: Ticket[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type Requestor = {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  department: string;
  site: string;
  phone: string;
  status: string;
  notes: string;
  isGuest: boolean;
  ticketCount?: number;
  createdAt: string;
};

export type StaffUser = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  roleId: string;
  roleName: string;
  department: string;
  site: string;
  position: string;
  phone: string;
  status: string;
  avatarUrl: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  locked: boolean;
  createdAt: string;
};

export type Role = {
  id: string;
  name: string;
  description: string;
  permissions: Permissions;
  isSystem: boolean;
  order: number;
  userCount?: number;
};

export type DashboardData = {
  totals: {
    all: number;
    open: number;
    closed: number;
    fromGmail: number;
    inboundLast24h: number;
    breached: number;
    atRisk: number;
    avgResolutionSeconds: number | null;
  };
  byStatus: Array<{ key: string; count: number }>;
  byPriority: Array<{ key: string; count: number }>;
  byTechnician: Array<{ name: string; count: number }>;
  byDepartment: Array<{ key: string; count: number }>;
  byRequestor: Array<{ name: string; count: number }>;
  atRiskTickets: Array<{
    id: string;
    ticketNumber: string;
    subject: string;
    priorityLabel: string;
    priorityColor: string;
    status: string;
    technicianName: string;
    remainingSeconds: number | null;
    breached: boolean;
    band: string;
  }>;
};

export type AuditLog = {
  id: string;
  actorId: string | null;
  actorName: string;
  actorEmail: string;
  action: string;
  entity: string;
  entityId: string;
  ip: string;
  userAgent: string;
  meta: Record<string, unknown>;
  createdAt: string;
};
