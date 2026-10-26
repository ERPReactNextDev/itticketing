import { NextResponse } from "next/server";
import { connectDB, DatabaseError } from "@/lib/db/supabase";
import { dropdownFieldsToRow, mapDropdownRow, num } from "@/lib/db/mappers";
import { requireUser, requirePermission } from "@/lib/auth/session";
import { DROPDOWN_TYPES, type DropdownType } from "@/lib/shared/constants";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

/**
 * Parses a Supabase row id.
 *
 * Ids are bigint now, so a non-numeric `?id=` must fail the lookup cleanly
 * instead of being coerced into `NaN` and hitting the database.
 */
function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && String(n) === value.trim() ? n : null;
}

function toDTO(doc: ReturnType<typeof mapDropdownRow>) {
  return {
    id: doc.id,
    type: doc.type,
    label: doc.label,
    value: doc.value,
    order: doc.order,
    active: doc.active,
    slaHours: doc.slaHours,
    color: doc.color,
  };
}

/** URL-safe slug. Stable identity for an option across label renames. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Ticket column that stores an option's `value`, keyed by dropdown type. */
const TICKET_FIELD_BY_TYPE: Record<string, string> = {
  department: "department",
  requestType: "request_type",
  typeOfConcern: "type_concern",
  mode: "mode",
  servicesGroup: "group_services",
  site: "site",
  status: "status",
  priority: "priority_data->>value",
};

/**
 * Reads dropdown options.
 *
 * Everyone signed in may read *active* options - the New Ticket form needs them
 * and a Viewer must be able to read a ticket. Inactive options and the full
 * management view require `manageDropdowns`.
 */
export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  const supabase = await connectDB();

  const url = new URL(req.url);
  const typeParam = url.searchParams.get("type");
  const includeInactive = url.searchParams.get("includeInactive") === "1";

  if (includeInactive && !user.permissions.manageDropdowns) {
    return NextResponse.json(
      { error: "forbidden", message: "You cannot view inactive options." },
      { status: 403 },
    );
  }

  let query = supabase.from("dropdown_options").select("*");
  if (typeParam) {
    if (!DROPDOWN_TYPES.includes(typeParam as DropdownType)) {
      throw new ApiInputError(`Unknown dropdown type "${typeParam}".`);
    }
    query = query.eq("type", typeParam);
  }
  if (!includeInactive) query = query.eq("active", true);

  const { data, error } = await query
    .order("type")
    .order("sort_order")
    .order("label");
  if (error) throw new DatabaseError(error);

  const rows = (data ?? []) as Row[];
  const options = rows.map((row) => toDTO(mapDropdownRow(row)));

  // Grouped response is what the Configuration tabs and the form both want.
  const grouped: Record<string, ReturnType<typeof toDTO>[]> = {};
  for (const option of options) {
    grouped[option.type] ??= [];
    grouped[option.type].push(option);
  }

  return NextResponse.json({ options, grouped });
});

type WriteBody = {
  /** Present on update; omitted on create. */
  id?: string;
  type?: string;
  label?: string;
  value?: string;
  order?: number;
  active?: boolean;
  slaHours?: number;
  color?: string;
};

/** Create or update an option. */
export const POST = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageDropdowns");
  const body = await readJson<WriteBody>(req);

  const type = String(body.type ?? "");
  if (!DROPDOWN_TYPES.includes(type as DropdownType)) {
    throw new ApiInputError(`Unknown dropdown type "${type}".`);
  }

  const label = (body.label ?? "").trim();
  if (!label) throw new ApiInputError("Label is required.");

  const value = (body.value ?? slugify(label)).trim();
  if (!value) throw new ApiInputError("Value is required.");

  const supabase = await connectDB();

  const targetId = body.id ? parseId(body.id) : null;
  if (body.id && targetId === null) throw new ApiInputError("That option id is not valid.");

  // The unique (type, label) index is per-row, so an update must look past
  // itself before claiming the label is free.
  let clashQuery = supabase
    .from("dropdown_options")
    .select("id")
    .eq("type", type)
    .eq("label", label);
  if (targetId !== null) clashQuery = clashQuery.neq("id", targetId);
  const { data: labelClash } = await clashQuery.maybeSingle<{ id: unknown }>();

  if (labelClash) {
    return NextResponse.json(
      { error: "duplicate", message: `"${label}" already exists in this list.` },
      { status: 409 },
    );
  }

  const fields: Record<string, unknown> = { type, label, value };
  if (body.order !== undefined) fields.order = num(body.order, 0);
  if (body.active !== undefined) fields.active = Boolean(body.active);
  if (type === "priority" && body.slaHours !== undefined) {
    const hours = Number(body.slaHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new ApiInputError("SLA hours must be a positive number.");
    }
    fields.slaHours = hours;
  }
  if (body.color !== undefined && body.color !== "") fields.color = body.color;

  let doc: ReturnType<typeof mapDropdownRow>;

  if (targetId !== null) {
    const { data, error } = await supabase
      .from("dropdown_options")
      .update(dropdownFieldsToRow(fields))
      .eq("id", targetId)
      .select("*")
      .maybeSingle<Row>();
    if (error) throw new DatabaseError(error);
    if (!data) {
      return NextResponse.json({ error: "not_found", message: "Option not found." }, { status: 404 });
    }
    doc = mapDropdownRow(data);
  } else {
    if (body.order === undefined) {
      const { data: max } = await supabase
        .from("dropdown_options")
        .select("sort_order")
        .eq("type", type)
        .order("sort_order", { ascending: false })
        .limit(1)
        .maybeSingle<{ sort_order: number | null }>();
      fields.order = num(max?.sort_order, -1) + 1;
    }
    const { data, error } = await supabase
      .from("dropdown_options")
      .insert(dropdownFieldsToRow(fields))
      .select("*")
      .single<Row>();
    if (error) throw new DatabaseError(error);
    doc = mapDropdownRow(data);
  }

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: targetId !== null ? "dropdown.update" : "dropdown.create",
    entity: "DropdownOption",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { type, label },
  });

  return NextResponse.json({ option: toDTO(doc) }, { status: targetId !== null ? 200 : 201 });
});

