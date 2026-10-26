import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { mapAuditRow } from "@/lib/db/mappers";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { withApi, intParam } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * PostgREST's `or` filter is comma/paren delimited and `%` is a LIKE wildcard,
 * so a raw search term could be read as filter syntax. Strip those characters
 * before interpolating.
 */
function sanitizeTerm(value: string): string {
  return value.replace(/[(),%]/g, " ").trim();
}

export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "viewAuditLogs");

  const supabase = await connectDB();

  const url = new URL(req.url);
  const search = (url.searchParams.get("search") ?? "").trim();
  const page = intParam(url.searchParams.get("page"), 1, { min: 1 });
  const pageSize = intParam(url.searchParams.get("pageSize"), 50, { min: 1, max: 200 });

  let query = supabase.from("system_audit_logs").select("*", { count: "exact" });

  if (search) {
    const term = sanitizeTerm(search);
    if (term) {
      query = query.or(
        [
          `action.ilike.%${term}%`,
          `entity.ilike.%${term}%`,
          `entity_id.ilike.%${term}%`,
          `actor_name.ilike.%${term}%`,
          `actor_email.ilike.%${term}%`,
          `ip.ilike.%${term}%`,
        ].join(","),
      );
    }
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new DatabaseError(error);

  const total = count ?? 0;

  return NextResponse.json({
    // `mapAuditRow` names the actor column `actor`; the DTO calls it `actorId`.
    logs: ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
      const log = mapAuditRow(row);
      return {
        id: log.id,
        actorId: log.actor,
        actorName: log.actorName,
        actorEmail: log.actorEmail,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId,
        ip: log.ip,
        userAgent: log.userAgent,
        meta: log.meta,
        createdAt: log.createdAt,
      };
    }),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});
