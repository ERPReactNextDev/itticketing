/** Enumerations shared by Mongoose schemas, API routes and the UI. */

export const DROPDOWN_TYPES = [
  "department",
  "requestType",
  "typeOfConcern",
  "mode",
  "servicesGroup",
  "site",
  "status",
  "priority",
] as const;
export type DropdownType = (typeof DROPDOWN_TYPES)[number];

/** Field on the ticket document that each dropdown type populates. */
export const DROPDOWN_TICKET_FIELD: Record<DropdownType, string> = {
  department: "department",
  requestType: "requestType",
  typeOfConcern: "typeOfConcern",
  mode: "mode",
  servicesGroup: "servicesGroup",
  site: "site",
  status: "status",
  priority: "priority",
};

export const DROPDOWN_LABELS: Record<DropdownType, string> = {
  department: "Department",
  requestType: "Request Type",
  typeOfConcern: "Type of Concern",
  mode: "Mode",
  servicesGroup: "Services Group",
  site: "Site",
  status: "Status",
  priority: "Priority · SLA",
};

/** Status values that mean "this ticket is finished". */
export const CLOSED_STATUS_VALUES = ["resolved", "closed", "cancelled"];

/** Status value that freezes the SLA clock. */
export const PAUSED_STATUS_VALUES = ["scheduled"];

export const TICKET_SOURCES = ["manual", "email", "webform"] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const REMARK_TYPES = [
  "note",
  "email-in",
  "email-out",
  "status-change",
  "priority-change",
  "assignment",
  "field-change",
  "system",
] as const;
export type RemarkType = (typeof REMARK_TYPES)[number];

export const REMARK_TYPE_LABELS: Record<RemarkType, string> = {
  note: "Note",
  "email-in": "Email In",
  "email-out": "Email Out",
  "status-change": "Status Change",
  "priority-change": "Priority Change",
  assignment: "Assignment",
  "field-change": "Field Change",
  system: "System",
};

export const USER_STATUSES = ["active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const DIRECTORY_STATUSES = ["active", "inactive"] as const;
export type DirectoryStatus = (typeof DIRECTORY_STATUSES)[number];

export const EMAIL_DIRECTIONS = ["in", "out"] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];

/** Roles that resolve / close a ticket without needing an extra permission. */
export const DEFAULT_TICKET_NUMBER_PATTERN = "{PREFIX}-{YYYY}-{MM}-{DD}-{SEQ:3}";
export const DEFAULT_TICKET_PREFIX = "DSI";

/** Business timezone. Ticket numbering and SLA both key off this. */
export const APP_TIMEZONE = "Asia/Manila";
export const APP_TIMEZONE_LABEL = "Asia/Manila (UTC+8, no DST)";