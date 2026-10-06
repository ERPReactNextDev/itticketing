import { connectDB } from "../db/mongoose";
import User from "./user";
import Requestor from "./requestor";
import Role from "./role";
import Ticket from "./ticket";
import TicketCounter from "./ticket-counter";
import DropdownOption from "./dropdown-option";
import SystemSetting from "./system-setting";
import EmailMessage from "./email-message";
import AuditLog from "./audit-log";
import RateLimit from "./rate-limit";

export {
  User,
  Requestor,
  Role,
  Ticket,
  TicketCounter,
  DropdownOption,
  SystemSetting,
  EmailMessage,
  AuditLog,
  RateLimit,
};

export type { UserAttrs, PublicUser } from "./user";
export type { RequestorAttrs } from "./requestor";
export { buildFullName } from "./requestor";
export type { RoleAttrs } from "./role";
export type { TicketAttrs, TicketDoc } from "./ticket";
export type { DropdownOptionAttrs } from "./dropdown-option";
export type { SystemSettingAttrs } from "./system-setting";
export type { EmailMessageAttrs } from "./email-message";
export type { AuditLogAttrs } from "./audit-log";

/**
 * Builds every index the app depends on.
 *
 * Mongoose creates indexes on model compilation in dev, but with
 * `autoIndex: false` in production it never runs. Calling this from the seed
 * script and on first boot makes the acceptance criteria ("all indexes exist")
 * verifiable instead of assumed.
 */
export async function ensureIndexes(): Promise<void> {
  await connectDB();
  await Promise.all([
    User.syncIndexes(),
    Requestor.syncIndexes(),
    Role.syncIndexes(),
    Ticket.syncIndexes(),
    TicketCounter.syncIndexes(),
    DropdownOption.syncIndexes(),
    SystemSetting.syncIndexes(),
    EmailMessage.syncIndexes(),
    AuditLog.syncIndexes(),
    RateLimit.syncIndexes(),
  ]);
}