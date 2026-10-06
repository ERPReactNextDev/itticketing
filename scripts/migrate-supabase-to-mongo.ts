/**
 * One-time migration: Supabase (Postgres) -> MongoDB.
 *
 * The old app read every table straight from the browser with the anon key, so
 * all data still lives in Supabase. This script pulls `tickets`, `users` and
 * `ticket_conversations` and writes them into the MongoDB collections described
 * in the spec, mapping the old ids onto the new schema.
 *
 * Safe to re-run: it upserts by `legacyUserId` / ticket number and skips any
 * ticket that already has a number.
 *
 * Run:  npm run migrate:supabase          (writes)
 *       npm run migrate:supabase:dry      (reports only, writes nothing)
 *
 * Required env (add to .env.local):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is preferred over the publishable key because RLS
 * is bypassed only with the service role; the publishable key still works if the
 * tables allow anonymous reads, which they did in the old app.
 */

import "./load-env";

import { connectDB } from "../src/lib/db/mongoose";
import { hashPassword } from "../src/lib/auth/password";
import {
  User,
  Requestor,
  Role,
  Ticket,
  DropdownOption,
  TicketCounter,
  ensureIndexes,
} from "../src/lib/models";
import { SYSTEM_ROLE_DEFAULTS, type SystemRoleName } from "../src/lib/shared/permissions";
import { buildFullName } from "../src/lib/models/requestor";
import { SEED_DROPDOWNS } from "./defaults";
import { computeDueAt } from "../src/lib/server/sla";
import { appDateKey } from "../src/lib/shared/time";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH = 1000;

/** Legacy Supabase column -> new ticket field. */
const TICKET_FIELD_MAP: Record<string, string> = {
  ticket_id: "ticketNumber",
  ticket_subject: "subject",
  requestor_name: "requestorName",
  department: "department",
  request_type: "requestType",
  type_concern: "typeOfConcern",
  mode: "mode",
  group_services: "servicesGroup",
  technician_name: "technicianName",
  site: "site",
  priority: "priority",
  status: "status",
  date_scheduled: "scheduledDate",
  remarks: "remarks",
  processed_by: "processedByName",
  closed_by: "closedByName",
  date_created: "dateCreated",
  date_closed: "dateClosed",
};

type LegacyRow = Record<string, unknown>;

function log(message: string) {
  console.log(message);
}

function slug(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Last, First" -> { firstName, lastName }. Falls back to a single name. */
function splitFullName(full: string): { firstName: string; lastName: string } {
  const trimmed = String(full ?? "").trim();
  if (!trimmed) return { firstName: "Unknown", lastName: "-" };
  if (trimmed.includes(",")) {
    const [lastName, ...rest] = trimmed.split(",");
    return { lastName: lastName.trim(), firstName: rest.join(",").trim() || "Unknown" };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "-" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Minimal structural type for the Supabase client this script uses.
 *
 * The full `SupabaseClient` generic explodes with the newer supabase-js types
 * (its schema generics default to `never`), so the two calls actually made -
 * `.from().select().range()` - are described here instead.
 */
type SupabaseReader = {
  from: (table: string) => {
    select: (columns: string) => {
      // supabase-js returns a thenable builder, not a native Promise.
      range: (
        from: number,
        to: number,
      ) => PromiseLike<{
        data: unknown[] | null;
        error: { message: string } | null;
      }>;
    };
  };
};

/** Fetches every row of a table, paging like the old `fetchAllSupabaseRows`. */
async function fetchAll(
  supabase: SupabaseReader,
  table: string,
): Promise<LegacyRow[]> {
  const out: LegacyRow[] = [];
  for (let offset = 0; ; offset += BATCH) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(offset, offset + BATCH - 1);
    if (error) throw new Error(`Reading ${table}: ${error.message}`);
    const rows = (data ?? []) as LegacyRow[];
    out.push(...rows);
    if (rows.length < BATCH) break;
  }
  return out;
}

/**
 * PostgREST client.
 *
 * Deliberately built on `fetch` instead of the supabase-js SDK: this script is
 * a one-time tool, the REST API needs only two headers, and keeping the SDK out
 * of `dependencies` means the app itself has zero Supabase code or packages -
 * which is one of the acceptance criteria.
 */
function createSupabaseReader(url: string, key: string): SupabaseReader {
  const base = url.replace(/\/$/, "");

  return {
    from: (table: string) => ({
      select: (columns: string) => ({
        range: async (from: number, to: number) => {
          const response = await fetch(
            `${base}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(columns)}`,
            {
              headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                // PostgREST uses `Range` for offset/limit paging, inclusive of both ends.
                Range: `offset=${from}-${to}`,
                Prefer: "count=exact",
              },
            },
          );

          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            return {
              data: null,
              error: { message: `HTTP ${response.status} ${detail.slice(0, 200)}` },
            };
          }
          return { data: (await response.json()) as unknown[], error: null };
        },
      }),
    }),
  };
}

