import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type BulkBody = { ids: string[]; action: "activate" | "deactivate" };

/** Bulk activate / deactivate for the requestor directory. */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageRequestors");

  const body = await readJson<BulkBody>(req);
  const ids = (body.ids ?? []).filter(Boolean);
  if (ids.length === 0) throw new ApiInputError("Select at least one requestor.");

  if (body.action !== "activate" && body.action !== "deactivate") {
    throw new ApiInputError("Unknown bulk action.");
  }

  const supabase = await connectDB();
  const status = body.action === "activate" ? "active" : "inactive";
  const numericIds = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));

  const { data, error } = await supabase
    .from("requestors")
    .update({ status })
    .in("id", numericIds)
    .select("id");
  if (error) throw new DatabaseError(error);

  const updated = data?.length ?? 0;

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: `requestor.bulk.${body.action}`,
    entity: "Requestor",
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { count: updated },
  });

  return NextResponse.json({ ok: true, updated });
});
