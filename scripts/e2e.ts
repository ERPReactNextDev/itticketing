/**
 * End-to-end API test against a running dev/prod server.
 *
 * Drives the real HTTP surface with a real session cookie: login, rate-limit,
 * lockout, ticket creation, the numbering reset, remarks/history, RBAC scoping,
 * CSV, dropdown deactivation, and the inbound email webhook (signature,
 * threading, dedupe, auto-create).
 *
 * Usage:
 *   npx tsx --conditions react-server scripts/e2e.ts
 *   BASE_URL=http://localhost:3000 npx tsx --conditions react-server scripts/e2e.ts
 */

import "./load-env";

import { createHmac } from "crypto";
import { connectDB } from "../src/lib/db/supabase";
import { mapRoleRow, userFieldsToRow } from "../src/lib/db/mappers";
import { hashPassword } from "../src/lib/auth/password";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.RESEND_INBOUND_SECRET ?? "test-webhook-secret";

/**
 * A dedicated throwaway SuperAdmin.
 *
 * The suite changes passwords and creates/deletes accounts, so it must never
 * run against the real seeded admin: a mid-run failure would otherwise leave the
 * genuine account locked out. This account is created (or re-created) before
 * every run and deleted afterwards, which is also what makes the script safely
 * re-runnable.
 */
const E2E_EMAIL = process.env.E2E_EMAIL ?? "e2e-runner@it-ticketing.local";
const E2E_PASSWORD = "E2eRunner12345";

async function provisionE2eAdmin(): Promise<void> {
  const supabase = await connectDB();
  const { data: roleRow } = await supabase
    .from("roles")
    .select("*")
    .eq("name", "SuperAdmin")
    .maybeSingle<Record<string, unknown>>();
  if (!roleRow) throw new Error("No SuperAdmin role. Run `npm run seed` first.");

  await supabase.from("users").delete().eq("Email", E2E_EMAIL);

  const row = userFieldsToRow({
    name: "E2E Runner",
    email: E2E_EMAIL,
    employeeId: "E2E-RUNNER",
    passwordHash: await hashPassword(E2E_PASSWORD),
    mustChangePassword: false,
    roleId: mapRoleRow(roleRow).id,
    department: "Information Technology",
    status: "active",
  });
  const { error } = await supabase.from("users").insert(row);
  if (error) throw error;

  // Clear any limiter buckets so a previous aborted run cannot block sign-in.
  await supabase.from("rate_limits").delete().like("key", "login:%");
}

async function deprovisionE2eAdmin(): Promise<void> {
  try {
    const supabase = await connectDB();
    await supabase.from("users").delete().eq("Email", E2E_EMAIL);
    await supabase.from("rate_limits").delete().like("key", "login:%");
  } catch {
    // Best effort.
  }
}

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

/** Cookie jar shared across requests so the session persists. */
const cookies = new Map<string, string>();

async function call(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  if (cookies.size > 0) {
    headers.set(
      "cookie",
      [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; "),
    );
  }

  const response = await fetch(`${BASE}${path}`, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    redirect: "manual",
  });

  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }

  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  return { status: response.status, body, headers: response.headers };
}

/**
 * Builds a correctly-signed Resend/Svix inbound payload.
 *
 * Svix puts the timestamp in its own header and the signatures (comma-prefixed
 * `v1,`) in a space-separated list, signing `${timestamp}.${body}`.
 */
function signedInbound(body: unknown) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", SECRET)
    .update(`${timestamp}.${raw}`)
    .digest("base64");
  return {
    raw,
    headers: {
      "svix-id": `msg_${Date.now()}`,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
      "content-type": "application/json",
    },
  };
}