/** Ensures every seeded dropdown option exists so legacy values can be mapped. */
async function ensureDropdownOptions() {
  for (const dropdown of SEED_DROPDOWNS) {
    for (const [index, option] of dropdown.options.entries()) {
      await DropdownOption.updateOne(
        { type: dropdown.type, value: option.value },
        {
          $setOnInsert: {
            type: dropdown.type,
            label: option.label,
            value: option.value,
            order: index,
            active: true,
            ...(option.slaHours !== undefined ? { slaHours: option.slaHours } : {}),
            ...(option.color !== undefined ? { color: option.color } : {}),
          },
        },
        { upsert: true },
      );
    }
  }
  log(`   dropdown options ready (${await DropdownOption.countDocuments()})`);
}

/**
 * Maps a legacy label onto a dropdown value.
 *
 * Falls back to a slug of the raw label so a value that no longer exists in the
 * seeded lists is still preserved rather than silently dropped.
 */
async function mapDropdownValue(
  type: string,
  legacyValue: unknown,
): Promise<{ value: string; label: string; slaHours?: number; color?: string; inactive: boolean } | null> {
  const label = String(legacyValue ?? "").trim();
  if (!label) return null;

  const byLabel = await DropdownOption.findOne({ type, label }).lean<{
    value: string;
    label: string;
    slaHours?: number;
    color?: string;
    active: boolean;
  }>();
  if (byLabel) {
    return {
      value: byLabel.value,
      label: byLabel.label,
      slaHours: byLabel.slaHours,
      color: byLabel.color,
      inactive: byLabel.active !== true,
    };
  }

  const byValue = await DropdownOption.findOne({ type, value: slug(label) }).lean<{
    value: string;
    label: string;
    slaHours?: number;
    color?: string;
    active: boolean;
  }>();
  if (byValue) {
    return {
      value: byValue.value,
      label: byValue.label,
      slaHours: byValue.slaHours,
      color: byValue.color,
      inactive: byValue.active !== true,
    };
  }

  // Unknown value: keep it verbatim so the ticket still renders.
  return { value: slug(label), label, inactive: true };
}

async function migrateRoles() {
  log("-> roles");
  const order: SystemRoleName[] = ["Super Admin", "Admin", "Agent", "Viewer"];
  for (const [index, key] of order.entries()) {
    const template = SYSTEM_ROLE_DEFAULTS[key];
    if (DRY_RUN) {
      log(`   would ensure ${template.name}`);
      continue;
    }
    await Role.updateOne(
      { name: template.name },
      {
        $set: {
          name: template.name,
          description: template.description,
          permissions: template.permissions,
          isSystem: true,
          order: index,
        },
      },
      { upsert: true },
    );
  }
  log(`   ok ${order.length} roles`);
}

