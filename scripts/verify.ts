/**
 * Verifies the acceptance criteria that can be checked without a browser.
 *
 * Run: npx tsx --conditions react-server scripts/verify.ts
 *
 * Deliberately reads the real database rather than asserting on constants, so
 * it fails loudly if the seed data, the numbering rule or the atomic sequence
 * regresses.
 */

import "./load-env";

import { connectDB } from "../src/lib/db/supabase";
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
  const supabase = await connectDB();

  const countOf = async (table: string) => {
    const { count } = await supabase.from(table).select("*", { count: "exact", head: true });
    return count ?? 0;
  };

  // ── 1. Tables reachable ──────────────────────────────────────────────────
  section("1. Tables");
  const tables = [
    "roles",
    "requestors",
    "dropdown_options",
    "app_settings",
    "email_messages",
    "system_audit_logs",
    "rate_limits",
    "ticket_counters",
    "users",
    "tickets",
  ];
  for (const table of tables) {
    const { error } = await supabase.from(table).select("*", { count: "exact", head: true });
    check(`${table} readable`, !error, error?.message ?? "");
  }

  // ── 2. Seed data ─────────────────────────────────────────────────────────
  section("2. Seeded configuration");
  const { count: roleCount } = await supabase
    .from("roles")
    .select("*", { count: "exact", head: true })
    .eq("is_system", true);
  check("4 system roles", (roleCount ?? 0) >= 4, String(roleCount));

  const { count: adminCount } = await supabase
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("Status", "active");
  check("an active account exists", (adminCount ?? 0) >= 1, String(adminCount));

  const { data: dropdownRows } = await supabase.from("dropdown_options").select("type, sla_hours");
  const byType = new Map<string, number>();
  for (const row of dropdownRows ?? []) {
    const type = String((row as Record<string, unknown>).type);
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
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

  const { data: priorityRows } = await supabase
    .from("dropdown_options")
    .select("value, sla_hours")
    .eq("type", "priority");
  check(
    "every priority option carries an SLA budget",
    (priorityRows ?? []).length > 0 &&
      (priorityRows ?? []).every((row) => (row as Record<string, unknown>).sla_hours !== null),
  );

  const settings = await getSettings();
  check("settings singleton readable", settings.ticketPrefix.length > 0);

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

  // ── 4. Atomic sequence under parallel creates ────────────────────────────
  section("4. Atomic sequence under parallel creates");
  const dateKey = appDateKey();
  const { data: beforeRow } = await supabase
    .from("ticket_counters")
    .select("seq")
    .eq("date_key", dateKey)
    .maybeSingle<Record<string, unknown>>();
  const before = Number(beforeRow?.seq ?? 0);

  const reservations = await Promise.all(
    Array.from({ length: 50 }, () =>
      supabase.rpc("next_ticket_seq", { p_date_key: dateKey }),
    ),
  );
  const seqs = reservations.map((r) => Number(r.data ?? 0));
  check("50 parallel reservations returned 50 distinct numbers", new Set(seqs).size === 50);

  const { data: afterRow } = await supabase
    .from("ticket_counters")
    .select("seq")
    .eq("date_key", dateKey)
    .maybeSingle<Record<string, unknown>>();
  const after = Number(afterRow?.seq ?? 0);
  check("counter advanced by exactly 50", after === before + 50, `${before} -> ${after}`);

  // Roll the test counter back so verification leaves no residue.
  if (before === 0) {
    await supabase.from("ticket_counters").delete().eq("date_key", dateKey);
  } else {
    await supabase.from("ticket_counters").update({ seq: before }).eq("date_key", dateKey);
  }

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
  const { count: noNumber } = await supabase
    .from("tickets")
    .select("*", { count: "exact", head: true })
    .or("ticket_id.is.null,ticket_id.eq.");
  check("every ticket has a number", (noNumber ?? 0) === 0, `${noNumber} missing`);

  const { data: numberRows } = await supabase.from("tickets").select("ticket_id");
  const numbers = (numberRows ?? []).map((row) => String((row as Record<string, unknown>).ticket_id ?? ""));
  const dupes = numbers.filter((value, index) => value && numbers.indexOf(value) !== index);
  check("no duplicate ticket numbers", dupes.length === 0, JSON.stringify([...new Set(dupes)]));

  const { count: openTickets } = await supabase
    .from("tickets")
    .select("*", { count: "exact", head: true })
    .not("status", "in", "(resolved,closed,cancelled)");
  const { count: missingSla } = await supabase
    .from("tickets")
    .select("*", { count: "exact", head: true })
    .not("status", "in", "(resolved,closed,cancelled)")
    .is("sla_due_at", null);
  check(
    "open tickets have an SLA deadline",
    (openTickets ?? 0) === 0 || (missingSla ?? 0) === 0,
    `${missingSla} of ${openTickets} open tickets lack sla_due_at`,
  );

  // ── 7. Counts ────────────────────────────────────────────────────────────
  section("7. Current contents");
  for (const table of tables) {
    console.log(`   ${table.padEnd(17)} ${await countOf(table)}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nVerification crashed:", error);
  process.exit(1);
});
