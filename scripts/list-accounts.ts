/**
 * Lists every account with its role, so you can see who to reset.
 *
 *   npm run list-accounts
 */

import "./load-env";

import { connectDB } from "../src/lib/db/mongoose";
import { User } from "../src/lib/models";

async function main() {
  await connectDB();

  const accounts = await User.find()
    .sort({ name: 1 })
    .lean<
      Array<{
        name?: string;
        email?: string;
        status?: string;
        mustChangePassword?: boolean;
        failedLoginAttempts?: number;
        lockUntil?: Date | string | null;
        lastLoginAt?: Date | string | null;
      }>
    >();

  if (accounts.length === 0) {
    console.log("No accounts. Run `npm run seed` to create the Super Admin.");
    process.exit(0);
  }

  const locked = (value: Date | string | null | undefined) => {
    if (!value) return false;
    return new Date(value).getTime() > Date.now();
  };

  console.log(`\n${accounts.length} account(s)\n`);
  for (const account of accounts) {
    const flags = [
      account.status !== "active" ? account.status : "",
      account.mustChangePassword ? "must-change-password" : "",
      locked(account.lockUntil) ? "LOCKED" : "",
      (account.failedLoginAttempts ?? 0) > 0 ? `${account.failedLoginAttempts} failed` : "",
    ]
      .filter(Boolean)
      .join(", ");

    console.log(`  ${account.email}`);
    console.log(`    name:  ${account.name ?? "-"}`);
    console.log(`    state: ${flags || "ok"}`);
    if (account.lastLoginAt) {
      console.log(`    last:  ${new Date(account.lastLoginAt).toISOString()}`);
    }
    console.log("");
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("\nFailed:", error);
  process.exit(1);
});