type PatchBody = { active?: boolean };

export const PATCH = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageDropdowns");

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) throw new ApiInputError("An option id is required.");

  const body = await readJson<PatchBody>(req);
  const supabase = await connectDB();

  // Accept the numeric id or, for convenience in tests and scripts, the stable
  // `value` slug - resolved with a read so a typo returns a clean 404.
  const numericId = parseId(id);
  const lookup = supabase.from("dropdown_options").select("id");
  const { data: existing } = await (numericId !== null
    ? lookup.eq("id", numericId)
    : lookup.eq("value", id)
  ).maybeSingle<{ id: unknown }>();

  if (!existing) {
    return NextResponse.json({ error: "not_found", message: "Option not found." }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("dropdown_options")
    .update(dropdownFieldsToRow({ active: Boolean(body.active) }))
    .eq("id", Number(existing.id))
    .select("*")
    .single<Row>();
  if (error) throw new DatabaseError(error);

  const doc = mapDropdownRow(data);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "dropdown.toggle",
    entity: "DropdownOption",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { active: Boolean(body.active), label: doc.label },
  });

  return NextResponse.json({ option: toDTO(doc) });
});

type ReorderBody = { type?: string; ids?: string[] };

/** Drag-and-drop reorder: applies the given ids in the order provided. */
export const PUT = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageDropdowns");
  const body = await readJson<ReorderBody>(req);

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    throw new ApiInputError("An ordered list of option ids is required.");
  }

  const supabase = await connectDB();
  const numericIds = body.ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));

  await Promise.all(
    numericIds.map((id, index) =>
      supabase.from("dropdown_options").update({ sort_order: index }).eq("id", id),
    ),
  );

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "dropdown.reorder",
    entity: "DropdownOption",
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { type: body.type, count: body.ids.length },
  });

  let listQuery = supabase.from("dropdown_options").select("*");
  if (body.type) listQuery = listQuery.eq("type", body.type);
  const { data, error } = await listQuery.order("sort_order");
  if (error) throw new DatabaseError(error);

  return NextResponse.json({ options: ((data ?? []) as Row[]).map((row) => toDTO(mapDropdownRow(row))) });
});

export const DELETE = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageDropdowns");

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) throw new ApiInputError("An option id is required.");

  const supabase = await connectDB();

  // Same id-or-value convenience as PATCH.
  const numericId = parseId(id);
  const lookup = supabase.from("dropdown_options").select("*");
  const { data: found } = await (numericId !== null
    ? lookup.eq("id", numericId)
    : lookup.eq("value", id)
  ).maybeSingle<Row>();

  if (!found) {
    return NextResponse.json({ error: "not_found", message: "Option not found." }, { status: 404 });
  }

  const doc = mapDropdownRow(found);

  // Ticket references are stored by value, so count matching tickets before
  // allowing a hard delete. Referenced options must be deactivated instead.
  const column = TICKET_FIELD_BY_TYPE[doc.type] ?? doc.type;
  const { count: usageCount } = await supabase
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .eq(column, doc.value);

  if ((usageCount ?? 0) > 0) {
    const count = usageCount ?? 0;
    return NextResponse.json(
      {
        error: "in_use",
        message: `${count} ticket${count === 1 ? "" : "s"} use "${doc.label}". Deactivate it instead so existing tickets keep their value.`,
        usageCount: count,
      },
      { status: 409 },
    );
  }

  const { error } = await supabase.from("dropdown_options").delete().eq("id", Number(doc.id));
  if (error) throw new DatabaseError(error);

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "dropdown.delete",
    entity: "DropdownOption",
    entityId: doc.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { type: doc.type, label: doc.label },
  });

  return NextResponse.json({ ok: true });
});
