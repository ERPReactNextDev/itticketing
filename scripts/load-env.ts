/**
 * Minimal .env.local loader for standalone scripts.
 *
 * Next.js loads .env files itself, but `tsx` does not, and these scripts read
 * MONGODB_URI / JWT_SECRET / RESEND_* directly. Values already present in the
 * real environment always win, so CI can inject secrets without a file.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

function parseFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv(): void {
  const root = resolve(process.cwd());
  const merged = {
    ...parseFile(resolve(root, ".env.local")),
    ...parseFile(resolve(root, ".env")),
  };

  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();