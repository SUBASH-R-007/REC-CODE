// Type-only (erased): this module is reachable from client components through
// `import type { ActionResult }`, so it must not load the Prisma client.
import type { FrozenVersionError } from "@recx/db";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "You need to sign in to do that.") {
    super(message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that.") {
    super(message, 403);
    this.name = "ForbiddenError";
  }
}

export const IMPERSONATION_READ_ONLY_MESSAGE =
  "You are viewing as another user (read-only). End the impersonation to make changes.";

/** Every mutation is refused while a SUPER_ADMIN views as another user. */
export class ImpersonationReadOnlyError extends ForbiddenError {
  constructor(message = IMPERSONATION_READ_ONLY_MESSAGE) {
    super(message);
    this.name = "ImpersonationReadOnlyError";
  }
}

export const INITIAL_PASSWORD_MESSAGE =
  "Set your own password before you use REC Code. You signed in with the password your department gave you.";

/**
 * Refused while an account still holds the initial password an admin set
 * (Phase 11f). The whole point of that password is that it survives exactly
 * one sign-in: a department may hand the same one to a whole batch, so an
 * account that keeps it is an account anybody in the batch can open.
 */
export class InitialPasswordRequiredError extends ForbiddenError {
  constructor(message = INITIAL_PASSWORD_MESSAGE) {
    super(message);
    this.name = "InitialPasswordRequiredError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "That resource was not found.") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "The submitted data is invalid.") {
    super(message, 422);
    this.name = "ValidationError";
  }
}

/** The write lost a race or targets a state that changed (optimistic concurrency, a frozen revision). */
export class ConflictError extends AppError {
  constructor(message = "This was changed in the meantime. Reload the page and try again.") {
    super(message, 409);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(message = "You're doing that too often. Please wait a moment and try again.") {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

/** What runAction shows when a write reaches a published (frozen) revision. */
export const FROZEN_VERSION_CONFLICT_MESSAGE = "This revision is published and frozen — start a new revision to edit it.";

/**
 * The repository guard's FrozenVersionError (packages/db/src/frozen.ts),
 * either code. Matched by its name, never `instanceof FrozenVersionError`,
 * so this module never imports the Prisma client at runtime.
 */
export function isFrozenVersionError(error: unknown): error is FrozenVersionError {
  return error instanceof Error && error.name === "FrozenVersionError";
}

/**
 * A FrozenVersionError with code "frozen": a write reached a published
 * revision, which a user can cause (e.g. by editing while someone publishes).
 * Code "born_frozen" (creating an already-frozen revision) is a bug in the
 * calling code and does NOT match: runAction logs it like any unexpected error.
 */
export function isFrozenVersionConflict(error: unknown): error is FrozenVersionError {
  return isFrozenVersionError(error) && error.code === "frozen";
}

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function zodMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "The submitted data is invalid.";
  const field = issue.path.filter((p) => typeof p === "string").join(".");
  const authored = /[.!?]$/.test(issue.message.trim());
  return authored || !field ? issue.message : `${field}: ${issue.message}`;
}

/** Short, human-speakable correlation id (no 0/O, 1/I/L). */
export function referenceId(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function isNextControlFlow(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "NEXT_REDIRECT" ||
      ("digest" in error &&
        typeof (error as { digest?: unknown }).digest === "string" &&
        (error as { digest: string }).digest.startsWith("NEXT_")))
  );
}

/**
 * Wrap a server-action body: AppErrors and schema failures become friendly
 * { ok:false } results; a write that reached a frozen revision (the guard's
 * FrozenVersionError, code "frozen") becomes a conflict message instead of
 * the generic one; unexpected errors — including a FrozenVersionError with
 * code "born_frozen", which only a code bug can cause — are logged with a
 * reference id that is also shown to the user, and masked.
 */
export async function runAction<T>(fn: () => Promise<T>, name?: string): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: error.message };
    if (error instanceof ZodError) return { ok: false, error: zodMessage(error) };
    if (isFrozenVersionConflict(error)) return { ok: false, error: FROZEN_VERSION_CONFLICT_MESSAGE };
    if (isNextControlFlow(error)) throw error;
    const ref = referenceId();
    console.error(`[action] unexpected error (ref ${ref}${name ? `, action ${name}` : ""}):`, error);
    return {
      ok: false,
      error: `Something went wrong. Please try again — if it keeps happening, quote reference ${ref}.`,
    };
  }
}
