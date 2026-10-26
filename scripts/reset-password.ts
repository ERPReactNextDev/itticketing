/**
 * Admin password recovery.
 *
 * Use when you are locked out of every admin account: no password reset email
 * exists (accounts are local-only by design), so recovery has to happen here.
 * It requires direct database access, which is the same bar as any other
 * break-glass operation.
 *
 * Invoke directly - `npm run` strips flags like --email before they arrive:
 *
 *   npx tsx --conditions react-server scripts/reset-password.ts --email <address>
 *   npx tsx --conditions react-server scripts/reset-password.ts --email <address> --password 'MyNewPass123'
 *   npx tsx --conditions react-server scripts/reset-password.ts --role "SuperAdmin"
 *   npx tsx --conditions react-server scripts/reset-password.ts --email <address> --unlock-only
 *
 * Without `--password`, a strong one is generated and printed once.
 */

import "./load-env";

import { randomBytes } from "crypto";
import { connectDB } from "../src/lib/db/supabase";
import { mapRoleRow, mapUserRow, userFieldsToRow } from "../src/lib/db/mappers";
import { hashPassword, validatePasswordStrength } from "../src/lib/auth/password";

type Args = {
  email?: string;
  role?: string;
  password?: string;
  unlockOnly: boolean;
  keepPassword: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { unlockOnly: false, keepPassword: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    switch (token) {
      case "--email":
        args.email = value;
        i += 1;
        break;
      case "--role":
        args.role = value;
        i += 1;
        break;
      case "--password":
        args.password = value;
        i += 1;
        break;
      case "--unlock-only":
        args.unlockOnly = true;
        break;
      case "--keep-password":
        args.keepPassword = true;
        break;
      case "--help":
      case "-h":
        // Invoke via `npx tsx ...` rather than `npm run` - npm's own argument
        // parsing strips flags like --email before they reach the script.
        console.log(
          [
            "Admin password recovery.",
            "",
            "Run directly:",
            "  npx tsx --conditions react-server scripts/reset-password.ts <options>",
            "",
            "Options:",
            "  --email <address>   Reset this account.",
            "  --role \"<name>\"     Reset every account holding that role.",
            "  --password <pw>     New password. Generated and printed if omitted.",
            "  --unlock-only       Clear the lockout, keep the existing password.",
            "  --keep-password     Do not force a change at next sign-in.",
            "",
            "Examples:",
            "  npx tsx --conditions react-server scripts/reset-password.ts \\",
            "    --email admin@it-ticketing.local",
            "  npx tsx --conditions react-server scripts/reset-password.ts \\",
            "    --email you@company.com --password 'MyNewPass123'",
            "  npx tsx --conditions react-server scripts/reset-password.ts \\",
            "    --role \"SuperAdmin\" --unlock-only",
            "",
            "To see the accounts first:  npm run list-accounts",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        break;
    }
  }

  return args;
}

/**
 * Generates a password that satisfies the strength policy by construction:
 * 20 random base62 characters plus a digit, so the result is long and
 * unpredictable rather than merely memorable.
 */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return `${out}7`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email && !args.role) {
    console.error("Specify --email <address> or --role \"SuperAdmin\". See --help.");
    process.exit(1);
  }

  const supabase = await connectDB();

  // Resolve the target accounts.
  let query = supabase.from("users").select("*");
  if (args.email) {
    query = query.eq("Email", args.email.trim().toLowerCase());
  } else {
    const { data: roleRow } = await supabase
      .from("roles")
      .select("*")
      .eq("name", args.role)
      .maybeSingle<Record<string, unknown>>();
    if (!roleRow) {
      console.error(`No role named "${args.role}".`);
      process.exit(1);
    }
    query = query.eq("role_id", Number(mapRoleRow(roleRow).id));
  }

  const { data, error } = await query;
  if (error) throw error;

  const accounts = (data ?? []).map((row) => mapUserRow(row as Record<string, unknown>));
  if (accounts.length === 0) {
    console.error("No matching account. Check the address, or list the accounts first:");
    console.error("  npx tsx --conditions react-server scripts/list-accounts.ts");
    process.exit(1);
  }

  let password = args.password;
  if (!args.unlockOnly) {
    if (!password) {
      password = generatePassword();
    } else {
      const strength = validatePasswordStrength(password);
      if (!strength.ok) {
        console.error(`Password rejected: ${strength.message}`);
        console.error("Omit --password to have one generated for you.");
        process.exit(1);
      }
    }
  }

  const passwordHash = password ? await hashPassword(password) : undefined;

  // A recovery reset should not leave the account locked again on the very next
  // mistake, nor stay suspended.
  const patch = userFieldsToRow({
    ...(passwordHash ? { passwordHash } : {}),
    status: "active",
    failedLoginAttempts: 0,
    lockUntil: null,
    // Force the owner to pick their own password at next sign-in.
    ...(args.keepPassword ? {} : { mustChangePassword: true }),
  });

  for (const account of accounts) {
    const { error: updateError } = await supabase
      .from("users")
      .update(patch)
      .eq("id", Number(account.id));
    if (updateError) throw updateError;
  }

  console.log(`\nUpdated ${accounts.length} account(s):`);
  for (const account of accounts) {
    console.log(`  - ${account.email}`);
  }

  if (password) {
    console.log(`\nNew password:  ${password}`);
    console.log("This is shown once. Store it now.");
  } else {
    console.log("\nLockout cleared. The existing password still works.");
  }

  if (!args.keepPassword && password) {
    console.log("The account will require a password change at next sign-in.");
  }

  console.log("");
  process.exit(0);
}

main().catch((error) => {
  console.error("\nReset failed:", error);
  process.exit(1);
});
