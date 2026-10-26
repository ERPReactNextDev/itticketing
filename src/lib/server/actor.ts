import "server-only";
import { connectDB } from "../db/supabase";
import { buildFullName, normalizeUserStatus } from "../db/mappers";
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

type DropdownRow = {
  label: string;
  value: string;
  sla_hours: number | null;
  color: string | null;
  active: boolean;
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
  const supabase = await connectDB();
  const { data } = await supabase
    .from("dropdown_options")
    .select("label, value, sla_hours, color, active")
    .eq("type", type)
    .eq("value", value)
    .maybeSingle<DropdownRow>();

  if (!data) return { label: value, value, inactive: true };
  return {
    label: data.label,
    value: data.value,
    slaHours: data.sla_hours ?? undefined,
    color: data.color ?? undefined,
    inactive: data.active !== true,
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
  const supabase = await connectDB();

  if (input) {
    const { data: option } = await supabase
      .from("dropdown_options")
      .select("label, value, sla_hours, color, active")
      .eq("type", "priority")
      .eq("value", input)
      .maybeSingle<DropdownRow>();

    if (option) {
      return {
        label: option.label,
        value: option.value,
        slaHours: resolveSlaHours(option.value, option.sla_hours ?? undefined, settingsSlaDefaults),
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
  const { data: fallback } = await supabase
    .from("dropdown_options")
    .select("label, value, sla_hours, color, active")
    .eq("type", "priority")
    .eq("active", true)
    .order("sla_hours", { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle<DropdownRow>();

  if (fallback) {
    return {
      label: fallback.label,
      value: fallback.value,
      slaHours: resolveSlaHours(fallback.value, fallback.sla_hours ?? undefined, settingsSlaDefaults),
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

  const supabase = await connectDB();
  // Double-quoting makes PostgREST treat the value literally, so a label that
  // contains a comma or parenthesis cannot break the filter expression.
  const literal = raw.replace(/"/g, '\\"');
  const { data } = await supabase
    .from("dropdown_options")
    .select("value")
    .eq("type", type)
    .or(`value.eq."${literal}",label.eq."${literal}"`)
    .maybeSingle<{ value: string }>();

  return data?.value ?? raw;
}

/** Default status for a new ticket: the first active status option. */
export async function resolveInitialStatus(preferred?: string): Promise<string> {
  if (preferred) return preferred;
  const supabase = await connectDB();
  const { data } = await supabase
    .from("dropdown_options")
    .select("value")
    .eq("type", "status")
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle<{ value: string }>();
  if (data) return data.value;
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
): Promise<string | null> {
  if (mode === "unassigned") return null;
  if (mode === "self") return creator ? creator.id : null;

  const supabase = await connectDB();
  const roleIds = await roleIdsWithPermission("assignTechnician");
  if (roleIds.length === 0) return null;

  // The legacy `Status` column is free-form, so the active check happens in JS
  // via the same normaliser the rest of the app uses, rather than a brittle
  // case-sensitive SQL equality.
  const { data } = await supabase
    .from("users")
    .select("id, Status")
    .in("role_id", roleIds.map(Number));

  const agents = (data ?? [])
    .filter((row) => normalizeUserStatus(row.Status) === "active")
    .map((row) => String(row.id))
    .sort();

  if (agents.length === 0) return null;

  // Open-ticket load per technician, counted in one aggregate query.
  const { data: counts } = await supabase.rpc("ticket_counts_by_technician");
  const load = new Map<string, number>(
    ((counts ?? []) as Array<{ technician_id: string; open_count: number }>).map((row) => [
      String(row.technician_id),
      Number(row.open_count ?? 0),
    ]),
  );

  let best = agents[0];
  let bestLoad = load.get(best) ?? 0;
  for (const agent of agents.slice(1)) {
    const agentLoad = load.get(agent) ?? 0;
    // Ties break on id so assignment is deterministic, not random.
    if (agentLoad < bestLoad || (agentLoad === bestLoad && agent < best)) {
      best = agent;
      bestLoad = agentLoad;
    }
  }
  return best;
}

/** Role ids that hold a given permission. */
export async function roleIdsWithPermission(permission: string): Promise<string[]> {
  const supabase = await connectDB();
  // jsonb containment: permissions @> '{"assignTechnician": true}'.
  const { data } = await supabase
    .from("roles")
    .select("id")
    .contains("permissions", { [permission]: true });
  return (data ?? []).map((role) => String(role.id));
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
