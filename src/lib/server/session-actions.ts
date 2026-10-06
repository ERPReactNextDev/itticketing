import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "../auth/jwt";
import { getSettings } from "./settings";

/**
 * Writes (or clears) the session cookie.
 *
 * httpOnly + sameSite=strict keeps the token out of reach of client-side script
 * and off cross-site requests. `secure` is on outside development so the cookie
 * never travels over plain HTTP in production.
 */
export async function setSessionCookie(token: string): Promise<void> {
  const settings = await getSettings();
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "strict",
    path: "/",
    maxAge: settings.sessionTimeoutMin * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}