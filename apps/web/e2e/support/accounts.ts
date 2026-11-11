import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The seeded accounts the suite signs in as (apps/web/scripts/seed.ts) and
 * where their signed-in storage state lives. Passwords come from the
 * environment (CI) or apps/web/.env.local (local development) and are never
 * printed.
 */

const E2E_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const WEB_DIR = path.dirname(E2E_DIR);
export const AUTH_DIR = path.join(E2E_DIR, ".auth");

export type AccountKey = "student" | "journey" | "admin" | "staffAdmin" | "super2" | "authoring" | "ece";

export interface Account {
  key: AccountKey;
  /** Roll number / college id typed into the sign-in form. */
  identifier: string;
  /** Environment variable holding the seed password. */
  passwordVar: "SEED_STUDENT_PASSWORD" | "SEED_ADMIN_PASSWORD";
  storageState: string;
}

function account(key: AccountKey, identifier: string, passwordVar: Account["passwordVar"]): Account {
  return { key, identifier, passwordVar, storageState: path.join(AUTH_DIR, `${key}.json`) };
}

/**
 * Separate accounts for separate jobs, so the specs never depend on each
 * other's data:
 *   - student    2116231001001  CSE 2027 — the axe pages, the RBAC redirects (reads only);
 *   - journey    2116231001002  CSE 2027 — the keyboard journey (submits);
 *   - authoring  2116231001004  CSE 2027 — the authoring journey's student (submits);
 *   - ece        2116226002001  ECE 2026 — outside RECADMIN02's scope; the impersonation target;
 *   - admin      RECADMIN01     SUPER_ADMIN — authors problems, /super pages, impersonates;
 *   - staffAdmin RECADMIN02     ADMIN, AdminScope CSE / every batch — approves, scoped /admin pages;
 *   - super2     RECSUPER02     SUPER_ADMIN — the second super-admin.
 * (The perf spec signs in 2116231001003 on its own.)
 */
export const ACCOUNTS: Readonly<Record<AccountKey, Account>> = {
  student: account("student", process.env.E2E_STUDENT_ID ?? "2116231001001", "SEED_STUDENT_PASSWORD"),
  journey: account("journey", process.env.E2E_JOURNEY_STUDENT_ID ?? "2116231001002", "SEED_STUDENT_PASSWORD"),
  authoring: account("authoring", process.env.E2E_AUTHORING_STUDENT_ID ?? "2116231001004", "SEED_STUDENT_PASSWORD"),
  ece: account("ece", process.env.E2E_ECE_STUDENT_ID ?? "2116226002001", "SEED_STUDENT_PASSWORD"),
  admin: account("admin", process.env.E2E_ADMIN_ID ?? "RECADMIN01", "SEED_ADMIN_PASSWORD"),
  staffAdmin: account("staffAdmin", process.env.E2E_STAFF_ADMIN_ID ?? "RECADMIN02", "SEED_ADMIN_PASSWORD"),
  super2: account("super2", process.env.E2E_SUPER2_ID ?? "RECSUPER02", "SEED_ADMIN_PASSWORD"),
};

/** The staff accounts (skipped by global setup with E2E_ADMIN=0). */
export const STAFF_ACCOUNT_KEYS: readonly AccountKey[] = ["admin", "staffAdmin", "super2"];

/** A minimal KEY=value reader for apps/web/.env.local (only the keys asked for). */
function readEnvFile(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0 || line.slice(0, eq).trim() !== key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

export function passwordFor(acct: Account): string {
  const value =
    process.env[acct.passwordVar] ??
    readEnvFile(path.join(WEB_DIR, ".env.local"), acct.passwordVar) ??
    readEnvFile(path.join(WEB_DIR, ".env"), acct.passwordVar);
  if (!value) {
    throw new Error(
      `${acct.passwordVar} is not set. Export it, or put it in apps/web/.env.local (the seed reads the same variable).`,
    );
  }
  return value;
}
