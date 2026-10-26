import { NextResponse } from "next/server";
import { AuthError, ForbiddenError } from "../auth/session";
import { DatabaseError, UNIQUE_VIOLATION } from "../db/supabase";

/**
 * A caller mistake with a specific status: malformed JSON, a missing field, a
 * bad id. Checked *before* the generic fallbacks in `handleApiError`, otherwise
 * these would be reported as 500s.
 */
export class ApiInputError extends Error {
  status = 400;
  code = "bad_request";
}

/**
 * A deployment fault: a required environment variable is missing, too short,
 * or otherwise unusable.
 *
 * Distinct from a generic server error because the remedy is specific and
 * the message is safe to show - it names a variable, never a value. Without
 * this, a missing `JWT_SECRET` surfaced as "Something went wrong" and looked
 * like a bad password.
 */
export class ServerConfigError extends Error {
  status = 500;
  code = "server_misconfigured";
}

/** Wraps a route handler so thrown errors become clean JSON instead of HTML. */
export function withApi<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return handleApiError(error);
    }
  };
}

export function handleApiError(error: unknown): NextResponse {
  if (
    error instanceof AuthError ||
    error instanceof ForbiddenError ||
    error instanceof ApiInputError ||
    error instanceof ServerConfigError
  ) {
    // A misconfiguration is logged loudly but reported verbatim: the message
    // names the variable to fix and never contains its value.
    if (error instanceof ServerConfigError) {
      console.error(`[config] ${error.message}`);
    }
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }

  // A Postgres/PostgREST failure. A unique-constraint violation is the caller's
  // fault (a duplicate email, employee id, ...) and maps to a 409; anything else
  // is a genuine server fault and is logged with its full detail.
  if (error instanceof DatabaseError) {
    if (error.code === UNIQUE_VIOLATION) {
      return NextResponse.json(
        { error: "duplicate", message: "That value is already in use." },
        { status: 409 },
      );
    }
    console.error("[db] unhandled error:", error);
    return NextResponse.json(
      { error: "server_error", message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }

  if (error instanceof Error) {
    console.error("[api] unhandled error:", error);
    return NextResponse.json(
      {
        error: "server_error",
        message: "Something went wrong. Please try again.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { error: "server_error", message: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function fail(message: string, status = 400, error = "bad_request"): NextResponse {
  return NextResponse.json({ error, message }, { status });
}

/** Reads a JSON body and reports malformed input as a 400 rather than a 500. */
export async function readJson<T = Record<string, unknown>>(
  req: Request,
): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiInputError("Request body must be valid JSON.");
  }
}

/** Coerces a search param to a positive integer within bounds. */
export function intParam(
  value: string | null,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function boolParam(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return value === "true" || value === "1";
}

/** Splits a comma-separated search param into trimmed, non-empty values. */
export function csvParam(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}
