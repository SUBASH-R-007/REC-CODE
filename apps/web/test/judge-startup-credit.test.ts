import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@recx/shared";

/**
 * startupCreditFor() — the claiming node's measured start-up time added to a
 * job's CPU limit. LIMITS.startupCredit.maxMs caps it (a larger median means
 * a broken toolchain, not a slow one); /judge publishes the cap.
 */

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/redis", () => ({ redis: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const { startupCreditFor } = await import("@/lib/judge/claim");

describe("startupCreditFor", () => {
  it("passes a credit at or below the cap through", () => {
    expect(startupCreditFor({ java21: 85 }, "java21")).toBe(85);
    expect(startupCreditFor({ cpp20: LIMITS.startupCredit.maxMs }, "cpp20")).toBe(LIMITS.startupCredit.maxMs);
  });

  it("caps a credit above LIMITS.startupCredit.maxMs", () => {
    expect(startupCreditFor({ cpp20: 5_000 }, "cpp20")).toBe(LIMITS.startupCredit.maxMs);
    expect(startupCreditFor({ py312: LIMITS.startupCredit.maxMs + 1 }, "py312")).toBe(LIMITS.startupCredit.maxMs);
  });

  it("is 0 when the node reported nothing usable for the language", () => {
    expect(startupCreditFor(null, "cpp20")).toBe(0);
    expect(startupCreditFor({ cpp20: -1 }, "cpp20")).toBe(0);
    expect(startupCreditFor({ py312: 40 }, "cpp20")).toBe(0);
    expect(startupCreditFor({ cpp20: 40 }, "fortran")).toBe(0);
  });
});
