import "server-only";
import { connectDB, DB_NAME, unwrap } from "../db/supabase";
import { mapSettingsRow, settingsFieldsToRow } from "../db/mappers";
import type { PermissionSet } from "../shared/permissions";
import { normalizePermissions } from "../shared/permissions";

const SETTINGS_ID = "singleton";

/**
 * Settings are read on nearly every request (rate limits, numbering, SLA), so
 * they are cached in-process for a few seconds. The TTL is deliberately short
 * so a SuperAdmin edit propagates almost immediately without hitting Postgres
 * on every API call, and without needing a redeploy.
 */
const CACHE_TTL_MS = 3000;

type Cached = { value: SettingsShape; expiresAt: number };

const globalCache = globalThis as unknown as {
  __itTicketingSettings?: Cached | null;
};

export type RateLimitSettings = {
  loginWindowMin: number;
  loginMaxAttempts: number;
  loginLockAfterFails: number;
  ticketCreateWindowMin: number;
  ticketCreateMax: number;
  ticketCreateMaxUnauthenticated: number;
  globalPerMin: number;
  webhookPerMin: number;
};

export type EmailSettings = {
  autoTicketPriority: string;
  autoTicketStatus: string;
  autoTicketMode: string;
  autoTicketServicesGroup: string;
  sendAutoAcknowledgement: boolean;
  notifyTechnicianOnInbound: boolean;
};

export type SettingsShape = {
  ticketNumberPattern: string;
  ticketPrefix: string;
  dateFormatInNumber: string;
  seqPadLength: number;
  resetSeqPerDay: boolean;
  patternVersion: number;
  resendFromEmail: string;
  inboundEmail: string;
  rateLimits: RateLimitSettings;
  slaDefaults: Record<string, number>;
  pauseSlaOnScheduled: boolean;
  defaultTechnicianAssignment: "self" | "round-robin" | "unassigned";
  sessionTimeoutMin: number;
  email: EmailSettings;
  resendInboundSecret: string;
};

/** Hardcoded fallbacks used before the singleton document has ever been written. */
export const FALLBACK_SETTINGS: SettingsShape = {
  ticketNumberPattern: "{PREFIX}-{YYYY}-{MM}-{DD}-{SEQ:3}",
  ticketPrefix: "DSI",
  dateFormatInNumber: "YYYY-MM-DD",
  seqPadLength: 3,
  resetSeqPerDay: true,
  patternVersion: 1,
  resendFromEmail: process.env.EMAIL_FROM ?? "",
  inboundEmail: process.env.INBOUND_EMAIL ?? "",
  rateLimits: {
    loginWindowMin: 15,
    loginMaxAttempts: 5,
    loginLockAfterFails: 10,
    ticketCreateWindowMin: 60,
    ticketCreateMax: 10,
    ticketCreateMaxUnauthenticated: 3,
    globalPerMin: 100,
    webhookPerMin: 600,
  },
  slaDefaults: {},
  pauseSlaOnScheduled: true,
  defaultTechnicianAssignment: "self",
  sessionTimeoutMin: 480,
  email: {
    autoTicketPriority: "",
    autoTicketStatus: "Pending",
    autoTicketMode: "Email",
    autoTicketServicesGroup: "",
    sendAutoAcknowledgement: true,
    notifyTechnicianOnInbound: true,
  },
  resendInboundSecret: process.env.RESEND_INBOUND_SECRET ?? "",
};

/**
 * Environment acts as the default source of truth; the singleton document
 * overrides it once SuperAdmin saves. That keeps a fresh deployment working
 * from `.env` alone while still allowing runtime edits.
 */
function envSettings(): Partial<SettingsShape> {
  const out: Partial<SettingsShape> = {};
  if (process.env.EMAIL_FROM) out.resendFromEmail = process.env.EMAIL_FROM;
  if (process.env.INBOUND_EMAIL) out.inboundEmail = process.env.INBOUND_EMAIL;
  if (process.env.RESEND_INBOUND_SECRET) {
    out.resendInboundSecret = process.env.RESEND_INBOUND_SECRET;
  }
  if (process.env.TICKET_PREFIX) out.ticketPrefix = process.env.TICKET_PREFIX;
  if (process.env.TICKET_NUMBER_PATTERN) {
    out.ticketNumberPattern = process.env.TICKET_NUMBER_PATTERN;
  }
  return out;
}