async function migrateUsers(supabase: SupabaseReader) {
  log("-> users (login accounts)");
  const rows = await fetchAll(supabase, "users");
  if (rows.length === 0) {
    log("   no legacy users found");
    return new Map<string, string>();
  }

  const roleByName = new Map<string, string>();
  if (!DRY_RUN) {
    for (const name of ["Super Admin", "Admin", "Agent", "Viewer"]) {
      const role = await Role.findOne({ name }).lean<{ _id: unknown }>();
      if (role) roleByName.set(name, String(role._id));
    }
  }

  const legacyIdToUserId = new Map<string, string>();
  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    const email = String(row.Email ?? row.email ?? "").trim().toLowerCase();
    if (!email) {
      skipped += 1;
      continue;
    }

    const legacyId = String(row._id ?? row.id ?? "");
    const firstName = String(row.Firstname ?? row.firstname ?? "").trim();
    const lastName = String(row.Lastname ?? row.lastname ?? "").trim();
    const name = `${firstName} ${lastName}`.trim() || email;

    // Map the legacy Role string onto one of the four system roles.
    const legacyRole = String(row.Role ?? row.role ?? "").toLowerCase();
    const roleName = legacyRole.includes("admin")
      ? "Super Admin"
      : legacyRole.includes("super")
        ? "Super Admin"
        : legacyRole.includes("supervisor")
          ? "Admin"
          : legacyRole.includes("agent") || legacyRole.includes("tech")
            ? "Agent"
            : legacyRole.includes("viewer") || legacyRole.includes("guest")
              ? "Viewer"
              : "Agent";

    const legacyPassword = String(row.Password ?? "");
    // Old accounts stored a bcrypt hash. If it is missing, force a reset rather
    // than creating an account nobody can sign into.
    const passwordHash =
      legacyPassword.startsWith("$2") && legacyPassword.length > 50
        ? legacyPassword
        : await hashPassword(`migrated-${Math.random().toString(36).slice(2)}`);
    const mustChangePassword = !legacyPassword.startsWith("$2");

    if (DRY_RUN) {
      log(`   would migrate ${email} -> ${roleName}`);
      continue;
    }

    const roleId = roleByName.get(roleName) ?? roleByName.get("Agent")!;
    const existing = await User.findOne({ $or: [{ email }, { legacyUserId: legacyId }] }).lean<{
      _id: unknown;
    }>();

    if (existing) {
      legacyIdToUserId.set(legacyId, String(existing._id));
      skipped += 1;
      continue;
    }

    const created_ = await User.create({
      name,
      email,
      employeeId: String(row.ReferenceID ?? row.referenceId ?? ""),
      passwordHash,
      mustChangePassword,
      role: roleId,
      department: String(row.Department ?? ""),
      status: "active",
      legacyUserId: legacyId || undefined,
      lastLoginAt: parseDate(row.lastLoginAt),
    });

    legacyIdToUserId.set(legacyId, String(created_._id));
    created += 1;
  }

  log(`   created ${created}, skipped ${skipped}`);
  return legacyIdToUserId;
}

/** Legacy users double as the initial requestor directory. */
async function migrateRequestors(supabase: SupabaseReader) {
  log("-> requestors (employee directory, derived from legacy users)");
  const rows = await fetchAll(supabase, "users");

  if (DRY_RUN) {
    log(`   would build up to ${rows.length} requestor records`);
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    const email = String(row.Email ?? "").trim().toLowerCase();
    const firstName = String(row.Firstname ?? "").trim();
    const lastName = String(row.Lastname ?? "").trim();
    if (!firstName || !lastName) {
      skipped += 1;
      continue;
    }

    // ReferenceID is the natural employee id; fall back to a stable slug.
    const employeeId =
      String(row.ReferenceID ?? "").trim() ||
      `LEG-${slug(`${firstName}.${lastName}`).slice(0, 10)}`.toUpperCase();

    const existing = await Requestor.findOne({
      $or: [{ employeeId }, ...(email ? [{ email }] : [])],
    }).lean<{ _id: unknown }>();
    if (existing) {
      skipped += 1;
      continue;
    }

    await Requestor.create({
      employeeId,
      firstName,
      lastName,
      fullName: buildFullName(firstName, lastName),
      email,
      department: String(row.Department ?? ""),
      phone: String(row.ContactNumber ?? ""),
      status: "active",
      notes: "Imported from the legacy user directory.",
    });
    created += 1;
  }

  log(`   created ${created}, skipped ${skipped}`);
}

