import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { enforce, globalApiRule } from "@/lib/server/rate-limit";

/**
 * Route protection + the global API rate limit.
 *
 * The previous version of this app had no proxy at all and identified the user
 * from an `?id=` query parameter, which meant anyone could impersonate any
 * account by editing the URL. This gate only checks that a *valid* session
 * cookie exists - the per-route RBAC checks in the API layer decide what the
 * user may actually do.
 *
 * The inbound webhook is excluded from the global ceiling because it has its
 * own, more generous, limit inside the route handler.
 */

const SESSION_COOKIE = "itd_session";

/** Routes that work without a session. */
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/webhooks/resend"];

function isPublic(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;

  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    // Misconfiguration: fail closed rather than letting everyone in, and say
    // exactly what is wrong so it is not mistaken for a credential problem.
    console.error(
      `[proxy] JWT_SECRET is ${!secret ? "missing" : `only ${secret.length} chars`}. ` +
        "No session can be validated. Add a 32+ character value to .env.local and restart.",
    );
    return false;
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Global per-IP API ceiling, thresholds read live from system_settings.
  if (pathname.startsWith("/api/") && !pathname.startsWith("/api/webhooks/")) {
    const limited = await enforce(await globalApiRule(req as unknown as Request));
    if (limited) return limited;
  }

  if (isPublic(pathname)) return NextResponse.next();

  const authenticated = await hasValidSession(req);

  if (authenticated) {
    // Signed-in users should not see the login page.
    if (pathname === "/login") {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  // Unauthenticated browser navigation -> login.
  if (!pathname.startsWith("/api/")) {
    const url = new URL("/login", req.url);
    // Remember where they were headed so login can bounce them back.
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Unauthenticated API call.
  return NextResponse.json(
    { error: "unauthenticated", message: "You must be signed in to do that." },
    { status: 401 },
  );
}

export const config = {
  // No `runtime` key: Proxy always runs on Node.js, which is what lets the
  // Mongo-backed rate limiter import a database driver here.
  matcher: [
    // Everything except Next.js internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico|ticketing.png|notif-sound.mp3|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|mp3)$).*)",
  ],
};