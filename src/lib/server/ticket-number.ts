import "server-only";
import { connectDB } from "../db/mongoose";
import { TicketCounter, GLOBAL_COUNTER_KEY } from "../models/ticket-counter";
import { getSettings } from "./settings";
import { appDateKey, appParts } from "../shared/time";
import type { SettingsShape } from "./settings";

export const DEFAULT_PAD = 3;

/**
 * Expands a ticket-number pattern into a concrete number.
 *
 * Supported tokens:
 *   {PREFIX}    configured ticket prefix
 *   {YYYY}      4-digit business-local year
 *   {YY}        2-digit business-local year
 *   {MM}        2-digit month
 *   {DD}        2-digit day
 *   {SEQ}       zero-padded to seqPadLength
 *   {SEQ:N}     zero-padded to exactly N digits
 *
 * Anything else is a literal. Invalid patterns fall back to the default so a
 * typo in Settings can never break ticket creation.
 */
export function renderTicketNumber(
  pattern: string,
  prefix: string,
  seq: number,
  date: Date = new Date(),
  fallbackPad = DEFAULT_PAD,
): string {
  const parts = appParts(date);
  const seqStr = String(seq);
  const year = String(parts.year);
  const year2 = String(parts.year2);

  const expanded = (pattern || "").replace(
    /\{(PREFIX|YYYY|YY|MM|DD|SEQ)(?::(\d+))?\}/gi,
    (_match, token: string, padArg: string | undefined): string => {
      switch (token.toUpperCase()) {
        case "PREFIX":
          return prefix;
        case "YYYY":
          return year;
        case "YY":
          return year2;
        case "MM":
          return parts.month;
        case "DD":
          return parts.day;
        case "SEQ": {
          const pad = padArg ? Number(padArg) : fallbackPad;
          const width = Number.isFinite(pad) && pad > 0 ? pad : fallbackPad;
          return seqStr.padStart(width, "0");
        }
        default:
          return "";
      }
    },
  );

  // A pattern with no usable tokens would produce identical numbers for every
  // ticket. Treat it as invalid and fall back to the safe default.
  if (!expanded || !/\{(PREFIX|YYYY|YY|MM|DD|SEQ)/i.test(pattern)) {
    return `${prefix}-${parts.year}-${parts.month}-${parts.day}-${seqStr.padStart(
      fallbackPad,
      "0",
    )}`;
  }

  return expanded;
}

/** Builds a sample number for the live preview in Settings. */
export function previewTicketNumber(
  pattern: string,
  prefix: string,
  seq: number,
  padLength: number,
  date: Date = new Date(),
): string {
  return renderTicketNumber(pattern || "{PREFIX}-{YYYY}-{MM}-{DD}-{SEQ:3}", prefix, seq, date, padLength);
}

/** True when the pattern contains at least one `{SEQ}` token. */
export function hasSequenceToken(pattern: string): boolean {
  return /\{SEQ(?::\d+)?\}/i.test(pattern ?? "");
}

/**
 * Extracts a ticket number out of an email subject.
 *
 * Rather than hard-coding one shape, the configured pattern is turned into a
 * regular expression by swapping each token for its value class, so changing
 * the pattern in Settings automatically changes what the inbound webhook can
 * recognise. Returns null when nothing matches.
 */
export function extractTicketNumber(subject: string, settings: SettingsShape): string | null {
  if (!subject) return null;
  const pattern = settings.ticketNumberPattern || "{PREFIX}-{YYYY}-{MM}-{DD}-{SEQ:3}";

  if (!hasSequenceToken(pattern)) return null;

  const regexSource = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "{" || m === "}" ? m : `\\${m}`))
    // Pass 1: {SEQ:N} / {SEQ} -> a bounded digit run, captured.
    .replace(/\\?\{(\w+)(?::(\d+))?\}/g, (_m, token: string, pad?: string) => {
      switch (token.toUpperCase()) {
        case "SEQ":
          return pad ? `([0-9]{${pad}})` : "([0-9]+)";
        case "YYYY":
          return "([0-9]{4})";
        case "YY":
        case "MM":
        case "DD":
          return "([0-9]{2})";
        case "PREFIX":
          return "([A-Za-z0-9._-]+)";
        default:
          return token;
      }
    });

  try {
    const re = new RegExp(regexSource, "i");
    const match = re.exec(subject);
    if (!match) return null;
    const seqGroup = match.find((group, index) => index > 0 && /^[0-9]+$/.test(group ?? ""));
    if (!seqGroup) return null;
    // Return the whole matched ticket number, not just the sequence.
    return match[0].trim();
  } catch {
    return null;
  }
}

