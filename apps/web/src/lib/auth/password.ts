import "server-only";
import { hash, verify, type Algorithm } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { ValidationError } from "@/lib/errors";

/**
 * Argon2id, OWASP-recommended minimum: m=19456 KiB, t=2, p=1.
 * `Algorithm` is an ambient const enum in @node-rs/argon2: under
 * isolatedModules it cannot be read as a value, and at runtime the package
 * exports it as {} — so `Algorithm.Argon2id` would silently be undefined and
 * fall back to the library default. Use the numeric value explicitly
 * (Argon2d = 0, Argon2i = 1, Argon2id = 2).
 */
export const ARGON2_PARAMS = {
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;
/**
 * A real Argon2id hash of a random string, computed once. Verifying against
 * it for unknown accounts keeps login timing uniform (no user enumeration).
 */
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString("hex"));
  return dummy;
}

export const PASSWORD_MIN_LENGTH = 10;

export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push(`At least ${PASSWORD_MIN_LENGTH} characters`);
  if (!/[a-zA-Z]/.test(password)) issues.push("At least one letter");
  if (!/[0-9]/.test(password)) issues.push("At least one number");
  return issues;
}

/**
 * Validate and hash an initial password an admin chose for accounts they are
 * creating (Phase 11f). The same policy a student's own password must meet,
 * refused with the same words, so a department cannot hand out "rec123" and
 * discover the rule only when the first student tries to replace it.
 *
 * The caller hashes once per batch, not once per row: Argon2id is
 * deliberately slow.
 */
export async function hashInitialPassword(password: string): Promise<string> {
  const issues = passwordIssues(password);
  if (issues.length > 0) {
    throw new ValidationError(`Choose a longer initial password: ${issues.join(", ").toLowerCase()}.`);
  }
  return hashPassword(password);
}
