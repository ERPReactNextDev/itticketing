import "server-only";
import { CLOSED_STATUS_VALUES, PAUSED_STATUS_VALUES } from "../shared/constants";

export type SlaState = {
  dueAt: Date | null;
  remainingSeconds: number | null;
  /** Fraction of the budget consumed, 0..1+. */
  consumedRatio: number | null;
  /** true once remaining <= 0 and the ticket is still open. */
  breached: boolean;
  /** Approaching: under 25% of the budget left. */
  warning: boolean;
  paused: boolean;
};

export type SlaInput = {
  slaDueAt: Date | string | null;
  slaPausedTotalSeconds?: number | null;
  slaPausedAt?: Date | string | null;
  priority?: { slaHours?: number | null } | null;
  status?: string | null;
  dateCreated?: Date | string | null;
};

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Seconds the clock has been frozen right now (only meaningful while paused).
 */
function livePauseSeconds(pausedAt: Date | null): number {
  if (!pausedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - pausedAt.getTime()) / 1000));
}

/**
 * Computes live SLA state.
 *
 * `slaDueAt` is stored as the original deadline. When "pause on Scheduled" is
 * on, a ticket that entered Scheduled accumulates frozen seconds and the
 * effective deadline is pushed forward by that total - so the stored due date
 * stays a stable fact while the *remaining* time reflects the pause.
 */
export function computeSla(ticket: SlaInput): SlaState {
  const status = (ticket.status ?? "").toLowerCase();
  const isClosed = CLOSED_STATUS_VALUES.includes(status);
  const paused = PAUSED_STATUS_VALUES.includes(status) && !isClosed;

  const dueAt = toDate(ticket.slaDueAt);
  if (!dueAt) {
    return {
      dueAt: null,
      remainingSeconds: null,
      consumedRatio: null,
      breached: false,
      warning: false,
      paused,
    };
  }

  const totalPaused =
    Math.max(0, Number(ticket.slaPausedTotalSeconds ?? 0)) +
    (paused ? livePauseSeconds(toDate(ticket.slaPausedAt)) : 0);

  const effectiveDue = dueAt.getTime() + totalPaused * 1000;

  if (isClosed) {
    const remaining = Math.floor((effectiveDue - Date.now()) / 1000);
    return {
      dueAt: dueAt,
      remainingSeconds: remaining,
      consumedRatio: consumedRatio(ticket, totalPaused, effectiveDue),
      breached: false,
      warning: false,
      paused: false,
    };
  }

  const remainingSeconds = Math.floor((effectiveDue - Date.now()) / 1000);
  const ratio = consumedRatio(ticket, totalPaused, effectiveDue);

  return {
    dueAt: dueAt,
    remainingSeconds,
    consumedRatio: ratio,
    breached: remainingSeconds <= 0,
    warning: remainingSeconds > 0 && ratio !== null && ratio >= 0.75,
    paused,
  };
}

function consumedRatio(
  ticket: SlaInput,
  totalPaused: number,
  effectiveDue: number,
): number | null {
  const hours = Number(ticket.priority?.slaHours ?? 0);
  if (!hours || hours <= 0) return null;
  const created = toDate(ticket.dateCreated);
  if (!created) return null;

  const budgetSeconds = hours * 3600;
  // Elapsed wall time, minus the frozen portion.
  const elapsed = Math.max(0, Math.floor((Date.now() - created.getTime()) / 1000)) - totalPaused;
  return elapsed / budgetSeconds;
}

/** Fraction of the SLA budget remaining, 0..1. Used for the list progress bars. */
export function slaRemainingRatio(state: SlaState): number | null {
  if (state.consumedRatio === null) return null;
  return Math.max(0, 1 - state.consumedRatio);
}

/**
 * Colour banding shared by the list view, dashboard and ticket detail so the
 * same ticket never looks like two different severities.
 */
export function slaBand(state: SlaState): "breached" | "critical" | "warning" | "ok" | "none" {
  if (state.breached) return "breached";
  if (state.paused) return "none";
  const remaining = state.remainingSeconds;
  if (remaining === null) return "none";
  if (state.warning) return "warning";
  if (remaining <= 3600) return "critical";
  return "ok";
}

export const SLA_BAND_STYLES: Record<
  ReturnType<typeof slaBand>,
  { label: string; text: string; badge: string; bar: string }
> = {
  breached: {
    label: "Breached",
    text: "text-red-600",
    badge: "bg-red-50 text-red-700 border-red-200",
    bar: "bg-red-500",
  },
  critical: {
    label: "< 1h left",
    text: "text-orange-600",
    badge: "bg-orange-50 text-orange-700 border-orange-200",
    bar: "bg-orange-500",
  },
  warning: {
    label: "< 25% left",
    text: "text-amber-600",
    badge: "bg-amber-50 text-amber-700 border-amber-200",
    bar: "bg-amber-400",
  },
  ok: {
    label: "On track",
    text: "text-emerald-600",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
    bar: "bg-emerald-500",
  },
  none: {
    label: "No SLA",
    text: "text-gray-400",
    badge: "bg-gray-50 text-gray-500 border-gray-200",
    bar: "bg-gray-300",
  },
};

/**
 * SLA hours for a priority, preferring the per-priority override in settings
 * and falling back to the priority dropdown's own `slaHours`.
 */
export function resolveSlaHours(
  priorityValue: string,
  dropdownSlaHours: number | undefined,
  settingsSlaDefaults: Record<string, number>,
): number {
  const override = settingsSlaDefaults?.[priorityValue];
  if (typeof override === "number" && override > 0) return override;
  if (typeof dropdownSlaHours === "number" && dropdownSlaHours > 0) return dropdownSlaHours;
  return 24;
}

export function computeDueAt(slaHours: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + slaHours * 3600 * 1000);
}