async function migrateTickets(
  supabase: SupabaseReader,
  userIdByLegacyId: Map<string, string>,
) {
  log("-> tickets");
  const rows = await fetchAll(supabase, "tickets");
  if (rows.length === 0) {
    log("   no legacy tickets found");
    return;
  }

  // Highest sequence seen per day, so new tickets keep counting up from history
  // instead of colliding with migrated numbers.
  const counters = new Map<string, number>();

  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    const ticketNumber = String(row.ticket_id ?? "").trim();
    if (!ticketNumber) {
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      log(`   would migrate ${ticketNumber}`);
      continue;
    }

    if (await Ticket.exists({ ticketNumber })) {
      skipped += 1;
      continue;
    }

    const dateCreated = parseDate(row.date_created) ?? new Date();
    const dateClosed = parseDate(row.date_closed);
    const dateScheduled = parseDate(row.date_scheduled);

    const requestorName = String(row.requestor_name ?? "");
    const { firstName, lastName } = splitFullName(requestorName);

    const priority = await mapDropdownValue("priority", row.priority);
    const status = await mapDropdownValue("status", row.status);
    const department = await mapDropdownValue("department", row.department);
    const requestType = await mapDropdownValue("requestType", row.request_type);
    const typeOfConcern = await mapDropdownValue("typeOfConcern", row.type_concern);
    const mode = await mapDropdownValue("mode", row.mode);
    const servicesGroup = await mapDropdownValue("servicesGroup", row.group_services);
    const site = await mapDropdownValue("site", row.site);

    const priorityValue = priority?.value ?? "p-3-medium";
    const slaHours = priority?.slaHours ?? 24;

    // Resolve the legacy name-based references onto real user ids where the
    // name still matches an account; otherwise leave them null so the ticket
    // still displays the captured name.
    const processedByName = String(row.processed_by ?? "").trim();
    const technicianName = String(row.technician_name ?? "").trim();
    const closedByName = String(row.closed_by ?? "").trim();

    const resolveUser = async (name: string): Promise<string | null> => {
      if (!name) return null;
      const account = await User.findOne({ name }).select("_id").lean<{ _id: unknown }>();
      return account ? String(account._id) : null;
    };

    const processedBy = await resolveUser(processedByName);
    const technician = await resolveUser(technicianName);
    const closedBy = await resolveUser(closedByName);

    // Find or create the requestor from the ticket's own snapshot.
    let requestorId: string | null = null;
    if (requestorName) {
      const requestor =
        (await Requestor.findOne({ fullName: requestorName }).lean<{ _id: unknown }>()) ?? null;
      if (requestor) {
        requestorId = String(requestor._id);
      } else {
        const email = "";
        const employeeId = `LEG-${slug(`${firstName}.${lastName}`).slice(0, 10)}`.toUpperCase();
        const created_ = await Requestor.findOneAndUpdate(
          { fullName: requestorName },
          {
            $setOnInsert: {
              employeeId,
              firstName,
              lastName,
              fullName: requestorName,
              email,
              department: department?.label ?? "",
              site: site?.label ?? "",
              status: "active",
              notes: "Created during the Supabase migration from a ticket snapshot.",
            },
          },
          { upsert: true, new: true },
        ).lean<{ _id: unknown }>();
        requestorId = created_ ? String(created_._id) : null;
      }
    }

    // Track the sequence so post-migration creates do not reuse a number.
    const seqMatch = /(\d+)\s*$/.exec(ticketNumber);
    if (seqMatch) {
      const day = appDateKey(dateCreated);
      const seq = Number(seqMatch[1]);
      counters.set(day, Math.max(counters.get(day) ?? 0, seq));
    }

    await Ticket.create({
      ticketNumber,
      patternVersion: 1,
      subject: String(row.ticket_subject ?? "(no subject)"),
      description: String(row.remarks ?? ""),

      requestor: requestorId,
      requestorSnapshot: {
        employeeId: "",
        fullName: requestorName,
        email: "",
        department: department?.label ?? "",
        site: site?.label ?? "",
        phone: "",
      },

      department: department?.value ?? "",
      requestType: requestType?.value ?? "",
      typeOfConcern: typeOfConcern?.value ?? "",
      mode: mode?.value ?? "",
      servicesGroup: servicesGroup?.value ?? "",
      site: site?.value ?? "",

      priority: {
        label: priority?.label ?? "P-3 - Medium",
        value: priorityValue,
        slaHours,
        color: priority?.color ?? "#eab308",
        inactive: priority?.inactive ?? false,
      },
      status: status?.value ?? "pending",

      processedBy,
      technician,
      closedBy,

      scheduledDate: dateScheduled,
      dateCreated,
      dateClosed,
      slaDueAt: dateClosed ? null : computeDueAt(slaHours, dateCreated),
      slaPausedTotalSeconds: 0,
      slaPausedAt: status?.value === "scheduled" && !dateClosed ? dateCreated : null,

      source: "manual",
      emailMessageIds: [],
      attachments: [],

      lastActivityAt: dateClosed ?? dateCreated,

      remarks: [
        {
          type: "system",
          authorName: "System",
          authorRef: null,
          content: `Imported from Supabase on ${new Date().toISOString().slice(0, 10)}`,
        },
        ...(String(row.remarks ?? "").trim()
          ? [
              {
                type: "note" as const,
                authorName: processedByName || "Unknown",
                authorRef: null,
                content: String(row.remarks),
              },
            ]
          : []),
      ],
      statusHistory: [
        {
          status: status?.value ?? "pending",
          by: processedBy,
          byName: processedByName,
          at: dateCreated,
        },
        ...(dateClosed
          ? [
              {
                status: status?.value ?? "resolved",
                by: closedBy,
                byName: closedByName,
                at: dateClosed,
              },
            ]
          : []),
      ],
      assignmentHistory: technician
        ? [{ technician, technicianName, by: processedBy, byName: processedByName, at: dateCreated }]
        : [],
    });

    created += 1;
  }

  // Persist the counters so the generator resumes after the highest legacy number.
  if (!DRY_RUN) {
    for (const [dateKey, seq] of counters) {
      await TicketCounter.updateOne(
        { dateKey },
        { $max: { seq } },
        { upsert: true },
      );
    }
    if (counters.size > 0) {
      log(`   advanced ${counters.size} daily counter(s) to match legacy numbers`);
    }
  }

  log(`   created ${created}, skipped ${skipped}`);
}

