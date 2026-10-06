import "server-only";
import { connectDB } from "../db/mongoose";
import { User, DropdownOption, Ticket } from "../models";
import { buildFullName } from "../models/requestor";
import type { AuthUser } from "../auth/session";
import { CLOSED_STATUS_VALUES, PAUSED_STATUS_VALUES, type DropdownType } from "../shared/constants";
import { getSettings } from "./settings";
import { computeDueAt, resolveSlaHours } from "./sla";

export type PriorityValue = {
  label: string;
  value: string;
  slaHours: number;
  color: string;
  inactive?: boolean;
};

/**
 * Looks up an active dropdown option.
 *
 * Falls back to a synthetic option when the row is missing or deactivated:
 * tickets must keep rendering historical values even after an option is
 * deactivated in Configuration.
 */
export async function resolveDropdownValue(
  type: DropdownType,
  value: string,
): Promise<{ label: string; value: string; slaHours?: number; color?: string; inactive: boolean } | null> {
  if (!value) return null;
  await connectDB();
  const doc = await DropdownOption.findOne({ type, value }).lean<{
    label: string;
    value: string;
    slaHours?: number;
    color?: string;
    active: boolean;
  }>();
  if (!doc) return { label: value, value, inactive: true };
  return {
    label: doc.label,
    value: doc.value,
    slaHours: doc.slaHours,
    color: doc.color,
    inactive: doc.active !== true,
  };
}

/**
 * Resolves the ticket's priority, preferring an explicit override from the
 * payload, then the dropdown, then a sane fallback so creation never fails on
 * an empty priority table.
 */
export async function resolvePriority(
  input: string | undefined | null,
  settingsSlaDefaults: Record<string, number>,
): Promise<PriorityValue> {
  await connectDB();

  if (input) {
    const option = await DropdownOption.findOne({ type: "priority", value: input }).lean<{
      label: string;
      value: string;
      slaHours?: number;
      color?: string;
      active: boolean;
    }>();
    if (option) {
      return {
        label: option.label,
        value: option.value,
        slaHours: resolveSlaHours(option.value, option.slaHours, settingsSlaDefaults),
        color: option.color ?? "#ef4444",
        inactive: option.active !== true,
      };
    }
    // Unknown value (e.g. a legacy ticket) - treat it as a real priority.
    return {
      label: input,
      value: input,
      slaHours: resolveSlaHours(input, undefined, settingsSlaDefaults),
      color: "#eab308",
    };
  }

  // No priority given: default to the lowest-SLA active option, else P-3.
  const fallback = await DropdownOption.findOne({ type: "priority", active: true })
    .sort({ slaHours: 1 })
    .lean<{ label: string; value: string; slaHours?: number; color?: string }>();

  if (fallback) {
    return {
      label: fallback.label,
      value: fallback.value,
      slaHours: resolveSlaHours(fallback.value, fallback.slaHours, settingsSlaDefaults),
      color: fallback.color ?? "#eab308",
    };
  }

  return { label: "P-3 - Medium", value: "p-3-medium", slaHours: 24, color: "#eab308" };
}

/**
 * Resolves a dropdown-backed field to its stored **value** (slug).
 *
 * Callers may pass either a value (`"email"`) or a label (`"Email"`). Accepting
 * both matters because email intake configures defaults by label while the UI
 * submits values, and storing a label would stop matching its own option.
 * Returns an empty string when nothing is supplied, or the raw input when it
 * cannot be resolved (a legacy value must survive untouched).
 */
export async function resolveDropdownField(
  type: DropdownType,
  input?: string | null,
): Promise<string> {
  const raw = (input ?? "").trim();
  if (!raw) return "";

  await connectDB();
  const option = await DropdownOption.findOne({
    type,
    $or: [{ value: raw }, { label: raw }],
  }).lean<{ value: string }>();

  return option?.value ?? raw;
}

/** Default status for a new ticket: the first active status option. */
export async function resolveInitialStatus(preferred?: string): Promise<string> {
  if (preferred) return preferred;
  await connectDB();
  const first = await DropdownOption.findOne({ type: "status", active: true })
    .sort({ order: 1 })
    .lean<{ value: string }>();
  if (first) return first.value;
  return "pending";
}

export function isClosedStatus(status: string | null | undefined): boolean {
  return CLOSED_STATUS_VALUES.includes((status ?? "").toLowerCase());
}

export function isPausedStatus(status: string | null | undefined): boolean {
  return PAUSED_STATUS_VALUES.includes((status ?? "").toLowerCase());
}

/**
 * Default technician for a new ticket, per `defaultTechnicianAssignment`.
 *
 *  - self        -> the creator (also `processedBy`)
 *  - unassigned  -> nobody, to be triaged
 *  - round-robin -> least-loaded active agent with `assignTechnician`
 */
export async function resolveDefaultTechnician(
  creator: AuthUser | null,
  mode: "self" | "round-robin" | "unassigned",
): Promise<ObjectIdLike | null> {
  if (mode === "unassigned") return null;
  if (mode === "self") return creator ? (creator.id as ObjectIdLike) : null;

  await connectDB();
  const agents = await User.find({
    status: "active",
    role: { $in: await roleIdsWithPermission("assignTechnician") },
  })
    .select("_id")
    .lean<{ _id: ObjectIdLike }[]>();

  if (agents.length === 0) return null;

  // Count open tickets per agent and give the next one to the lightest load.
  const counts = await Ticket.aggregate<{ _id: ObjectIdLike; count: number }>([
    { $match: { technician: { $in: agents.map((a) => a._id) }, status: { $nin: CLOSED_STATUS_VALUES } } },
    { $group: { _id: "$technician", count: { $sum: 1 } } },
  ]);

  const load = new Map(counts.map((c) => [String(c._id), c.count]));
  let best = agents[0];
  let bestLoad = load.get(String(best._id)) ?? 0;
  for (const agent of agents.slice(1)) {
    const agentLoad = load.get(String(agent._id)) ?? 0;
    // Ties break on _id so assignment is deterministic, not random.
    if (agentLoad < bestLoad || (agentLoad === bestLoad && String(agent._id) < String(best._id))) {
      best = agent;
      bestLoad = agentLoad;
    }
  }
  return best._id;
}

type ObjectIdLike = string;

/** Role ids that hold a given permission. */
export async function roleIdsWithPermission(permission: string): Promise<string[]> {
  await connectDB();
  const { Role } = await import("../models");
  const roles = await Role.find({ [`permissions.${permission}`]: true })
    .select("_id")
    .lean<{ _id: ObjectIdLike }[]>();
  return roles.map((role) => String(role._id));
}

export type Actor = {
  id: string | null;
  name: string;
};

/** Normalises an authenticated user or a system actor into a remark author. */
export function toActor(user: AuthUser | null | undefined): Actor {
  if (!user) return { id: null, name: "System" };
  return { id: user.id, name: user.name || user.email };
}

/** Builds the immutable requestor snapshot stored on every ticket. */
export function buildRequestorSnapshot(requestor: {
  employeeId?: string;
  fullName?: string;
  email?: string;
  department?: string;
  site?: string;
  phone?: string;
} | null) {
  if (!requestor) {
    return {
      employeeId: "",
      fullName: "",
      email: "",
      department: "",
      site: "",
      phone: "",
    };
  }
  return {
    employeeId: requestor.employeeId ?? "",
    fullName: requestor.fullName ?? "",
    email: requestor.email ?? "",
    department: requestor.department ?? "",
    site: requestor.site ?? "",
    phone: requestor.phone ?? "",
  };
}

export { buildFullName, computeDueAt, getSettings };