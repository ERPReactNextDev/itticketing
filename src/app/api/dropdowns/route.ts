import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db/mongoose";
import { DropdownOption, Ticket } from "@/lib/models";
import { requireUser } from "@/lib/auth/session";
import { DROPDOWN_TYPES, type DropdownType } from "@/lib/shared/constants";
import { writeAuditLog } from "@/lib/server/audit";
import { clientIp, userAgent } from "@/lib/server/rate-limit";
import { withApi, readJson, ApiInputError } from "@/lib/server/http";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Lean = Record<string, unknown>;

/**
 * Guards a string against being handed to a Mongoose ObjectId cast.
 *
 * Without this, `?id=accounting` throws a CastError that surfaces as a 500
 * instead of a clean 404.
 */
function isObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

function toDTO(doc: Lean) {
  return {
    id: String(doc._id),
    type: String(doc.type ?? ""),
    label: String(doc.label ?? ""),
    value: String(doc.value ?? ""),
    order: Number(doc.order ?? 0),
    active: doc.active !== false,
    slaHours: typeof doc.slaHours === "number" ? doc.slaHours : undefined,
    color: doc.color ? String(doc.color) : undefined,
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

/**
 * Reads dropdown options.
 *
 * Everyone signed in may read *active* options - the New Ticket form needs them
 * and a Viewer must be able to read a ticket. Inactive options and the full
 * management view require `manageDropdowns`.
 */
export const GET = withApi(async (req: Request) => {
  const user = await requireUser();
  await connectDB();

  const url = new URL(req.url);
  const typeParam = url.searchParams.get("type");
  const includeInactive = url.searchParams.get("includeInactive") === "1";

  if (includeInactive && !user.permissions.manageDropdowns) {
    return NextResponse.json(
      { error: "forbidden", message: "You cannot view inactive options." },
      { status: 403 },
    );
  }

  const filter: Record<string, unknown> = {};
  if (typeParam) {
    if (!DROPDOWN_TYPES.includes(typeParam as DropdownType)) {
      throw new ApiInputError(`Unknown dropdown type "${typeParam}".`);
    }
    filter.type = typeParam;
  }
  if (!includeInactive) filter.active = true;

  const rows = await DropdownOption.find(filter)
    .sort({ type: 1, order: 1, label: 1 })
    .lean<Lean[]>();

  // Grouped response is what the Configuration tabs and the form both want.
  const grouped: Record<string, ReturnType<typeof toDTO>[]> = {};
  for (const doc of rows) {
    const key = String(doc.type);
    grouped[key] ??= [];
    grouped[key].push(toDTO(doc));
  }

  return NextResponse.json({ options: rows.map(toDTO), grouped });
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

  await connectDB();

  const labelClash = await DropdownOption.findOne({ type, label, ...(body.id ? { _id: { $ne: body.id } } : {}) });
  if (labelClash) {
    return NextResponse.json(
      { error: "duplicate", message: `"${label}" already exists in this list.` },
      { status: 409 },
    );
  }

  const set: Record<string, unknown> = { type, label, value };
  if (body.order !== undefined) set.order = Number(body.order);
  if (body.active !== undefined) set.active = Boolean(body.active);
  if (type === "priority" && body.slaHours !== undefined) {
    const hours = Number(body.slaHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new ApiInputError("SLA hours must be a positive number.");
    }
    set.slaHours = hours;
  }
  if (body.color !== undefined && body.color !== "") set.color = body.color;

  let doc;
  if (body.id) {
    if (!isObjectId(body.id)) throw new ApiInputError("That option id is not valid.");
    doc = await DropdownOption.findByIdAndUpdate(
      body.id,
      { $set: set },
      { new: true },
    ).lean<Lean>();
    if (!doc) {
      return NextResponse.json({ error: "not_found", message: "Option not found." }, { status: 404 });
    }
  } else {
    if (body.order === undefined) {
      const max = await DropdownOption.findOne({ type }).sort({ order: -1 }).lean<{ order?: number }>();
      set.order = (max?.order ?? -1) + 1;
    }
    doc = await DropdownOption.create(set);
    doc = doc.toObject();
  }

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: body.id ? "dropdown.update" : "dropdown.create",
    entity: "DropdownOption",
    entityId: String(doc._id),
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { type, label },
  });

  return NextResponse.json({ option: toDTO(doc) }, { status: body.id ? 200 : 201 });
});

type PatchBody = { active?: boolean };

export const PATCH = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageDropdowns");

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) throw new ApiInputError("An option id is required.");

  const body = await readJson<PatchBody>(req);
  await connectDB();

  // Accept the document id or, for convenience in tests and scripts, the
  // stable `value` slug. Guard the cast so a typo returns a 404 rather than a
  // 500 from an unhandled CastError.
  const filter = isObjectId(id) ? { _id: id } : { value: id };
  const doc = await DropdownOption.findOneAndUpdate(
    filter,
    { $set: { active: Boolean(body.active) } },
    { new: true },
  ).lean<Lean>();

  if (!doc) {
    return NextResponse.json({ error: "not_found", message: "Option not found." }, { status: 404 });
  }

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "dropdown.toggle",
    entity: "DropdownOption",
    entityId: String(doc._id),
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

  await connectDB();
  const filter = body.type ? { type: body.type } : { _id: { $in: body.ids } };

  await Promise.all(
    body.ids.map((id, index) =>
      DropdownOption.updateOne({ _id: id, ...filter }, { $set: { order: index } }),
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

  const rows = await DropdownOption.find(filter).sort({ order: 1 }).lean<Lean[]>();
  return NextResponse.json({ options: rows.map(toDTO) });
});

export const DELETE = withApi(async (req: Request) => {
  const user = await requireUser();
  requirePermission(user, "manageDropdowns");

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) throw new ApiInputError("An option id is required.");

  await connectDB();

  // Same id-or-value convenience as PATCH.
  const doc = await DropdownOption.findOne(
    isObjectId(id) ? { _id: id } : { value: id },
  ).lean<Lean>();
  if (!doc) {
    return NextResponse.json({ error: "not_found", message: "Option not found." }, { status: 404 });
  }

  // Ticket references are stored by value, so count matching tickets before
  // allowing a hard delete. Referenced options must be deactivated instead.
  const type = String(doc.type);
  const value = String(doc.value);
  const fieldByType: Record<string, string> = {
    department: "department",
    requestType: "requestType",
    typeOfConcern: "typeOfConcern",
    mode: "mode",
    servicesGroup: "servicesGroup",
    site: "site",
    status: "status",
    priority: "priority.value",
  };

  const usageCount = await Ticket.countDocuments({
    [fieldByType[type] ?? type]: value,
  });

  if (usageCount > 0) {
    return NextResponse.json(
      {
        error: "in_use",
        message: `${usageCount} ticket${usageCount === 1 ? "" : "s"} use "${doc.label}". Deactivate it instead so existing tickets keep their value.`,
        usageCount,
      },
      { status: 409 },
    );
  }

  await DropdownOption.deleteOne({ _id: id });

  await writeAuditLog({
    actorId: user.id,
    actorName: user.name,
    actorEmail: user.email,
    action: "dropdown.delete",
    entity: "DropdownOption",
    entityId: id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    meta: { type, label: doc.label },
  });

  return NextResponse.json({ ok: true });
});