/**
 * Lists every account with its role, so you can see who to reset.
 *
 *   npm run list-accounts
 */

import "./load-env";

import { connectDB } from "../src/lib/db/supabase";
import { mapUserRow } from "../src/lib/db/mappers";

async function main() {
  const supabase = await connectDB();

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .order("Firstname", { ascending: true });
  if (error) throw error;

  const accounts = (data ?? []).map((row) => mapUserRow(row as Record<string, unknown>));

  if (accounts.length === 0) {
    console.log("No accounts. Run `npm run seed` to create the SuperAdmin.");
    process.exit(0);
  }

  const locked = (value: Date | null) => {
    if (!value) return false;
    return value.getTime() > Date.now();
  };

  console.log(`\n${accounts.length} account(s)\n`);
  for (const account of accounts) {
    const flags = [
      account.status !== "active" ? account.status : "",
      account.mustChangePassword ? "must-change-password" : "",
      locked(account.lockUntil) ? "LOCKED" : "",
      account.failedLoginAttempts > 0 ? `${account.failedLoginAttempts} failed` : "",
    ]
      .filter(Boolean)
      .join(", ");

    console.log(`  ${account.email}`);
    console.log(`    name:  ${account.name || "-"}`);
    console.log(`    state: ${flags || "ok"}`);
    if (account.lastLoginAt) {
      console.log(`    last:  ${account.lastLoginAt.toISOString()}`);
    }
    console.log("");
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("\nFailed:", error);
  process.exit(1);
});
