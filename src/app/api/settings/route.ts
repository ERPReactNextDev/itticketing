import { NextResponse } from "next/server";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { getSettings, saveSettings } from "@/lib/server/settings";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { previewNextTicketNumber } from "@/lib/server/ticket-number";
import { hasSequenceToken } from "@/lib/server/ticket-number";

export const dynamic = "force-dynamic";

/**
 * Settings read.
 *
 * Non-privileged roles get a narrow subset: only the values the ticket form and
 * header genuinely need. Anything administrative (email addresses, webhook
 * secret, rate limits) is stripped.
 */
export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  const settings = await getSettings();

  const url = new URL(req.url);
  if (url.searchParams.get("preview") === "1") {
    requirePermission(user, "manageSettings");
    const preview = await previewNextTicketNumber();
    return NextResponse.json({ ...preview, pattern: settings.ticketNumberPattern });
  }

  if (!user.permissions.manageSettings) {
    return NextResponse.json({
      settings: {
        ticketNumberPattern: settings.ticketNumberPattern,
        ticketPrefix: settings.ticketPrefix,
        defaultTechnicianAssignment: settings.defaultTechnicianAssignment,
        sessionTimeoutMin: settings.sessionTimeoutMin,
      },
    });
  }

  return NextResponse.json({ settings });
});

type PatchBody = {
  ticketNumberPattern?: string;
  ticketPrefix?: string;
  dateFormatInNumber?: string;
  seqPadLength?: number;
  resetSeqPerDay?: boolean;
  resendFromEmail?: string;
  inboundEmail?: string;
  resendInboundSecret?: string;
  pauseSlaOnScheduled?: boolean;
  defaultTechnicianAssignment?: string;
  sessionTimeoutMin?: number;
  rateLimits?: Record<string, number>;
  slaDefaults?: Record<string, number>;
  email?: Record<string, unknown>;
};

