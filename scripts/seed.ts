/**
 * Seeds the default dropdown options, the four system roles, the settings
 * singleton and a Super Admin account.
 *
 * Idempotent: safe to run repeatedly. Existing rows are updated in place, never
 * duplicated. The admin's password is only set when the account is first
 * created, so re-seeding never resets a real password.
 *
 * Run with:  npm run seed
 */

import "./load-env";

import {
  Role,
  User,
  DropdownOption,
  SystemSetting,
  Requestor,
  ensureIndexes,
} from "../src/lib/models";
import { hashPassword, validatePasswordStrength } from "../src/lib/auth/password";
import { SYSTEM_ROLE_DEFAULTS, type SystemRoleName } from "../src/lib/shared/permissions";
import { SEED_DROPDOWNS, SEED_SUPER_ADMIN } from "./defaults";

async function seedRoles() {
  console.log("-> roles");
  const order: SystemRoleName[] = ["Super Admin", "Admin", "Agent", "Viewer"];
  for (const [index, key] of order.entries()) {
    const template = SYSTEM_ROLE_DEFAULTS[key];
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
    const granted = Object.values(template.permissions).filter(Boolean).length;
    console.log(`   ok ${template.name} (${granted} permissions)`);
  }
}

async function seedDropdowns() {
  console.log("-> dropdown options");
  for (const dropdown of SEED_DROPDOWNS) {
    for (const [index, option] of dropdown.options.entries()) {
      await DropdownOption.updateOne(
        { type: dropdown.type, value: option.value },
        {
          $set: {
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
    console.log(`   ok ${dropdown.type}: ${dropdown.options.length} options`);
  }
}

async function seedSettings() {
  console.log("-> system settings");
  await SystemSetting.updateOne(
    { _id: "singleton" },
    {
      $setOnInsert: {
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
      },
    },
    { upsert: true },
  );
  console.log("   ok settings singleton");
}

async function seedSuperAdmin() {
  console.log("-> super admin");
  const superAdminRole = await Role.findOne({ name: "Super Admin" });
  if (!superAdminRole) throw new Error("Super Admin role missing - run seedRoles first.");

  // Fail loudly rather than creating an account whose password the app would
  // reject on the next change.
  const strength = validatePasswordStrength(SEED_SUPER_ADMIN.password);
  if (!strength.ok) {
    throw new Error(
      `SEED_ADMIN_PASSWORD is too weak: ${strength.message} Use scripts/reset-password.ts to set one.`,
    );
  }

  const existing = await User.findOne({ email: SEED_SUPER_ADMIN.email.toLowerCase() });

  if (existing) {
    console.log(`   .. ${SEED_SUPER_ADMIN.email} already exists - password untouched`);
    return;
  }

  await User.create({
    name: SEED_SUPER_ADMIN.name,
    email: SEED_SUPER_ADMIN.email.toLowerCase(),
    employeeId: SEED_SUPER_ADMIN.employeeId,
    passwordHash: await hashPassword(SEED_SUPER_ADMIN.password),
    // Forces a password change on first login.
    mustChangePassword: true,
    role: superAdminRole._id,
    department: SEED_SUPER_ADMIN.department,
    site: SEED_SUPER_ADMIN.site,
    position: "System Administrator",
    status: "active",
  });

  console.log(`   ok ${SEED_SUPER_ADMIN.email} / "${SEED_SUPER_ADMIN.password}"`);
  console.log("   ! change this password at first sign-in");
}

async function main() {
  console.log(`Seeding IT Ticketing (db=${process.env.MONGODB_DB ?? "it_ticketing"})...\n`);

  await ensureIndexes();
  console.log("-> indexes ensured\n");

  await seedRoles();
  await seedDropdowns();
  await seedSettings();
  await seedSuperAdmin();

  const counts = {
    roles: await Role.countDocuments(),
    dropdowns: await DropdownOption.countDocuments(),
    users: await User.countDocuments(),
    requestors: await Requestor.countDocuments(),
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