/** Coerces a raw Mongo document into a fully-populated, typed settings object. */
export function normalizeSettings(raw: Record<string, unknown> | null): SettingsShape {
  const base: SettingsShape = structuredClone(FALLBACK_SETTINGS);
  if (!raw) return { ...base, ...envSettings() };

  const rl = (raw.rateLimits ?? {}) as Record<string, unknown>;
  const email = (raw.email ?? {}) as Record<string, unknown>;

  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const bool = (v: unknown, fallback: boolean) =>
    typeof v === "boolean" ? v : fallback;

  // slaDefaults is a free-form object (priority -> hours) stored as JSONB.
  const slaDefaults: Record<string, number> = {};
  const rawSla = raw.slaDefaults;
  if (rawSla instanceof Map) {
    for (const [k, v] of rawSla) slaDefaults[String(k)] = Number(v);
  } else if (rawSla && typeof rawSla === "object") {
    for (const [k, v] of Object.entries(rawSla as Record<string, unknown>)) {
      slaDefaults[String(k)] = Number(v);
    }
  }

  const merged: SettingsShape = {
    ticketNumberPattern: String(raw.ticketNumberPattern ?? base.ticketNumberPattern),
    ticketPrefix: String(raw.ticketPrefix ?? base.ticketPrefix),
    dateFormatInNumber: String(raw.dateFormatInNumber ?? base.dateFormatInNumber),
    seqPadLength: num(raw.seqPadLength, base.seqPadLength),
    resetSeqPerDay: bool(raw.resetSeqPerDay, base.resetSeqPerDay),
    patternVersion: num(raw.patternVersion, base.patternVersion),
    resendFromEmail: String(raw.resendFromEmail ?? base.resendFromEmail),
    inboundEmail: String(raw.inboundEmail ?? base.inboundEmail),
    rateLimits: {
      loginWindowMin: num(rl.loginWindowMin, base.rateLimits.loginWindowMin),
      loginMaxAttempts: num(rl.loginMaxAttempts, base.rateLimits.loginMaxAttempts),
      loginLockAfterFails: num(rl.loginLockAfterFails, base.rateLimits.loginLockAfterFails),
      ticketCreateWindowMin: num(rl.ticketCreateWindowMin, base.rateLimits.ticketCreateWindowMin),
      ticketCreateMax: num(rl.ticketCreateMax, base.rateLimits.ticketCreateMax),
      ticketCreateMaxUnauthenticated: num(
        rl.ticketCreateMaxUnauthenticated,
        base.rateLimits.ticketCreateMaxUnauthenticated,
      ),
      globalPerMin: num(rl.globalPerMin, base.rateLimits.globalPerMin),
      webhookPerMin: num(rl.webhookPerMin, base.rateLimits.webhookPerMin),
    },
    slaDefaults,
    pauseSlaOnScheduled: bool(raw.pauseSlaOnScheduled, base.pauseSlaOnScheduled),
    defaultTechnicianAssignment:
      raw.defaultTechnicianAssignment === "round-robin" ||
      raw.defaultTechnicianAssignment === "unassigned"
        ? raw.defaultTechnicianAssignment
        : base.defaultTechnicianAssignment,
    sessionTimeoutMin: num(raw.sessionTimeoutMin, base.sessionTimeoutMin),
    email: {
      autoTicketPriority: String(email.autoTicketPriority ?? base.email.autoTicketPriority),
      autoTicketStatus: String(email.autoTicketStatus ?? base.email.autoTicketStatus),
      autoTicketMode: String(email.autoTicketMode ?? base.email.autoTicketMode),
      autoTicketServicesGroup: String(
        email.autoTicketServicesGroup ?? base.email.autoTicketServicesGroup,
      ),
      sendAutoAcknowledgement: bool(
        email.sendAutoAcknowledgement,
        base.email.sendAutoAcknowledgement,
      ),
      notifyTechnicianOnInbound: bool(
        email.notifyTechnicianOnInbound,
        base.email.notifyTechnicianOnInbound,
      ),
    },
    resendInboundSecret: String(raw.resendInboundSecret ?? base.resendInboundSecret),
  };

  // Environment supplies the *default*; a value saved in Configuration wins.
  // `pickSaved` keeps the stored value when it was explicitly set (non-empty)
  // and falls back to env otherwise - so a SuperAdmin can override .env.local
  // from the UI, which is what the screen promises.
  const env = envSettings();
  const pickSaved = (saved: string, key: keyof typeof env): string => {
    const envValue = env[key];
    if (!envValue) return saved;
    if (!saved) return String(envValue);
    return saved === FALLBACK_SETTINGS[key] ? String(envValue) : saved;
  };

  return {
    ...merged,
    ...(env.ticketPrefix ? { ticketPrefix: pickSaved(merged.ticketPrefix, "ticketPrefix") } : {}),
    ...(env.ticketNumberPattern
      ? { ticketNumberPattern: pickSaved(merged.ticketNumberPattern, "ticketNumberPattern") }
      : {}),
    ...(env.resendFromEmail
      ? { resendFromEmail: pickSaved(merged.resendFromEmail, "resendFromEmail") }
      : {}),
    ...(env.inboundEmail
      ? { inboundEmail: pickSaved(merged.inboundEmail, "inboundEmail") }
      : {}),
    ...(env.resendInboundSecret
      ? { resendInboundSecret: pickSaved(merged.resendInboundSecret, "resendInboundSecret") }
      : {}),
  };
}

/** Reads the settings singleton, with a short in-process cache. */
export async function getSettings(): Promise<SettingsShape> {
  const now = Date.now();
  const cached = globalCache.__itTicketingSettings;
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const supabase = await connectDB();
    const { data } = await supabase
      .from("app_settings")
      .select("*")
      .eq("id", SETTINGS_ID)
      .maybeSingle();

    // `app_settings` stores app fields in snake_case columns; the mapper
    // turns them back into the camelCase shape `normalizeSettings` expects.
    const value = normalizeSettings(
      data ? mapSettingsRow(data as Record<string, unknown>) : null,
    );
    globalCache.__itTicketingSettings = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  } catch {
    // Never fail a request because the settings read failed - fall back to
    // defaults so the app degrades instead of erroring.
    return normalizeSettings(null);
  }
}

/** Writes the singleton. Only SuperAdmin reaches this. */
export async function saveSettings(patch: Record<string, unknown>): Promise<SettingsShape> {
  const supabase = await connectDB();
  const row = settingsFieldsToRow(patch);

  const data = unwrap(
    await supabase
      .from("app_settings")
      .upsert(
        { id: SETTINGS_ID, ...row, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      )
      .select("*")
      .single<Record<string, unknown>>(),
  );

  const value = normalizeSettings(mapSettingsRow(data));
  globalCache.__itTicketingSettings = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateSettingsCache(): void {
  globalCache.__itTicketingSettings = null;
}

/** Rate-limit thresholds, resolved live. */
export async function getRateLimits(): Promise<RateLimitSettings> {
  return (await getSettings()).rateLimits;
}

export type { PermissionSet };
export { normalizePermissions, DB_NAME, SETTINGS_ID };
