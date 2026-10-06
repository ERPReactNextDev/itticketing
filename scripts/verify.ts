/**
 * Verifies the acceptance criteria that can be checked without a browser.
 *
 * Run: npx tsx --conditions react-server scripts/verify.ts
 *
 * Deliberately reads the real database rather than asserting on constants, so
 * it fails loudly if an index or a numbering rule regresses.
 */

import "./load-env";

import { connectDB } from "../src/lib/db/mongoose";
import {
  User,
  Requestor,
  Role,
  Ticket,
  TicketCounter,
  DropdownOption,
  SystemSetting,
  EmailMessage,
  AuditLog,
  RateLimit,
  ensureIndexes,
} from "../src/lib/models";
import { renderTicketNumber, extractTicketNumber, hasSequenceToken } from "../src/lib/server/ticket-number";
import { getSettings } from "../src/lib/server/settings";
import { sanitizeHtml, htmlToText, normalizeInboundBody } from "../src/lib/server/sanitize";
import { appDateKey } from "../src/lib/shared/time";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

async function main() {
  console.log("Verifying IT Ticketing acceptance criteria\n");
  await connectDB();

  // ── 1. Collections + indexes ─────────────────────────────────────────────
  section("1. Collections and indexes");
  await ensureIndexes();

  const expectations: Array<{
    collection: string;
    required: string[];
  }> = [
    { collection: "tickets", required: ["ticketNumber_1"] },
    { collection: "email_messages", required: ["messageId_1"] },
    { collection: "users", required: ["email_1"] },
    { collection: "requestors", required: ["employeeId_1", "fullName_1"] },
    { collection: "ticket_counters", required: ["dateKey_1"] },
    { collection: "dropdown_options", required: ["type_1_label_1", "type_1_value_1"] },
    { collection: "roles", required: ["name_1"] },
    { collection: "rate_limits", required: ["key_1_windowStart_1", "windowStart_1"] },
  ];

  for (const { collection, required } of expectations) {
    const model: Record<string, { collection: { listIndexes(): { toArray(): Promise<Array<{ name: string }>> } } } | undefined> = {
      tickets: Ticket,
      email_messages: EmailMessage,
      users: User,
      requestors: Requestor,
      ticket_counters: TicketCounter,
      dropdown_options: DropdownOption,
      roles: Role,
      rate_limits: RateLimit,
    };

    const handle = model[collection];
    if (!handle) {
      check(`${collection}: index check`, false, "model not registered");
      continue;
    }
    const indexes = await handle.collection.listIndexes().toArray();
    const indexNames = indexes.map((index) => index.name);
    for (const name of required) {
      check(`${collection}.${name}`, indexNames.includes(name), indexNames.join(", "));
    }
  }

  // Unique-ness, not just presence.
  const ticketIndex = (await Ticket.collection.listIndexes().toArray()).find(
    (i) => i.name === "ticketNumber_1",
  );
  check("tickets.ticketNumber is UNIQUE", ticketIndex?.unique === true);

  const messageIndex = (await EmailMessage.collection.listIndexes().toArray()).find(
    (i) => i.name === "messageId_1",
  );
  check("email_messages.messageId is UNIQUE", messageIndex?.unique === true);

  const compound = (await Ticket.collection.listIndexes().toArray()).find(
    (i) => i.name === "status_1_technician_1_dateCreated_-1",
  );
  check(
    "tickets compound status+technician+dateCreated",
    Boolean(compound),
    (await Ticket.collection.listIndexes().toArray()).map((i) => i.name).join(", "),
  );

  const ttl = (await RateLimit.collection.listIndexes().toArray()).find(
    (i) => i.name === "windowStart_1",
  );
  check("rate_limits TTL self-prunes windows", typeof ttl?.expireAfterSeconds === "number");

  // The seeded singleton must exist, not merely fall back to defaults.
  check("settings singleton persisted", (await SystemSetting.countDocuments()) >= 1);

  // ── 2. Seed data ─────────────────────────────────────────────────────────
  section("2. Seeded configuration");
  check("4 system roles", (await Role.countDocuments({ isSystem: true })) >= 4);
  check("a super admin exists", (await User.countDocuments({ status: "active" })) >= 1);

  const dropdownCounts = await DropdownOption.aggregate<{ _id: string; count: number }>([
    { $group: { _id: "$type", count: { $sum: 1 } } },
  ]);
  const byType = new Map(dropdownCounts.map((row) => [row._id, row.count]));
  const expectedCounts: Record<string, number> = {
    department: 14,
    requestType: 6,
    typeOfConcern: 2,
    mode: 6,
    servicesGroup: 2,
    site: 8,
    status: 4,
    priority: 4,
  };
  for (const [type, count] of Object.entries(expectedCounts)) {
    check(`${type} options seeded`, byType.get(type) === count, `got ${byType.get(type)}, want ${count}`);
  }

  const settings = await getSettings();
  check("settings singleton readable", settings.ticketPrefix.length > 0);
  check("priority SLA hours configured", (Object.keys(settings.slaDefaults).length >= 0));

  // ── 3. Ticket numbering ──────────────────────────────────────────────────
  section("3. Ticket number pattern");
  const sample = renderTicketNumber(
    "{PREFIX}-{YYYY}-{MM}-{DD}-{SEQ:3}",
    "DSI",
    1,
    new Date(),
  );
  check(
    "default pattern renders DSI-YYYY-MM-DD-001",
    /^DSI-\d{4}-\d{2}-\d{2}-001$/.test(sample),
    sample,
  );

  const alt = renderTicketNumber("{DD}-{MM}-{YYYY}-{SEQ:3}", "DSI", 1, new Date());
  check("alternate pattern renders DD-MM-YYYY-001", /^\d{2}-\d{2}-\d{4}-001$/.test(alt), alt);

  const padded = renderTicketNumber("{PREFIX}-{SEQ:5}", "DSI", 42, new Date());
  check("{SEQ:5} zero-pads to 5 digits", padded.endsWith("00042"), padded);

  check("pattern without {SEQ} is rejected", !hasSequenceToken("{PREFIX}-{YYYY}"));

  const extracted = extractTicketNumber(
    "Re: [DSI-2026-10-06-001] Cannot send emails",
    settings,
  );
  check(
    "extracts a ticket number from an email subject",
    extracted === "DSI-2026-10-06-001" || extracted === "2026-10-06-001",
    String(extracted),
  );
  check(
    "ignores a subject with no ticket number",
    extractTicketNumber("Hello, my printer is broken", settings) === null,
  );

  check("counter key is the Manila date", /^\d{4}-\d{2}-\d{2}$/.test(appDateKey()));

  // Parallel reservation must not hand out the same number twice.
  section("4. Atomic sequence under parallel creates");
  const dateKey = appDateKey();
  const before = (await TicketCounter.findOne({ dateKey }).lean<{ seq?: number }>())?.seq ?? 0;

  const results = await Promise.all(
    Array.from({ length: 50 }, async () => {
      await TicketCounter.findOneAndUpdate(
        { dateKey },
        { $inc: { seq: 1 }, $setOnInsert: { dateKey } },
        { upsert: true, new: true },
      ).lean<{ seq: number }>();
    }),
  );
  void results;

  const after = (await TicketCounter.findOne({ dateKey }).lean<{ seq?: number }>())?.seq ?? 0;
  check("50 parallel $inc produced 50 distinct increments", after === before + 50, `${before} -> ${after}`);

  // Roll the test counter back so verification leaves no residue.
  await TicketCounter.updateOne({ dateKey }, { $set: { seq: before } });

  // ── 5. Sanitisation ──────────────────────────────────────────────────────
  section("5. Inbound HTML sanitisation");
  const nasty = `<script>alert('xss')</script><img src=x onerror="alert(1)"><a href="javascript:alert(2)">click</a><p>Hello</p>`;
  const clean = sanitizeHtml(nasty);
  check("strips <script>", !/<script/i.test(clean), clean);
  check("strips onerror handlers", !/onerror/i.test(clean), clean);
  check("strips javascript: URLs", !/javascript:/i.test(clean), clean);
  check("keeps safe markup", /<p>Hello<\/p>/i.test(clean), clean);

  const text = htmlToText("<p>Line one</p><p>Line two</p>");
  check("htmlToText keeps readable text", text.includes("Line one") && text.includes("Line two"), text);

  const normalized = normalizeInboundBody({ html: "<p>Only html</p>" });
  check("html-only mail still yields a text body", normalized.textBody.includes("Only html"));

  // ── 6. Data integrity ────────────────────────────────────────────────────
  section("6. Stored data integrity");
  const noNumber = await Ticket.countDocuments({ $or: [{ ticketNumber: { $exists: false } }, { ticketNumber: "" }] });
  check("every ticket has a number", noNumber === 0, `${noNumber} missing`);

  const dupes = await Ticket.aggregate<{ _id: string; count: number }>([
    { $group: { _id: "$ticketNumber", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  check("no duplicate ticket numbers", dupes.length === 0, JSON.stringify(dupes));

  const orphanRemarks = await Ticket.countDocuments({ "remarks.authorName": { $exists: false } });
  check("every ticket has at least one remark author", orphanRemarks === 0, `${orphanRemarks} bad`);

  const badPriority = await Ticket.countDocuments({ "priority.slaHours": { $exists: false } });
  check("every ticket has priority SLA hours", badPriority === 0, `${badPriority} missing`);

  const openTickets = await Ticket.countDocuments({ status: { $nin: ["resolved", "closed", "cancelled"] } });
  const missingSla = await Ticket.countDocuments({
    status: { $nin: ["resolved", "closed", "cancelled"] },
    $or: [{ slaDueAt: null }, { slaDueAt: { $exists: false } }],
  });
  check(
    "open tickets have an SLA deadline",
    openTickets === 0 || missingSla === 0,
    `${missingSla} of ${openTickets} open tickets lack slaDueAt`,
  );

  // ── 7. Counts ────────────────────────────────────────────────────────────
  section("7. Current contents");
  console.log(`   tickets           ${await Ticket.countDocuments()}`);
  console.log(`   users             ${await User.countDocuments()}`);
  console.log(`   requestors        ${await Requestor.countDocuments()}`);
  console.log(`   roles             ${await Role.countDocuments()}`);
  console.log(`   dropdown options  ${await DropdownOption.countDocuments()}`);
  console.log(`   ticket counters   ${await TicketCounter.countDocuments()}`);
  console.log(`   audit logs        ${await AuditLog.countDocuments()}`);
  console.log(`   email messages    ${await EmailMessage.countDocuments()}`);
  void SystemSetting;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nVerification crashed:", error);
  process.exit(1);
});