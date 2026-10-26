/**
 * Seeds the default dropdown options, the four system roles, the settings
 * singleton and a SuperAdmin account.
 *
 * Idempotent: safe to run repeatedly. Existing rows are updated in place, never
 * duplicated. The admin's password is only set when the account is first
 * created, so re-seeding never resets a real password.
 *
 * Run with:  npm run seed
 */

import "./load-env";

import { connectDB } from "../src/lib/db/supabase";
import {
  roleFieldsToRow,
  dropdownFieldsToRow,
  settingsFieldsToRow,
  userFieldsToRow,
  mapRoleRow,
} from "../src/lib/db/mappers";
import { hashPassword, validatePasswordStrength } from "../src/lib/auth/password";
import { SYSTEM_ROLE_DEFAULTS, type SystemRoleName } from "../src/lib/shared/permissions";
import { SEED_DROPDOWNS, SEED_SUPER_ADMIN } from "./defaults";

const NOW = () => new Date().toISOString();

async function seedRoles() {
  console.log("-> roles");
  const supabase = await connectDB();
  const order: SystemRoleName[] = ["SuperAdmin", "Admin", "Agent", "Viewer"];
  for (const [index, key] of order.entries()) {
    const template = SYSTEM_ROLE_DEFAULTS[key];
    const row = roleFieldsToRow({
      name: template.name,
      description: template.description,
      permissions: template.permissions,
      isSystem: true,
      order: index,
    });
    const { error } = await supabase
      .from("roles")
      .upsert({ ...row, updated_at: NOW() }, { onConflict: "name" });
    if (error) throw error;

    const granted = Object.values(template.permissions).filter(Boolean).length;
    console.log(`   ok ${template.name} (${granted} permissions)`);
  }
}

async function seedDropdowns() {
  console.log("-> dropdown options");
  const supabase = await connectDB();
  for (const dropdown of SEED_DROPDOWNS) {
    for (const [index, option] of dropdown.options.entries()) {
      const row = dropdownFieldsToRow({
        type: dropdown.type,
        label: option.label,
        value: option.value,
        order: index,
        active: true,
        ...(option.slaHours !== undefined ? { slaHours: option.slaHours } : {}),
        ...(option.color !== undefined ? { color: option.color } : {}),
      });
      const { error } = await supabase
        .from("dropdown_options")
        .upsert({ ...row, updated_at: NOW() }, { onConflict: "type,value" });
      if (error) throw error;
    }
    console.log(`   ok ${dropdown.type}: ${dropdown.options.length} options`);
  }
}

async function seedSettings() {
  console.log("-> system settings");
  const supabase = await connectDB();
  const row = settingsFieldsToRow({
    ticketNumberPattern: "{PREFIX}-{YYYY}-{MM}-{DD}-{SEQ:3}",
    ticketPrefix: "DSI",
    dateFormatInNumber: "YYYY-MM-DD",
    seqPadLength: 3,
    resetSeqPerDay: true,
    patternVersion: 1,
    resendFromEmail: process.env.EMAIL_FROM ?? "",
    inboundEmail: process.env.INBOUND_EMAIL ?? "",
    rateLimits: {
      loginWindowMin: 15,
      loginMaxAttempts: 5,
      loginLockAfterFails: 10,
      ticketCreateWindowMin: 60,
      ticketCreateMax: 10,
      ticketCreateMaxUnauthenticated: 3,
      globalPerMin: 100,
      webhookPerMin: 600,
    },
    pauseSlaOnScheduled: true,
    defaultTechnicianAssignment: "self",
    sessionTimeoutMin: Number(process.env.SESSION_TIMEOUT_MIN ?? 480),
    email: {
      autoTicketPriority: "p-3-medium",
      autoTicketStatus: "Pending",
      autoTicketMode: "Email",
      autoTicketServicesGroup: "Service Desk",
      sendAutoAcknowledgement: true,
      notifyTechnicianOnInbound: true,
    },
    resendInboundSecret: process.env.RESEND_INBOUND_SECRET ?? "",
  });

  // `ignoreDuplicates` mirrors the old `$setOnInsert`: a re-seed must never
  // overwrite configuration an administrator has already edited in the UI.
  const { error } = await supabase
    .from("app_settings")
    .upsert({ id: "singleton", ...row }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;

  console.log("   ok settings singleton");
}

async function seedSuperAdmin() {
  console.log("-> SuperAdmin");
  const supabase = await connectDB();

  const { data: roleRow } = await supabase
    .from("roles")
    .select("*")
    .eq("name", "SuperAdmin")
    .maybeSingle<Record<string, unknown>>();
  if (!roleRow) throw new Error("SuperAdmin role missing - run seedRoles first.");
  const superAdminRole = mapRoleRow(roleRow);

  // Fail loudly rather than creating an account whose password the app would
  // reject on the next change.
  const strength = validatePasswordStrength(SEED_SUPER_ADMIN.password);
  if (!strength.ok) {
    throw new Error(
      `SEED_ADMIN_PASSWORD is too weak: ${strength.message} Use scripts/reset-password.ts to set one.`,
    );
  }

  const email = SEED_SUPER_ADMIN.email.toLowerCase();
  const { data: existing } = await supabase
    .from("users")
    .select("id")
    .eq("Email", email)
    .maybeSingle();

  if (existing) {
    console.log(`   .. ${email} already exists - password untouched`);
    return;
  }

  const row = userFieldsToRow({
    name: SEED_SUPER_ADMIN.name,
    email,
    employeeId: SEED_SUPER_ADMIN.employeeId,
    passwordHash: await hashPassword(SEED_SUPER_ADMIN.password),
    // Forces a password change on first login.
    mustChangePassword: true,
    roleId: superAdminRole.id,
    department: SEED_SUPER_ADMIN.department,
    site: SEED_SUPER_ADMIN.site,
    position: "System Administrator",
    status: "active",
  });

  const { error } = await supabase.from("users").insert(row);
  if (error) throw error;

  console.log(`   ok ${email} / "${SEED_SUPER_ADMIN.password}"`);
  console.log("   ! change this password at first sign-in");
}

async function main() {
  const supabase = await connectDB();
  console.log("Seeding IT Ticketing (db=supabase)...\n");

  await seedRoles();
  await seedDropdowns();
  await seedSettings();
  await seedSuperAdmin();

  const count = async (table: string) => {
    const { count: total } = await supabase
      .from(table)
      .select("*", { count: "exact", head: true });
    return total ?? 0;
  };

  const counts = {
    roles: await count("roles"),
    dropdowns: await count("dropdown_options"),
    users: await count("users"),
    requestors: await count("requestors"),
  };

  console.log(
    `\nDone. roles=${counts.roles} dropdowns=${counts.dropdowns} users=${counts.users} requestors=${counts.requestors}`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("\nSeed failed:", error);
  process.exit(1);
});
