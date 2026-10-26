import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { clearSessionCookie } from "@/lib/server/session-actions";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export const POST = withApi(async (req: Request) => {
  const user = await getSessionUser();
  await clearSessionCookie();
  if (user) {
    await writeAuditLog({
      actorId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      action: "user.logout",
      entity: "User",
      entityId: user.id,
      ip: clientIp(req),
      userAgent: userAgent(req),
    });
  }
  return NextResponse.json({ ok: true });
});