export const PATCH = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageSettings");
  const body = await readJson<PatchBody>(req);

  const current = await getSettings();
  const set: Record<string, unknown> = {};

  if (body.ticketNumberPattern !== undefined) {
    const pattern = body.ticketNumberPattern.trim();
    if (!pattern) throw new ApiInputError("The ticket number pattern cannot be empty.");
    // A pattern without {SEQ} would produce the same number for every ticket.
    if (!hasSequenceToken(pattern)) {
      return NextResponse.json(
        {
          error: "invalid_pattern",
          message:
            "The pattern must contain {SEQ} (or {SEQ:3}), otherwise every ticket would get the same number.",
        },
        { status: 400 },
      );
    }
    if (pattern.length > 120) {
      return NextResponse.json(
        { error: "invalid_pattern", message: "The pattern is too long." },
        { status: 400 },
      );
    }
    // Numbering changes bump the version. Existing tickets keep their
    // `patternVersion`, so history is never renumbered.
    if (pattern !== current.ticketNumberPattern) {
      set.patternVersion = current.patternVersion + 1;
    }
    set.ticketNumberPattern = pattern;
  }

  if (body.ticketPrefix !== undefined) {
    const prefix = body.ticketPrefix.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(prefix)) {
      return NextResponse.json(
        { error: "invalid_prefix", message: "Prefix must be 1-10 letters or digits." },
        { status: 400 },
      );
    }
    set.ticketPrefix = prefix;
  }

  if (body.seqPadLength !== undefined) {
    const pad = Number(body.seqPadLength);
    if (!Number.isInteger(pad) || pad < 1 || pad > 10) {
      return NextResponse.json(
        { error: "invalid_pad", message: "Sequence padding must be between 1 and 10." },
        { status: 400 },
      );
    }
    set.seqPadLength = pad;
  }

  if (body.dateFormatInNumber !== undefined) set.dateFormatInNumber = body.dateFormatInNumber;
  if (body.resetSeqPerDay !== undefined) set.resetSeqPerDay = Boolean(body.resetSeqPerDay);
  if (body.pauseSlaOnScheduled !== undefined) {
    set.pauseSlaOnScheduled = Boolean(body.pauseSlaOnScheduled);
  }

  if (body.defaultTechnicianAssignment !== undefined) {
    const mode = body.defaultTechnicianAssignment;
    if (mode !== "self" && mode !== "round-robin" && mode !== "unassigned") {
      return NextResponse.json(
        { error: "invalid_value", message: "Unknown default technician assignment mode." },
        { status: 400 },
      );
    }
    set.defaultTechnicianAssignment = mode;
  }

  if (body.sessionTimeoutMin !== undefined) {
    const minutes = Number(body.sessionTimeoutMin);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 60 * 24 * 30) {
      return NextResponse.json(
        { error: "invalid_value", message: "Session timeout must be between 5 minutes and 30 days." },
        { status: 400 },
      );
    }
    set.sessionTimeoutMin = minutes;
  }

  if (body.resendFromEmail !== undefined) {
    const value = body.resendFromEmail.trim();
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return NextResponse.json(
        { error: "invalid_email", message: "That is not a valid email address." },
        { status: 400 },
      );
    }
    set.resendFromEmail = value;
  }

  if (body.inboundEmail !== undefined) {
    const value = body.inboundEmail.trim();
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return NextResponse.json(
        { error: "invalid_email", message: "That is not a valid email address." },
        { status: 400 },
      );
    }
    set.inboundEmail = value;
  }

  if (body.resendInboundSecret !== undefined) set.resendInboundSecret = body.resendInboundSecret;

  if (body.rateLimits !== undefined) {
    const allowed = new Set([
      "loginWindowMin",
      "loginMaxAttempts",
      "loginLockAfterFails",
      "ticketCreateWindowMin",
      "ticketCreateMax",
      "ticketCreateMaxUnauthenticated",
      "globalPerMin",
      "webhookPerMin",
    ]);
    const next: Record<string, number> = { ...current.rateLimits };
    for (const [key, value] of Object.entries(body.rateLimits)) {
      if (!allowed.has(key)) continue;
      const num = Number(value);
      if (!Number.isFinite(num) || num < 1) {
        return NextResponse.json(
          { error: "invalid_value", message: `"${key}" must be a number of at least 1.` },
          { status: 400 },
        );
      }
      next[key] = num;
    }
    set.rateLimits = next;
  }

  if (body.slaDefaults !== undefined) {
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(body.slaDefaults)) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) next[key] = num;
    }
    set.slaDefaults = next;
  }

  if (body.email !== undefined) {
    const currentEmail = current.email;
    set.email = {
      autoTicketPriority: body.email.autoTicketPriority ?? currentEmail.autoTicketPriority,
      autoTicketStatus: body.email.autoTicketStatus ?? currentEmail.autoTicketStatus,
      autoTicketMode: body.email.autoTicketMode ?? currentEmail.autoTicketMode,
      autoTicketServicesGroup: body.email.autoTicketServicesGroup ?? currentEmail.autoTicketServicesGroup,
      sendAutoAcknowledgement:
        typeof body.email.sendAutoAcknowledgement === "boolean"
          ? body.email.sendAutoAcknowledgement
          : currentEmail.sendAutoAcknowledgement,
      notifyTechnicianOnInbound:
        typeof body.email.notifyTechnicianOnInbound === "boolean"
          ? body.email.notifyTechnicianOnInbound
          : currentEmail.notifyTechnicianOnInbound,
    };
  }

  if (Object.keys(set).length === 0) throw new ApiInputError("Nothing to update.");

  const saved = await saveSettings(set);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "settings.update",
    entity: "SystemSetting",
    entityId: "singleton",
    ip: clientIp(req),
    userAgent: userAgent(req),
    // Field names only - never log the webhook secret value.
    meta: { changed: Object.keys(set) },
  });

  return NextResponse.json({ settings: saved });
});