import "server-only";
import { connectDB } from "../db/supabase";
import { getSettings } from "./settings";
import { appDateKey, appParts } from "../shared/time";
import type { SettingsShape } from "./settings";

export const DEFAULT_PAD = 3;

/** Reserved counter key used when sequences must not reset daily. */
export const GLOBAL_COUNTER_KEY = "GLOBAL";

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

/** The numbering rule used when Settings has none stored. */
const DEFAULT_PATTERN = "{PREFIX}-{YYYY}-{MM}-{DD}-{SEQ:3}";

/**
 * Builds a LIKE filter and a regex that together isolate the `{SEQ}` digits of
 * the ticket numbers belonging to the current counter bucket.
 *
 * `tickets` predates the counter, so the highest number already in the table has
 * to be discovered from the numbers themselves (the same token-to-pattern trick
 * `extractTicketNumber` uses for email subjects). In a per-day bucket the date
 * tokens pin the match to today; in the shared bucket the sequence runs across
 * every date, so those tokens become wildcards.
 */
function seqMatchers(cfg: SettingsShape): { like: string; regex: RegExp } | null {
  const pattern = cfg.ticketNumberPattern || DEFAULT_PATTERN;
  if (!hasSequenceToken(pattern)) return null;

  const parts = appParts();
  const escapeLike = (value: string) => value.replace(/[\\%_]/g, (m) => `\\${m}`);
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let like = "";
  let source = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  const tokenRe = /\{(PREFIX|YYYY|YY|MM|DD|SEQ)(?::(\d+))?\}/gi;
  while ((match = tokenRe.exec(pattern)) !== null) {
    const literal = pattern.slice(cursor, match.index);
    like += escapeLike(literal);
    source += escapeRegex(literal);
    cursor = match.index + match[0].length;

    switch (match[1].toUpperCase()) {
      case "PREFIX":
        like += escapeLike(cfg.ticketPrefix);
        source += escapeRegex(cfg.ticketPrefix);
        break;
      case "YYYY":
        like += cfg.resetSeqPerDay ? String(parts.year) : "%";
        source += "[0-9]{4}";
        break;
      case "YY":
        like += cfg.resetSeqPerDay ? parts.year2 : "%";
        source += "[0-9]{2}";
        break;
      case "MM":
        like += cfg.resetSeqPerDay ? parts.month : "%";
        source += "[0-9]{2}";
        break;
      case "DD":
        like += cfg.resetSeqPerDay ? parts.day : "%";
        source += "[0-9]{2}";
        break;
      case "SEQ":
        like += "%";
        // Captured, because the sequence is the value the counter has to clear.
        source += "([0-9]+)";
        break;
    }
  }

  const tail = pattern.slice(cursor);
  like += escapeLike(tail);
  source += escapeRegex(tail);

  return { like, regex: new RegExp(`^${source}$`) };
}

/**
 * Highest sequence already stored in `tickets` for the current bucket, or 0 when
 * nothing matches yet.
 *
 * This is what lets numbering start above the legacy rows: the counter table was
 * introduced with this migration, so on a database that already holds tickets it
 * begins at zero and would hand out numbers the `tickets_ticket_id_key` unique
 * index has already seen.
 */
async function highestIssuedSequence(cfg: SettingsShape): Promise<number> {
  const matchers = seqMatchers(cfg);
  if (!matchers) return 0;

  try {
    const supabase = await connectDB();
    // Descending order means the row cap cannot hide the answer: with a
    // fixed-width sequence the largest value also sorts first.
    const { data, error } = await supabase
      .from("tickets")
      .select("ticket_id")
      .like("ticket_id", matchers.like)
      .order("ticket_id", { ascending: false })
      .limit(1000);
    if (error) throw error;

    let highest = 0;
    for (const row of data ?? []) {
      const match = matchers.regex.exec(String((row as Record<string, unknown>).ticket_id ?? ""));
      const seq = match ? Number(match[1]) : NaN;
      if (Number.isFinite(seq) && seq > highest) highest = seq;
    }
    return highest;
  } catch (error) {
    // Best-effort repair: never block ticket creation on this lookup. If the
    // read fails here the insert it guards would fail too, so the caller still
    // gets a clear error rather than a silent duplicate.
    console.error("[ticket-number] could not read the highest issued number:", error);
    return 0;
  }
}

/**
 * Lifts the counter to `floor` when it is behind it.
 *
 * The update is guarded by `seq < floor`, which makes it atomic: a reservation
 * that has already advanced the counter past `floor` is never dragged backwards,
 * so a stale read is harmless.
 */
async function reconcileCounter(dateKey: string, floor: number): Promise<void> {
  if (floor <= 0) return;

  try {
    const supabase = await connectDB();
    const { data, error } = await supabase
      .from("ticket_counters")
      .update({ seq: floor, updated_at: new Date().toISOString() })
      .eq("date_key", dateKey)
      .lt("seq", floor)
      .select("date_key");
    if (error) throw error;
    if (data && data.length > 0) return;

    // `ignoreDuplicates` covers the remaining cases in one safe step: the bucket
    // has no row yet (created at the floor) or the counter is already at or
    // above it (left untouched).
    const { error: upsertError } = await supabase
      .from("ticket_counters")
      .upsert(
        { date_key: dateKey, seq: floor, updated_at: new Date().toISOString() },
        { onConflict: "date_key", ignoreDuplicates: true },
      );
    if (upsertError) throw upsertError;
  } catch (error) {
    console.error("[ticket-number] could not reconcile the counter:", error);
  }
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
 * The increment happens inside the `next_ticket_seq()` SQL function
 * (`insert ... on conflict (date_key) do update set seq = seq + 1 returning`),
 * which is the only safe way to do this: two parallel requests that read then
 * wrote would collide and hand out the same number.
 *
 * Before reserving, the counter is lifted to the highest number already in
 * `tickets` for this bucket. Numbering must therefore know which ids are taken,
 * otherwise a database that received tickets before the counter existed would
 * be handed a number the `tickets_ticket_id_key` unique index already holds.
 */
export async function nextSequence(settings?: SettingsShape): Promise<{
  seq: number;
  dateKey: string;
  patternVersion: number;
}> {
  const cfg = settings ?? (await getSettings());
  const dateKey = cfg.resetSeqPerDay ? appDateKey() : GLOBAL_COUNTER_KEY;

  const highest = await highestIssuedSequence(cfg);
  await reconcileCounter(dateKey, highest);

  const supabase = await connectDB();
  const { data, error } = await supabase.rpc("next_ticket_seq", { p_date_key: dateKey });
  if (error) throw error;

  return { seq: Number(data ?? 1), dateKey, patternVersion: cfg.patternVersion };
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
    const supabase = await connectDB();
    const { data } = await supabase
      .from("ticket_counters")
      .select("seq")
      .eq("date_key", dateKey)
      .maybeSingle();
    currentSeq = Number(data?.seq ?? 0);
  } catch {
    currentSeq = 0;
  }

  // The counter alone can lag behind the numbers already issued, so the preview
  // reports the same floor `nextSequence` would reconcile to. Otherwise the
  // badge would promise a number the create call refuses to hand out.
  const highest = await highestIssuedSequence(cfg);
  if (highest > currentSeq) currentSeq = highest;

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
