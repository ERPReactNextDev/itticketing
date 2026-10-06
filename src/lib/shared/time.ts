import { APP_TIMEZONE } from "./constants";

/**
 * Asia/Manila is permanently UTC+8 and has never observed DST, so a fixed
 * offset is exact here (unlike America/New_York, where it would not be).
 * If the business timezone ever changes, this must become a real tz lookup.
 */
export const APP_UTC_OFFSET_HOURS = 8;
const APP_UTC_OFFSET_MS = APP_UTC_OFFSET_HOURS * 60 * 60 * 1000;

/** Wall-clock parts of `date` as observed in the business timezone. */
export function appParts(date: Date = new Date()) {
  const shifted = new Date(date.getTime() + APP_UTC_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    year2: String(shifted.getUTCFullYear()).slice(-2),
    month: String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    day: String(shifted.getUTCDate()).padStart(2, "0"),
    hour: String(shifted.getUTCHours()).padStart(2, "0"),
    minute: String(shifted.getUTCMinutes()).padStart(2, "0"),
    second: String(shifted.getUTCSeconds()).padStart(2, "0"),
    /** `YYYY-MM-DD` in business-local time - the ticket counter key. */
    dateKey: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
  };
}

/** `YYYY-MM-DD` in Asia/Manila. Ticket sequences reset on this boundary. */
export function appDateKey(date: Date = new Date()): string {
  return appParts(date).dateKey;
}

/** Human readable business-local timestamp, e.g. `06 Oct 2026, 3:42 PM`. */
export function formatAppDateTime(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "-";
  const p = appParts(d);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const h12 = Number(p.hour) % 12 || 12;
  const ampm = Number(p.hour) < 12 ? "AM" : "PM";
  return `${p.day} ${months[Number(p.month) - 1]} ${p.year}, ${h12}:${p.minute} ${ampm}`;
}

/** Compact business-local time, e.g. `3:42 PM`. */
export function formatAppTime(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "-";
  const p = appParts(d);
  const h12 = Number(p.hour) % 12 || 12;
  return `${h12}:${p.minute} ${Number(p.hour) < 12 ? "AM" : "PM"}`;
}

/** Business-local `YYYY-MM-DD` used by date inputs. */
export function toDateInputValue(date: Date | string | number | null | undefined): string {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return appParts(d).dateKey;
}

/** Midnight business-local on the given day -> UTC Date. */
export function fromDateInputValue(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0) - APP_UTC_OFFSET_MS,
  );
}

/** Human duration from seconds: `2d 3h 4m` / `3h 42m` / `12s`. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export { APP_TIMEZONE };