/** Legacy ticket_conversations become remarks on their ticket. */
async function migrateConversations(supabase: SupabaseReader) {
  log("-> ticket conversations -> remarks");
  const rows = await fetchAll(supabase, "ticket_conversations");
  if (rows.length === 0) {
    log("   no legacy conversations found");
    return;
  }

  let appended = 0;
  let orphaned = 0;

  for (const row of rows) {
    const legacyTicketNumber = String(row.ticket_id ?? "").trim();
    const message = String(row.message ?? "").trim();
    if (!legacyTicketNumber || !message) {
      orphaned += 1;
      continue;
    }

    if (DRY_RUN) {
      appended += 1;
      continue;
    }

    const ticket = await Ticket.findOne({ ticketNumber: legacyTicketNumber }).select("_id");
    if (!ticket) {
      orphaned += 1;
      continue;
    }

    const sender = String(row.sender ?? "");
    await Ticket.updateOne(
      { _id: ticket._id },
      {
        $push: {
          remarks: {
            type: sender === "user" ? "email-in" : "note",
            authorName: sender === "user" ? "Requestor" : "Agent",
            authorRef: null,
            content: message,
            field: "",
            oldValue: "",
            newValue: "",
            attachments: [],
            createdAt: parseDate(row.date_created) ?? new Date(),
          },
        } as never,
      },
    );
    appended += 1;
  }

  log(`   appended ${appended} remark(s), ${orphaned} could not be matched to a ticket`);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

  if (!url || !key) {
    console.error(
      "Missing Supabase credentials.\n" +
        "Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local, then re-run.",
    );
    process.exit(1);
  }

  console.log(
    `Migrating Supabase -> MongoDB (${process.env.MONGODB_DB ?? "it_ticketing"})${DRY_RUN ? "  [DRY RUN]" : ""}\n`,
  );

  await connectDB();
  await ensureIndexes();

  if (DRY_RUN) {
    const supabase = createSupabaseReader(url, key);
    for (const table of ["users", "tickets", "ticket_conversations"]) {
      const rows = await fetchAll(supabase, table);
      log(`   ${table}: ${rows.length} row(s)`);
    }
  } else {
    await ensureDropdownOptions();
  }

  await migrateRoles();

  const supabase = createSupabaseReader(url, key);
  const userIdByLegacyId = await migrateUsers(supabase);
  await migrateRequestors(supabase);
  await migrateTickets(supabase, userIdByLegacyId);
  await migrateConversations(supabase);

  log("\nFinal counts:");
  log(`   roles             ${await Role.countDocuments()}`);
  log(`   users             ${await User.countDocuments()}`);
  log(`   requestors        ${await Requestor.countDocuments()}`);
  log(`   tickets           ${await Ticket.countDocuments()}`);
  log(`   dropdown options  ${await DropdownOption.countDocuments()}`);
  log(`   ticket counters   ${await TicketCounter.countDocuments()}`);

  console.log(
    "\nDone." +
      (DRY_RUN ? "\nThis was a dry run - nothing was written." : "") +
      "\nVerify the ticket numbers, then sign in as the seeded Super Admin.",
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("\nMigration failed:", error);
  process.exit(1);
});

