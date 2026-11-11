import { BORN_FROZEN_MESSAGE, FROZEN_VERSION_MESSAGE, FrozenVersionError } from "@recx/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  FROZEN_VERSION_CONFLICT_MESSAGE,
  IMPERSONATION_READ_ONLY_MESSAGE,
  ImpersonationReadOnlyError,
  isFrozenVersionConflict,
  isFrozenVersionError,
  runAction,
} from "@/lib/errors";

/**
 * lib/errors.ts: the error classes server actions throw and how runAction
 * turns them into { ok:false } results. Phase 4 adds ConflictError (409),
 * ImpersonationReadOnlyError (403) and the FrozenVersionError mapping: code
 * "frozen" → the conflict message; code "born_frozen" (a code bug) → logged
 * with a reference id like any unexpected error.
 */

const GENERIC = /^Something went wrong\. Please try again — if it keeps happening, quote reference [A-Z2-9]{6}\.$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConflictError", () => {
  it("is an AppError with status 409 and a default message", () => {
    const error = new ConflictError();
    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(409);
    expect(error.name).toBe("ConflictError");
    expect(error.message).toMatch(/changed/);
    expect(new ConflictError("Someone published first.").message).toBe("Someone published first.");
  });

  it("reaches the user through runAction unchanged", async () => {
    await expect(
      runAction(async () => {
        throw new ConflictError("Someone published first.");
      }),
    ).resolves.toEqual({ ok: false, error: "Someone published first." });
  });
});

describe("ImpersonationReadOnlyError", () => {
  it("is a ForbiddenError (403) carrying the read-only message", () => {
    const error = new ImpersonationReadOnlyError();
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(403);
    expect(error.name).toBe("ImpersonationReadOnlyError");
    expect(error.message).toBe(IMPERSONATION_READ_ONLY_MESSAGE);
    expect(IMPERSONATION_READ_ONLY_MESSAGE).toBe(
      "You are viewing as another user (read-only). End the impersonation to make changes.",
    );
  });

  it("reaches the user through runAction", async () => {
    await expect(
      runAction(async () => {
        throw new ImpersonationReadOnlyError();
      }),
    ).resolves.toEqual({ ok: false, error: IMPERSONATION_READ_ONLY_MESSAGE });
  });
});

describe("runAction and FrozenVersionError (@recx/db)", () => {
  it("carries a code: frozen by default, born_frozen for a revision created frozen", () => {
    expect(new FrozenVersionError().code).toBe("frozen");
    expect(new FrozenVersionError().message).toBe(FROZEN_VERSION_MESSAGE);
    const born = new FrozenVersionError("born_frozen");
    expect(born.code).toBe("born_frozen");
    expect(born.message).toBe(BORN_FROZEN_MESSAGE);
    expect(born.name).toBe("FrozenVersionError");
  });

  it("maps a write to a frozen revision (code frozen) to the conflict message, without logging", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runAction(async () => {
        throw new FrozenVersionError();
      }, "test.frozen"),
    ).resolves.toEqual({ ok: false, error: FROZEN_VERSION_CONFLICT_MESSAGE });
    expect(FROZEN_VERSION_CONFLICT_MESSAGE).toBe("This revision is published and frozen — start a new revision to edit it.");
    expect(logged).not.toHaveBeenCalled();
  });

  it("treats a born-frozen create (a code bug) like any unexpected error: logged with a reference, generic message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new FrozenVersionError("born_frozen");
    const result = await runAction(async () => {
      throw error;
    }, "test.born_frozen");
    expect(result.ok).toBe(false);
    const message = !result.ok ? result.error : "";
    expect(message).toMatch(GENERIC);
    expect(message).not.toBe(FROZEN_VERSION_CONFLICT_MESSAGE);
    expect(logged).toHaveBeenCalledOnce();
    const [line, loggedError] = logged.mock.calls[0]!;
    const ref = /reference ([A-Z2-9]{6})\.$/.exec(message)![1]!;
    expect(String(line)).toContain(`ref ${ref}`);
    expect(String(line)).toContain("test.born_frozen");
    expect(loggedError).toBe(error);
  });

  it("matches by name plus code, never instanceof", () => {
    expect(isFrozenVersionError(new FrozenVersionError())).toBe(true);
    expect(isFrozenVersionError(new FrozenVersionError("born_frozen"))).toBe(true);
    expect(isFrozenVersionConflict(new FrozenVersionError())).toBe(true);
    expect(isFrozenVersionConflict(new FrozenVersionError("born_frozen"))).toBe(false);
    // Another copy of the class (Next bundles a module per layer): same name and code, not the same constructor.
    const copy = Object.assign(new Error("copy"), { name: "FrozenVersionError", code: "frozen" });
    expect(isFrozenVersionConflict(copy)).toBe(true);
    // A same-named error without the frozen code is not a conflict.
    expect(isFrozenVersionConflict(Object.assign(new Error("no code"), { name: "FrozenVersionError" }))).toBe(false);
    expect(isFrozenVersionError(new Error("ProblemVersion x is frozen and immutable"))).toBe(false);
    expect(isFrozenVersionError({ name: "FrozenVersionError", code: "frozen", message: "not an Error" })).toBe(false);
    expect(isFrozenVersionError(null)).toBe(false);
  });

  it("shows the conflict message for a same-named copy with code frozen, and logs one without a code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runAction(async () => {
        throw Object.assign(new Error("copy"), { name: "FrozenVersionError", code: "frozen" });
      }),
    ).resolves.toEqual({ ok: false, error: FROZEN_VERSION_CONFLICT_MESSAGE });
    expect(logged).not.toHaveBeenCalled();
    const result = await runAction(async () => {
      throw Object.assign(new Error("no code"), { name: "FrozenVersionError" });
    });
    expect(!result.ok && result.error).toMatch(GENERIC);
    expect(logged).toHaveBeenCalledOnce();
  });

  it("still masks other unexpected errors behind a reference id", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runAction(async () => {
      throw new Error("ProblemVersion abc is frozen and immutable");
    }, "test.unexpected");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(GENERIC);
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe("runAction basics (unchanged)", () => {
  it("returns data on success", async () => {
    await expect(runAction(async () => 42)).resolves.toEqual({ ok: true, data: 42 });
  });

  it("returns an AppError's message and a zod issue as text", async () => {
    await expect(
      runAction(async () => {
        throw new ForbiddenError();
      }),
    ).resolves.toEqual({ ok: false, error: "You don't have permission to do that." });
    const result = await runAction(async () => z.object({ title: z.string().min(1, "Enter a title.") }).parse({ title: "" }));
    expect(result).toEqual({ ok: false, error: "Enter a title." });
  });

  it("rethrows Next.js control flow (redirect / notFound)", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    await expect(
      runAction(async () => {
        throw redirect;
      }),
    ).rejects.toBe(redirect);
  });
});
