import "server-only";
import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { connectDB, DB_NAME } from "../db/supabase";
import { getRateLimits } from "./settings";

/**
 * Postgres-backed fixed-window rate limiter.
 *
 * Why not express-rate-limit + a store adapter: those packages are written for
 * Express middleware and expect `req.headers` to be a plain object. Next.js
 * route handlers receive a Web `Request` whose `headers` is a `Headers`
 * instance, so the library's own key generator and request handling silently
 * misbehave behind App Router. This module does the same job with the correct
 * types and no casts, against the `rate_limits` table.
 *
 * Each window is its own row keyed `(key, window_start)`. The increment happens
 * inside the `consume_rate_limit()` SQL function, so concurrent requests are
 * atomic - `insert ... on conflict do update ... returning` - instead of the
 * read-then-write race a client-side increment would create.
 */

export type LimitRule = {
  /** Human label used in the 429 message. */
  message: string;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed inside the window. */
  max: number;
  /** Bucket identity, e.g. `login:1.2.3.4:user@x.com`. */
  key: string;
};

export type LimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix ms when the current window ends. */
  resetAt: number;
  /** Seconds the caller should wait. */
  retryAfterSeconds: number;
};

/**
 * Best-effort client IP.
 *
 * Only used for rate-limit bucketing and audit logs - never for authorisation,
 * because a spoofable header must not be able to grant or revoke access.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function userAgent(req: Request): string {
  return req.headers.get("user-agent") ?? "";
}

export function subjectKey(req: Request, userId?: string | null): string {
  return userId ? `u:${userId}` : `ip:${clientIp(req)}`;
}

export async function consume(rule: LimitRule): Promise<LimitResult> {
  const windowMs = Math.max(1000, rule.windowMs);
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;

  try {
    const supabase = await connectDB();

    // One atomic round-trip: the SQL function increments (or creates) the
    // bucket and returns the new hit count, so two concurrent requests can
    // never both read the same value.
    const { data, error } = await supabase.rpc("consume_rate_limit", {
      p_key: rule.key,
      p_window_start: windowStart,
    });
    if (error) throw error;

    const hits = Number(data ?? 1);

    return {
      allowed: hits <= rule.max,
      limit: rule.max,
      remaining: Math.max(0, rule.max - hits),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  } catch (error) {
    // A rate-limit store outage must not take the whole API down. Fail open and
    // log loudly so it is visible rather than silently disabling protection.
    console.error("[rate-limit] store unavailable, allowing request:", error);
    return {
      allowed: true,
      limit: rule.max,
      remaining: rule.max,
      resetAt,
      retryAfterSeconds: 1,
    };
  }
}

/**
 * Consumes one unit and returns a 429 response when the limit is exceeded.
 * Returns null when the request may proceed.
 */
export async function enforce(rule: LimitRule): Promise<NextResponse | null> {
  const result = await consume(rule);
  if (result.allowed) return null;

  return NextResponse.json(
    { error: "rate_limited", message: rule.message },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
      },
    },
  );
}

/* ── Concrete rules, with thresholds read live from app_settings ─────────── */

/** 100 req/min per IP across the API. Applied by the app-shell middleware. */
export async function globalApiRule(req: Request): Promise<LimitRule> {
  const limits = await getRateLimits();
  return {
    key: `global:${clientIp(req)}`,
    windowMs: 60_000,
    max: Math.max(1, limits.globalPerMin),
    message: "Too many requests. Please slow down and try again in a minute.",
  };
}

/** 5 attempts / 15 min per IP + email. */
export async function loginRule(req: Request, email?: string): Promise<LimitRule> {
  const limits = await getRateLimits();
  const windowMin = Math.max(1, limits.loginWindowMin);
  // Keyed on IP *and* email: one attacker cannot lock every account out from a
  // shared NAT, and spraying many emails is still capped per-IP.
  return {
    key: `login:${clientIp(req)}:${(email ?? "").trim().toLowerCase()}`,
    windowMs: windowMin * 60_000,
    max: Math.max(1, limits.loginMaxAttempts),
    message: `Too many sign-in attempts. Please wait ${windowMin} minute${windowMin === 1 ? "" : "s"} before trying again.`,
  };
}

/** 10 tickets/hour per user, 3/hour for anonymous or email fallback intake. */
export async function ticketCreateRule(
  req: Request,
  userId?: string | null,
): Promise<LimitRule> {
  const limits = await getRateLimits();
  const windowMin = Math.max(1, limits.ticketCreateWindowMin);
  return {
    key: `ticket-create:${subjectKey(req, userId)}`,
    windowMs: windowMin * 60_000,
    max: userId
      ? Math.max(1, limits.ticketCreateMax)
      : Math.max(1, limits.ticketCreateMaxUnauthenticated),
    message: `You have reached the ticket creation limit for this ${windowMin}-minute period.`,
  };
}

/**
 * Inbound webhook ceiling. Deliberately generous and independent of the global
 * limiter so a burst of forwarded Gmail is never dropped, but still bounded.
 */
export async function webhookRule(req: Request): Promise<LimitRule> {
  const limits = await getRateLimits();
  return {
    key: `webhook:${clientIp(req)}`,
    windowMs: 60_000,
    max: Math.max(1, limits.webhookPerMin),
    message: "Webhook rate limit exceeded.",
  };
}

/** Clears a bucket, e.g. after a successful login. */
export async function resetBucket(key: string): Promise<void> {
  try {
    const supabase = await connectDB();
    await supabase.from("rate_limits").delete().eq("key", key);
  } catch {
    // Non-critical.
  }
}

/** sha256 of a raw webhook payload, for tamper detection / dedupe. */
export function payloadHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export { DB_NAME };
