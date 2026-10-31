import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public language list behind /judge and /help: one cached query over
 * the enabled, current LanguageConfig rows (tagged, with a 60 s backstop),
 * refreshed by setLanguageEnabled right after its audit row. Revalidation is
 * best effort: the toggle has committed by then, so a failure is logged and
 * never turns the action into an error.
 */

const h = vi.hoisted(() => {
  const actor = { id: "admin_1", role: "ADMIN" };
  return {
    actor,
    cacheCalls: [] as Array<{ keyParts: unknown; options: unknown }>,
    revalidateTag: vi.fn(),
    revalidateLanguageConfigs: vi.fn(),
    audit: vi.fn(async () => undefined),
    db: {
      languageConfig: {
        findMany: vi.fn(async () => [] as unknown[]),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
    },
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown, keyParts: unknown, options: unknown) => {
    h.cacheCalls.push({ keyParts, options });
    return fn;
  },
  revalidateTag: h.revalidateTag,
}));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "iphash" }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: vi.fn() }));
vi.mock("@/lib/judge/lanes", () => ({ allowUnhardenedNodes: () => false }));
vi.mock("@/lib/auth/guards", () => ({
  requireActionRole: async (...roles: string[]) => {
    if (!roles.includes(h.actor.role)) {
      const { ForbiddenError } = await import("@/lib/errors");
      throw new ForbiddenError();
    }
    return h.actor;
  },
  requireSuperAdmin: async () => h.actor,
}));
vi.mock("@/server/queries/judge-languages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/queries/judge-languages")>()),
  revalidateLanguageConfigs: h.revalidateLanguageConfigs,
}));

const real = await vi.importActual<typeof import("@/server/queries/judge-languages")>("@/server/queries/judge-languages");
const { setLanguageEnabled } = await import("@/server/actions/admin-judge");

const REASON = "Toolchain verified on every judge";
const CONFIG = {
  id: "lc_1",
  key: "java21",
  toolchainId: "temurin-21.0.4+7",
  label: "Java 21 (Temurin 21.0.4+7)",
  enabled: false,
  isCurrent: true,
  retiredAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.role = "ADMIN";
});

describe("getPublicLanguageRows", () => {
  it("is cached under its own key and tag, with a 60 s backstop", () => {
    expect(h.cacheCalls).toContainEqual({
      keyParts: ["judge-public-languages", "v1"],
      options: { tags: [real.LANGUAGE_CONFIG_TAG], revalidate: 60 },
    });
    expect(real.LANGUAGE_CONFIG_TAG).toBe("language-config");
  });

  it("reads only the enabled, current rows and five public fields", async () => {
    await real.getPublicLanguageRows();
    expect(h.db.languageConfig.findMany).toHaveBeenCalledWith({
      where: { enabled: true, isCurrent: true },
      select: { key: true, label: true, version: true, toolchainId: true, runtime: true },
      orderBy: { key: "asc" },
    });
  });
});

describe("revalidateLanguageConfigs", () => {
  it("revalidates the tag", () => {
    real.revalidateLanguageConfigs();
    expect(h.revalidateTag).toHaveBeenCalledWith("language-config");
  });

  it("logs, never throws, when revalidation is unavailable", () => {
    h.revalidateTag.mockImplementationOnce(() => {
      throw new Error("Invariant: static generation store missing");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => real.revalidateLanguageConfigs()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("setLanguageEnabled refreshes the public list", () => {
  it("after the audit row of a successful toggle", async () => {
    h.db.languageConfig.findUnique.mockResolvedValue(CONFIG);
    h.db.languageConfig.updateMany.mockResolvedValue({ count: 1 });
    const result = await setLanguageEnabled({ languageConfigId: "lc_1", enabled: true, reason: REASON });
    expect(result).toEqual({ ok: true, data: { enabled: true } });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.revalidateLanguageConfigs).toHaveBeenCalledTimes(1);
    const audited = h.audit.mock.invocationCallOrder[0] ?? Infinity;
    const revalidated = h.revalidateLanguageConfigs.mock.invocationCallOrder[0] ?? -Infinity;
    expect(revalidated).toBeGreaterThan(audited);
  });

  it("not when the toggle is refused or lost", async () => {
    h.actor.role = "STUDENT";
    expect((await setLanguageEnabled({ languageConfigId: "lc_1", enabled: true, reason: REASON })).ok).toBe(false);
    h.actor.role = "ADMIN";
    h.db.languageConfig.findUnique.mockResolvedValue({ ...CONFIG, enabled: true });
    expect((await setLanguageEnabled({ languageConfigId: "lc_1", enabled: true, reason: REASON })).ok).toBe(false);
    h.db.languageConfig.findUnique.mockResolvedValue(CONFIG);
    h.db.languageConfig.updateMany.mockResolvedValue({ count: 0 });
    expect((await setLanguageEnabled({ languageConfigId: "lc_1", enabled: true, reason: REASON })).ok).toBe(false);
    expect(h.revalidateLanguageConfigs).not.toHaveBeenCalled();
  });
});