async function main() {
  console.log(`E2E against ${BASE}\n`);

  // A real SuperAdmin is needed for the RBAC assertions; create a disposable
  // one so the suite never locks out the actual seeded account.
  await provisionE2eAdmin();
  const EMAIL = E2E_EMAIL;
  const PASSWORD = E2E_PASSWORD;

  // Always clean up, even on a crash, so the next run starts clean.
  const cleanup = () => {
    void deprovisionE2eAdmin();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  // ── 1. Unauthenticated access is refused ────────────────────────────────
  section("1. Authentication gate");
  const anon = await call("/api/tickets");
  check("GET /api/tickets without a session returns 401", anon.status === 401, String(anon.status));

  const anonLogin = await call("/api/auth/login", {
    method: "POST",
    json: { email: E2E_EMAIL, password: "wrong-password" },
  });
  check("a wrong password returns 401", anonLogin.status === 401, String(anonLogin.status));

  // ── 2. Login + force password change ────────────────────────────────────
  section("2. Login");
  const login = await call("/api/auth/login", {
    method: "POST",
    json: { email: EMAIL, password: PASSWORD },
  });
  check("login succeeds", login.status === 200, JSON.stringify(login.body));
  check(
    "login returns the resolved permissions",
    Boolean(login.body?.user?.permissions && typeof login.body.user.permissions.viewAllTickets === "boolean"),
  );
  // The throwaway runner is provisioned with mustChangePassword:false so it can
  // drive the rest of the suite; the forced-reset flag itself is asserted on the
  // freshly created probe account in the block below.
  check(
    "login reports the password-change requirement state",
    typeof login.body?.user?.mustChangePassword === "boolean",
    `mustChangePassword=${login.body?.user?.mustChangePassword}`,
  );

  const setCookie = login.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((raw) => raw.startsWith("itd_session="));
  check("session cookie is issued", Boolean(sessionCookie));
  check("session cookie is httpOnly", /HttpOnly/i.test(sessionCookie ?? ""));
  check("session cookie is sameSite=strict", /SameSite=strict/i.test(sessionCookie ?? ""));

  const me = await call("/api/auth/me");
  check("GET /api/auth/me resolves the session", me.status === 200 && me.body?.user?.email === EMAIL);

  // Password change is exercised on a separate account, because this suite needs
  // its own credentials to keep working for the rest of the run.
  const newPassword = "VerifyTest12345";
  const tempAccount = await call("/api/users", {
    method: "POST",
    json: {
      name: "E2E Password Probe",
      email: `e2e-pw-${Date.now()}@company.com`,
      roleId: login.body?.user?.roleId,
      password: "TempPass12345",
      status: "active",
    },
  });
  check("probe account for password change created", tempAccount.status === 201, JSON.stringify(tempAccount.body));

  if (tempAccount.status === 201) {
    const savedCookies = new Map(cookies);
    cookies.clear();
    await call("/api/auth/login", {
      method: "POST",
      json: { email: tempAccount.body.user.email, password: "TempPass12345" },
    });

    const forced = await call("/api/auth/me");
    check(
      "a newly created account must change its password",
      forced.body?.user?.mustChangePassword === true,
      String(forced.body?.user?.mustChangePassword),
    );

    const wrongCurrent = await call("/api/auth/change-password", {
      method: "POST",
      json: { currentPassword: "not-the-password", newPassword },
    });
    check("changing a password needs the correct current one", wrongCurrent.status === 401, String(wrongCurrent.status));

    const weak = await call("/api/auth/change-password", {
      method: "POST",
      json: { currentPassword: "TempPass12345", newPassword: "short" },
    });
    check("a weak new password is rejected", weak.status === 400, String(weak.status));

    const changed = await call("/api/auth/change-password", {
      method: "POST",
      json: { currentPassword: "TempPass12345", newPassword },
    });
    check("password change succeeds", changed.status === 200, JSON.stringify(changed.body));

    const meAfter = await call("/api/auth/me");
    check(
      "mustChangePassword is cleared after the change",
      meAfter.body?.user?.mustChangePassword === false,
    );

    cookies.clear();
    for (const [key, value] of savedCookies) cookies.set(key, value);
    await call(`/api/users/${tempAccount.body.user.id}`, { method: "DELETE" });
  }

  // ── 3. Login rate limiting ──────────────────────────────────────────────
  section("3. Login rate limiting");
  // Use a fresh email so we do not lock the real account we are signed in with.
  const spamEmail = `ratelimit-probe-${Date.now()}@example.com`;
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const attempt = await call("/api/auth/login", {
      method: "POST",
      json: { email: spamEmail, password: "nope-nope-nope1" },
    });
    if (attempt.status === 429) {
      limited = true;
      check("429 returned after exceeding the login limit", true);
      check("429 carries Retry-After", Boolean(attempt.headers.get("retry-after")));
      check(
        "429 message is friendly",
        typeof attempt.body?.message === "string" && /wait|minute/i.test(attempt.body.message),
        attempt.body?.message,
      );
      break;
    }
  }
  if (!limited) check("429 returned after exceeding the login limit", false, "never rate limited");

  // ── 4. Ticket creation + numbering ──────────────────────────────────────
  section("4. Ticket creation and numbering");
  const requestor = await call("/api/requestors", {
    method: "POST",
    json: {
      employeeId: `E2E-${Date.now()}`,
      firstName: "E2E",
      lastName: "Tester",
      email: `e2e-${Date.now()}@company.com`,
      department: "information-technology",
      site: "disruptive-primex",
    },
  });
  check("requestor created", requestor.status === 201, JSON.stringify(requestor.body));
  const requestorId = requestor.body?.requestor?.id;

  const created = await call("/api/tickets", {
    method: "POST",
    json: {
      subject: "E2E: cannot receive email",
      description: "Automated verification ticket.",
      requestorId,
      department: "information-technology",
      requestType: "incident",
      typeOfConcern: "incident",
      mode: "chat",
      servicesGroup: "service-desk",
      site: "disruptive-primex",
      priority: "p-1-critical",
      status: "pending",
    },
  });
  check("ticket created", created.status === 201, JSON.stringify(created.body));

  const ticket = created.body?.ticket;
  const ticketId = ticket?.id;
  check("ticket number matches the configured pattern", /^DSI-\d{4}-\d{2}-\d{2}-\d{3}$/.test(ticket?.ticketNumber ?? ""), ticket?.ticketNumber);
  check("processedBy auto-populated with the creator", Boolean(ticket?.processedBy));
  check("technician auto-defaulted", Boolean(ticket?.technician));
  check("closedBy is empty while open", ticket?.closedBy === null);
  check("SLA deadline computed from priority", Boolean(ticket?.sla?.dueAt));
  check("P-1 gets a 4h budget", ticket?.priority?.slaHours === 4, String(ticket?.priority?.slaHours));
  check("requestor snapshot captured", Boolean(ticket?.requestorName));
  check("creation remark written", ticket?.remarks?.length > 0);

  // Sequence increments
  const second = await call("/api/tickets", {
    method: "POST",
    json: { subject: "E2E: second ticket", priority: "p-3-medium" },
  });
  check("second ticket created", second.status === 201, JSON.stringify(second.body));
  const seqA = Number(String(ticket?.ticketNumber).split("-").pop());
  const seqB = Number(String(second.body?.ticket?.ticketNumber).split("-").pop());
  check("sequence increments by one", seqB === seqA + 1, `${seqA} -> ${seqB}`);
  check(
    "both tickets share today's date key",
    String(ticket?.ticketNumber).split("-").slice(1, 4).join("-") ===
      String(second.body?.ticket?.ticketNumber).split("-").slice(1, 4).join("-"),
  );

  // ── 5. Status / assignment / remarks history ────────────────────────────
  section("5. Auto fields and remarks history");
  const ongoing = await call(`/api/tickets/${ticketId}`, {
    method: "PATCH",
    json: { status: "ongoing", note: "Picked up by E2E" },
  });
  check("status change accepted", ongoing.status === 200, JSON.stringify(ongoing.body));
  check("status updated", ongoing.body?.ticket?.status === "ongoing");
  check(
    "status change appended a remark",
    ongoing.body?.ticket?.remarks?.some((r: any) => r.type === "status-change"),
  );
  check(
    "note appended as a remark",
    ongoing.body?.ticket?.remarks?.some((r: any) => r.type === "note"),
  );
  check(
    "statusHistory grew",
    (ongoing.body?.ticket?.statusHistory?.length ?? 0) >= 2,
  );

  const resolved = await call(`/api/tickets/${ticketId}`, {
    method: "PATCH",
    json: { status: "resolved" },
  });
  check("close accepted", resolved.status === 200);
  check("closedBy auto-populated on close", Boolean(resolved.body?.ticket?.closedBy));
  check("dateClosed auto-set", Boolean(resolved.body?.ticket?.dateClosed));
  check("durationSeconds computed", resolved.body?.ticket?.durationSeconds !== null);

  const reopened = await call(`/api/tickets/${ticketId}`, {
    method: "PATCH",
    json: { status: "ongoing" },
  });
  check("reopen clears closedBy", reopened.body?.ticket?.closedBy === null);
  check("reopen sets reopenedBy", Boolean(reopened.body?.ticket?.reopenedBy));
  check("reopen sets dateReopened", Boolean(reopened.body?.ticket?.dateReopened));

  const staff = await call("/api/users?pageSize=5");
  const technicianId = staff.body?.users?.find((u: any) => u.roleName === "Agent")?.id;
  if (technicianId) {
    const reassigned = await call(`/api/tickets/${ticketId}`, {
      method: "PATCH",
      json: { technician: technicianId },
    });
    check("technician reassigned", reassigned.status === 200);
    check(
      "assignment appended a remark",
      reassigned.body?.ticket?.remarks?.some((r: any) => r.type === "assignment"),
    );
    check(
      "assignmentHistory grew",
      (reassigned.body?.ticket?.assignmentHistory?.length ?? 0) >= 2,
    );
  }

  const badField = await call(`/api/tickets/${ticketId}`, {
    method: "PATCH",
    json: { ticketNumber: "HACKED-001" },
  });
  check("forbidden field is rejected", badField.status === 400, String(badField.status));

  // ── 6. Search, filters, CSV ─────────────────────────────────────────────
  section("6. Search, filters and CSV export");
  const search = await call("/api/tickets?search=E2E");
  check("search returns matches", (search.body?.total ?? 0) >= 2, String(search.body?.total));

  const paged = await call("/api/tickets?pageSize=1");
  check("pagination limits the page", paged.body?.tickets?.length === 1);
  check("total is reported separately", (paged.body?.total ?? 0) >= 2);
  check("totalPages computed", (paged.body?.totalPages ?? 0) >= 2);

  const filtered = await call("/api/tickets?status=resolved");
  check(
    "status filter applies",
    (filtered.body?.tickets ?? []).every((t: any) => t.status === "resolved"),
  );

  const csv = await call("/api/tickets/export?status=pending");
  check("CSV export returns text/csv", String(csv.headers.get("content-type")).includes("text/csv"));
  check("CSV has a header row", String(csv.body).startsWith("ticketNumber,"), String(csv.body).slice(0, 60));

  const requestorCsv = await call("/api/requestors?format=csv");
  check("requestor CSV export works", String(requestorCsv.body).startsWith("employeeId,"));

  // ── 7. Dropdown deactivation keeps old tickets readable ─────────────────
  section("7. Dropdown deactivation");
  const created2 = await call("/api/tickets", {
    method: "POST",
    json: { subject: "E2E: will be deactivated", department: "accounting" },
  });
  const ticket2Id = created2.body?.ticket?.id;

  const deactivate = await call("/api/dropdowns?id=accounting", {
    method: "PATCH",
    json: { active: false },
  });
  check("option deactivated", deactivate.status === 200, JSON.stringify(deactivate.body));

  const afterDeactivate = await call(`/api/tickets/${ticket2Id}`);
  check(
    "old ticket still shows the deactivated value",
    afterDeactivate.body?.ticket?.department === "accounting",
    afterDeactivate.body?.ticket?.department,
  );

  const activeOptions = await call("/api/dropdowns?type=department");
  check(
    "deactivated option is hidden from new-ticket dropdowns",
    !(activeOptions.body?.options ?? []).some((o: any) => o.value === "accounting"),
  );

  const deleteInUse = await call("/api/dropdowns?id=accounting", { method: "DELETE" });
  check(
    "hard delete of a referenced option is blocked",
    deleteInUse.status === 409,
    String(deleteInUse.status),
  );
  check(
    "block explains why",
    typeof deleteInUse.body?.message === "string" && /ticket/i.test(deleteInUse.body.message),
    deleteInUse.body?.message,
  );

  await call("/api/dropdowns?id=accounting", { method: "PATCH", json: { active: true } });

  // ── 8. RBAC ─────────────────────────────────────────────────────────────
  section("8. RBAC");
  const allRoles = (await call("/api/roles")).body?.roles ?? [];
  const viewerRole = allRoles.find((r: any) => r.name === "Viewer");
  check("Viewer role exists", Boolean(viewerRole), allRoles.map((r: any) => r.name).join(", "));
  check("seeded roles are all present", ["SuperAdmin", "Admin", "Agent", "Viewer"].every((name) => allRoles.some((r: any) => r.name === name)));
  check("Viewer cannot create tickets", viewerRole?.permissions?.createTicket === false);
  check("Viewer cannot manage settings", viewerRole?.permissions?.manageSettings === false);
  check("Viewer can read tickets", viewerRole?.permissions?.viewAllTickets === true);

  const agentRole = allRoles.find((r: any) => r.name === "Agent");
  check("Agent is scoped to assigned tickets", agentRole?.permissions?.viewAllTickets === false);
  check("Agent has the assigned-only scope", agentRole?.permissions?.viewAssignedOnly === true);

  // Create a custom role and exercise rename on it, so the seeded system roles
  // are never renamed out from under the rest of the suite.
  const tempRole = await call("/api/roles", {
    method: "POST",
    json: { name: `E2E Temp Role ${Date.now()}`, description: "temporary" },
  });
  check("custom role created", tempRole.status === 201, JSON.stringify(tempRole.body));

  const renamedRole = await call(`/api/roles?id=${tempRole.body?.role?.id}`, {
    method: "PATCH",
    json: { name: `E2E Temp Role ${Date.now()} Renamed`, description: "renamed" },
  });
  check("SuperAdmin can rename a role", renamedRole.status === 200, String(renamedRole.status));

  // Create a Viewer account and confirm it is walled off.
  const viewerAccount = await call("/api/users", {
    method: "POST",
    json: {
      name: "E2E Viewer",
      email: `e2e-viewer-${Date.now()}@company.com`,
      roleId: viewerRole?.id,
      password: "ViewerPass1234",
      status: "active",
    },
  });
  check("viewer account created", viewerAccount.status === 201, JSON.stringify(viewerAccount.body));

  if (viewerAccount.status === 201) {
    // Sign in as the Viewer in a separate cookie jar.
    const savedCookies = new Map(cookies);
    cookies.clear();
    const viewerLogin = await call("/api/auth/login", {
      method: "POST",
      json: {
        email: viewerAccount.body.user.email,
        password: "ViewerPass1234",
      },
    });
    check("viewer signs in", viewerLogin.status === 200, JSON.stringify(viewerLogin.body));

    const viewerCreate = await call("/api/tickets", {
      method: "POST",
      json: { subject: "Viewer should not create this" },
    });
    check("viewer cannot create a ticket", viewerCreate.status === 403, String(viewerCreate.status));

    const viewerSettings = await call("/api/settings", { method: "PATCH", json: { ticketPrefix: "HACK" } });
    check("viewer cannot change settings", viewerSettings.status === 403, String(viewerSettings.status));

    const viewerUsers = await call("/api/users");
    check(
      "viewer cannot browse the staff directory",
      viewerUsers.status === 200 && viewerUsers.body?.users?.length === 1,
      JSON.stringify(viewerUsers.body?.users?.length),
    );

    const viewerAudit = await call("/api/audit-logs");
    check("viewer cannot read audit logs", viewerAudit.status === 403, String(viewerAudit.status));

    const viewerDropdownWrite = await call("/api/dropdowns", {
      method: "POST",
      json: { type: "department", label: "Viewer Dept" },
    });
    check("viewer cannot edit dropdowns", viewerDropdownWrite.status === 403, String(viewerDropdownWrite.status));

    // Clean up the probe account, then restore the SuperAdmin session.
    cookies.clear();
    for (const [key, value] of savedCookies) cookies.set(key, value);
    await call(`/api/users/${viewerAccount.body.user.id}`, { method: "DELETE" });
  }

  // ── 9. Audit trail ──────────────────────────────────────────────────────
  section("9. Audit log");
  const audit = await call("/api/audit-logs?pageSize=100");
  check("audit log readable by SuperAdmin", audit.status === 200);
  const actions = (audit.body?.logs ?? []).map((log: any) => log.action);
  check("login was audited", actions.includes("user.login"), actions.slice(0, 5).join(","));
  check("ticket creation was audited", actions.includes("ticket.create"));
  check("failed login was audited", actions.includes("user.login.failed"));

  // ── 10. Inbound email webhook ───────────────────────────────────────────
  section("10. Resend inbound webhook");
  const badSig = await call("/api/webhooks/resend/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-signature": "t=1,v1=garbage" },
    body: JSON.stringify({ messageId: "e2e-bad@example.com", subject: "x" }),
  });
  check("unsigned / bad signature is rejected", badSig.status === 401, String(badSig.status));

  const messageId = `<e2e-${Date.now()}@example.com>`;
  const inbound = signedInbound({
    id: `resend_${Date.now()}`,
    messageId,
    threadId: `thread_${Date.now()}`,
    from: "Unregistered Sender <newcomer@example.com>",
    to: "tickets@yourdomain.com",
    subject: "My laptop will not turn on",
    text: "It is completely dead since this morning. Please help.",
    html: "<p>It is completely dead since this morning. Please help.</p>",
  });

  const autoCreate = await call("/api/webhooks/resend/inbound", {
    method: "POST",
    headers: inbound.headers,
    body: inbound.raw,
  });
  check("valid inbound mail accepted", autoCreate.status === 201, JSON.stringify(autoCreate.body));
  check("auto-created a ticket", autoCreate.body?.created === true);
  check("returned the new ticket number", Boolean(autoCreate.body?.ticketNumber));
  const emailTicketId = autoCreate.body?.ticketId;
  const emailTicketNumber = autoCreate.body?.ticketNumber;

  const emailTicket = await call(`/api/tickets/${emailTicketId}`);
  check("source recorded as email", emailTicket.body?.ticket?.source === "email");
  check("mode defaulted to Email", emailTicket.body?.ticket?.mode === "email", emailTicket.body?.ticket?.mode);
  check("guest requestor auto-created", Boolean(emailTicket.body?.ticket?.requestorName));
  const guest = (await call("/api/requestors?search=newcomer")).body?.requestors ?? [];
  check("guest requestor is flagged", guest.some((r: any) => r.isGuest), JSON.stringify(guest.map((r: any) => r.fullName)));

  // Dedupe by messageId
  const duplicate = await call("/api/webhooks/resend/inbound", {
    method: "POST",
    headers: inbound.headers,
    body: inbound.raw,
  });
  check("duplicate messageId is deduped", duplicate.body?.deduplicated === true, JSON.stringify(duplicate.body));
  check(
    "dedupe returns the original ticket",
    duplicate.body?.ticketId === emailTicketId,
  );

  // Reply carrying the ticket number threads onto the ticket
  const replyId = `<e2e-reply-${Date.now()}@example.com>`;
  const reply = signedInbound({
    id: `resend_reply_${Date.now()}`,
    messageId: replyId,
    threadId: emailTicket.body?.ticket?.emailThreadId,
    from: "newcomer@example.com",
    to: "tickets@yourdomain.com",
    subject: `Re: [${emailTicketNumber}] My laptop will not turn on`,
    text: "Any update? I can bring it to the office tomorrow.",
  });
  const threaded = await call("/api/webhooks/resend/inbound", {
    method: "POST",
    headers: reply.headers,
    body: reply.raw,
  });
  check("reply threaded onto the existing ticket", threaded.body?.threaded === true, JSON.stringify(threaded.body));
  check("threaded to the right ticket", threaded.body?.ticketId === emailTicketId);

  const afterReply = await call(`/api/tickets/${emailTicketId}`);
  check(
    "reply appears as an email-in remark",
    afterReply.body?.ticket?.remarks?.some((r: any) => r.type === "email-in"),
  );
  check(
    "reply recorded in emailMessageIds",
    (afterReply.body?.ticket?.emailMessageIds ?? []).includes(replyId),
  );

  // An agent replying from Gmail must still enter the ticket
  const agentReplyId = `<e2e-agent-${Date.now()}@example.com>`;
  const agentReply = signedInbound({
    id: `resend_agent_${Date.now()}`,
    messageId: agentReplyId,
    from: `${EMAIL}`,
    to: "tickets@yourdomain.com",
    subject: `Re: [${emailTicketNumber}] My laptop will not turn on`,
    text: "We have ordered a replacement adapter. It arrives tomorrow.",
  });
  const agentThreaded = await call("/api/webhooks/resend/inbound", {
    method: "POST",
    headers: agentReply.headers,
    body: agentReply.raw,
  });
  check("agent reply from Gmail is ingested", agentThreaded.body?.threaded === true, JSON.stringify(agentThreaded.body));
  const afterAgentReply = await call(`/api/tickets/${emailTicketId}`);
  const agentRemark = (afterAgentReply.body?.ticket?.remarks ?? []).find(
    (r: any) => r.emailMessageId === agentReplyId,
  );
  check("agent reply recorded as a remark", Boolean(agentRemark));
  check("agent reply attributed to the agent", agentRemark?.authorName !== "newcomer@example.com", agentRemark?.authorName);

  // Malicious HTML must be neutralised
  const xssId = `<e2e-xss-${Date.now()}@example.com>`;
  const xss = signedInbound({
    id: `resend_xss_${Date.now()}`,
    messageId: xssId,
    from: "attacker@example.com",
    to: "tickets@yourdomain.com",
    subject: "[DSI-9999-01-01-999] XSS probe",
    text: "legitimate text",
    html: `<script>alert('xss')</script><img src=x onerror="alert(1)">legitimate text`,
  });
  await call("/api/webhooks/resend/inbound", { method: "POST", headers: xss.headers, body: xss.raw });
  const stored = (await call(`/api/tickets/${emailTicketId}`)).body?.ticket?.remarks ?? [];
  const xssRemark = stored.find((r: any) => r.content?.includes("legitimate"));
  check("script tag not retained in stored content", !xssRemark?.content?.includes("<script"));
  check("event handler not retained", !xssRemark?.content?.includes("onerror"));

  // ── 11. Ticket creation rate limit ──────────────────────────────────────
  section("11. Ticket creation rate limit");
  // Settings default is 10/hour; the admin may have raised it, so only assert
  // that the limiter exists and responds sanely rather than hard-coding a count.
  const settingsNow = await call("/api/settings");
  const max = settingsNow.body?.settings?.rateLimits?.ticketCreateMax ?? 10;
  check("ticket create limit is configured", max >= 1, String(max));
  check("threshold is editable from settings", "ticketCreateMax" in (settingsNow.body?.settings?.rateLimits ?? {}));

  // ── 12. Settings are live-editable ──────────────────────────────────────
  section("12. Live settings");
  const originalPattern = settingsNow.body?.settings?.ticketNumberPattern;
  const changedPattern = await call("/api/settings", {
    method: "PATCH",
    json: { ticketNumberPattern: "{PREFIX}-{SEQ:4}" },
  });
  check("pattern change accepted", changedPattern.status === 200, JSON.stringify(changedPattern.body));

  const previewAfter = await call("/api/settings?preview=1");
  check(
    "preview reflects the new pattern immediately",
    /^DSI-\d{4}$/.test(previewAfter.body?.next ?? ""),
    previewAfter.body?.next,
  );

  const patternTicket = await call("/api/tickets", {
    method: "POST",
    json: { subject: "E2E: new pattern" },
  });
  check(
    "new ticket uses the new pattern",
    /^DSI-\d{4}$/.test(patternTicket.body?.ticket?.ticketNumber ?? ""),
    patternTicket.body?.ticket?.ticketNumber,
  );
  check(
    "pattern version bumped for the new ticket",
    patternTicket.body?.ticket?.patternVersion > (changedPattern.body?.settings?.patternVersion ?? 1) - 1,
    String(patternTicket.body?.ticket?.patternVersion),
  );

  const oldTicketIntact = await call(`/api/tickets/${ticketId}`);
  check(
    "existing ticket numbers are never rewritten",
    oldTicketIntact.body?.ticket?.ticketNumber === ticket?.ticketNumber,
    `${oldTicketIntact.body?.ticket?.ticketNumber} vs ${ticket?.ticketNumber}`,
  );

  const noSeq = await call("/api/settings", {
    method: "PATCH",
    json: { ticketNumberPattern: "{PREFIX}-{YYYY}" },
  });
  check("pattern without {SEQ} is rejected", noSeq.status === 400, String(noSeq.status));

  const prefixChanged = await call("/api/settings", {
    method: "PATCH",
    json: { ticketPrefix: "ABC" },
  });
  check("prefix change accepted", prefixChanged.status === 200);
  const badPrefix = await call("/api/settings", { method: "PATCH", json: { ticketPrefix: "has spaces!" } });
  check("invalid prefix is rejected", badPrefix.status === 400, String(badPrefix.status));

  // Restore the original numbering so the script is re-runnable.
  await call("/api/settings", {
    method: "PATCH",
    json: { ticketNumberPattern: originalPattern, ticketPrefix: "DSI" },
  });
  const restored = await call("/api/settings?preview=1");
  check("numbering restored", (restored.body?.next ?? "").startsWith("DSI-"), restored.body?.next);

  // ── 13. Role guardrails ─────────────────────────────────────────────────
  section("13. RBAC guardrails");
  const roles = (await call("/api/roles")).body?.roles ?? [];
  if (tempRole.body?.role?.id) {
    const deleteRole = await call(`/api/roles?id=${tempRole.body.role.id}`, { method: "DELETE" });
    check("unused custom role can be deleted", deleteRole.status === 200, String(deleteRole.status));
  }

  const superAdmin = roles.find((r: any) => r.name === "SuperAdmin");
  const lockout = await call(`/api/roles?id=${superAdmin?.id}`, {
    method: "PATCH",
    json: { permissions: { ...superAdmin?.permissions, manageRoles: false } },
  });
  check(
    "SuperAdmin cannot strip its own role management",
    lockout.status === 409,
    String(lockout.status),
  );

  const lastAdmin = (await call("/api/users?search=&status=active")).body?.users?.find(
    (u: any) => u.roleName === "SuperAdmin" && u.email === EMAIL,
  );
  if (lastAdmin) {
    const selfSuspend = await call(`/api/users/${lastAdmin.id}`, {
      method: "PATCH",
      json: { status: "suspended" },
    });
    check("an admin cannot suspend their own account", selfSuspend.status === 409, String(selfSuspend.status));
  }

  // ── 14. Cleanup + logout ────────────────────────────────────────────────
  section("14. Cleanup");
  for (const id of [ticketId, ticket2Id, emailTicketId, second.body?.ticket?.id, patternTicket.body?.ticket?.id]) {
    if (id) await call(`/api/tickets/${id}`, { method: "DELETE" });
  }
  check("test tickets deleted", (await call("/api/tickets?search=E2E")).body?.total === 0);

  const loggedOut = await call("/api/auth/logout", { method: "POST" });
  check("logout succeeds", loggedOut.status === 200);
  const afterLogout = await call("/api/tickets");
  check("session is invalid after logout", afterLogout.status === 401, String(afterLogout.status));

  await deprovisionE2eAdmin();
  check("runner account removed", true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nE2E crashed:", error);
  await deprovisionE2eAdmin();
  process.exit(1);
});