/**
 * Atomically reserves the next sequence number.
 *
 * `$inc` with `upsert` is the only safe way to do this: two parallel requests
 * both read-then-write would collide and hand out the same number. The unique
 * index on `dateKey` means a true race surfaces as a duplicate-key error, which
 * is retried against the now-existing document.
 */
export async function nextSequence(settings?: SettingsShape): Promise<{
  seq: number;
  dateKey: string;
  patternVersion: number;
}> {
  const cfg = settings ?? (await getSettings());
  const dateKey = cfg.resetSeqPerDay ? appDateKey() : GLOBAL_COUNTER_KEY;

  await connectDB();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const doc = await TicketCounter.findOneAndUpdate(
        { dateKey },
        { $inc: { seq: 1 }, $setOnInsert: { dateKey } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean<{ seq: number }>();

      const seq = doc?.seq ?? 1;
      return { seq, dateKey, patternVersion: cfg.patternVersion };
    } catch (error) {
      // 11000 = another request inserted the same dateKey first. Re-run the
      // update, which is now a plain $inc against the existing document.
      if ((error as { code?: number })?.code === 11000) continue;
      throw error;
    }
  }

  throw new Error("Could not reserve a ticket sequence number.");
}

export type ReservedTicketNumber = {
  ticketNumber: string;
  seq: number;
  dateKey: string;
  patternVersion: number;
};

/**
 * Reserves a sequence AND renders the number.
 *
 * Number gaps are possible (a create that fails validation after reservation
 * burns a number). That is the accepted trade-off: uniqueness is guaranteed,
 * and a gap in the audit trail is far cheaper than a duplicate ticket number.
 */
export async function reserveTicketNumber(settings?: SettingsShape): Promise<ReservedTicketNumber> {
  const cfg = settings ?? (await getSettings());
  const { seq, dateKey, patternVersion } = await nextSequence(cfg);
  return {
    ticketNumber: renderTicketNumber(
      cfg.ticketNumberPattern,
      cfg.ticketPrefix,
      seq,
      new Date(),
      cfg.seqPadLength,
    ),
    seq,
    dateKey,
    patternVersion,
  };
}

/**
 * Preview helper for the Settings page: shows the number the *next* ticket
 * would get, using the current counter state when one exists.
 */
export async function previewNextTicketNumber(): Promise<{
  next: string;
  current: string;
  dateKey: string;
}> {
  const cfg = await getSettings();
  const dateKey = cfg.resetSeqPerDay ? appDateKey() : GLOBAL_COUNTER_KEY;
  let currentSeq = 0;
  try {
    await connectDB();
    const doc = await TicketCounter.findOne({ dateKey }).lean<{ seq: number }>();
    currentSeq = doc?.seq ?? 0;
  } catch {
    currentSeq = 0;
  }

  return {
    current: renderTicketNumber(
      cfg.ticketNumberPattern,
      cfg.ticketPrefix,
      currentSeq,
      new Date(),
      cfg.seqPadLength,
    ),
    next: renderTicketNumber(
      cfg.ticketNumberPattern,
      cfg.ticketPrefix,
      currentSeq + 1,
      new Date(),
      cfg.seqPadLength,
    ),
    dateKey,
  };
}