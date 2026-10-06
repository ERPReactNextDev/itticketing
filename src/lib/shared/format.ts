/**
 * Client-safe formatting helpers.
 *
 * Kept separate from `lib/shared/time.ts`, which imports Node-only helpers, so
 * these can be used inside client components.
 */

const APP_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Business-local (Asia/Manila) parts for a date. */
function parts(date: Date) {
  const shifted = new Date(date.getTime() + APP_UTC_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    year2: String(shifted.getUTCFullYear()).slice(-2),
    month: String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    day: String(shifted.getUTCDate()).padStart(2, "0"),
    hour: Number(shifted.getUTCHours()),
    minute: shifted.getUTCMinutes(),
    dateKey: shifted.toISOString().slice(0, 10),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const p = parts(date);
  const h12 = p.hour % 12 || 12;
  const ampm = p.hour < 12 ? "AM" : "PM";
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${h12}:${String(p.minute).padStart(2, "0")} ${ampm}`;
}

export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const p = parts(date);
  const h12 = p.hour % 12 || 12;
  return `${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "AM" : "PM"}`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const p = parts(date);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
}

/** `2d 3h 4m` / `3h 42m` / `12s`. Input may be negative. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) return "—";
  const negative = totalSeconds < 0;
  const s = Math.abs(Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const body = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  return negative ? `${body} over` : body;
}

/** Relative age, e.g. `just now`, `12m ago`, `3d ago`. */
export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(date);
}

/** `YYYY-MM-DD` in business-local time, for `<input type="date">`. */
export function toDateInputValue(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return parts(date).dateKey;
}

/** Parses a business-local `YYYY-MM-DD` into a UTC Date at local midnight. */
export function fromDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0) - APP_UTC_OFFSET_MS,
  );
}