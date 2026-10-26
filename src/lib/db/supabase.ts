import "server-only";
import {
  createClient,
  type PostgrestError,
  type SupabaseClient,
} from "@supabase/supabase-js";

/**
 * Server-side Supabase client.
 *
 * Uses the **service_role** key, so Row Level Security is bypassed and the API
 * layer is the only way into the data. That key must never reach the browser -
 * this module is marked `server-only` to make an accidental client import a
 * build error rather than a leak.
 *
 * The client is stateless (no session, no refresh), so it is cached on
 * globalThis and reused across hot reloads and serverless invocations.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Storage bucket that holds ticket attachments. */
export const STORAGE_BUCKET =
  process.env.SUPABASE_STORAGE_BUCKET?.trim() || "ticket-attachments";

/** Kept for compatibility with call sites that log the active store. */
export const DB_NAME = "supabase";

const globalForSupabase = globalThis as unknown as {
  __itTicketingSupabase?: SupabaseClient | null;
};

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabase(): SupabaseClient {
  if (!SUPABASE_URL) {
    throw new Error(
      "SUPABASE_URL is not set. Add it to .env.local before starting the app.",
    );
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add the service_role secret from " +
        "Dashboard > Project Settings > API to .env.local, then restart.",
    );
  }

  if (!globalForSupabase.__itTicketingSupabase) {
    globalForSupabase.__itTicketingSupabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        db: { schema: "public" },
      },
    );
  }
  return globalForSupabase.__itTicketingSupabase;
}

/** Alias kept so scripts and helpers read naturally (`await connectDB()`). */
export async function connectDB(): Promise<SupabaseClient> {
  return getSupabase();
}

export const db = connectDB;

/** A query failure from PostgREST, surfaced as a normal Error. */
export class DatabaseError extends Error {
  code: string;
  details: string | null;
  hint: string | null;

  constructor(error: PostgrestError) {
    super(error.message);
    this.name = "DatabaseError";
    this.code = error.code ?? "";
    this.details = error.details ?? null;
    this.hint = error.hint ?? null;
  }
}

/** Postgres error code for a unique-constraint violation. */
export const UNIQUE_VIOLATION = "23505";

/** Throws a `DatabaseError` when a query failed, otherwise returns the data. */
export function unwrap<T>(result: { data: T | null; error: PostgrestError | null }): T {
  if (result.error) throw new DatabaseError(result.error);
  return result.data as T;
}

/** Same as `unwrap` but lets `null` through (single-row reads). */
export function unwrapMaybe<T>(
  result: { data: T | null; error: PostgrestError | null },
): T | null {
  if (result.error) throw new DatabaseError(result.error);
  return (result.data as T | null) ?? null;
}

export type { SupabaseClient };
export default getSupabase;
