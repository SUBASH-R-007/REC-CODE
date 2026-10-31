import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /super/settings/branding actions with the real derivation: a palette that
 * fails a contrast pair is refused and nothing is written; rec-purple is the
 * verbatim canonical palette; a save bumps paletteVersion, revalidates the
 * brand cache and is audited (SENSITIVE) with the previous theme.
 */

const FAILING_SEED = "#123456";

const h = vi.hoisted(() => ({
  actor: { id: "super_1", role: "SUPER_ADMIN" as string, firstName: "S", lastName: "A" },
  upserts: [] as Array<Record<string, unknown>>,
  audit: vi.fn(),
  revalidateBrand: vi.fn(),
}));

vi.mock("@recx/design/derive", async (importActual) => {
  const actual = await importActual<typeof import("@recx/design/derive")>();
  return {
    ...actual,
    // A deterministic refusal for one sentinel seed; every other input derives for real.
    deriveTheme: (input: { brandSeed: string }, options?: unknown) => {
      if (input.brandSeed === FAILING_SEED) {
        const failure = {
          theme: "light",
          fg: "primary",
          bg: "surface",
          fgValue: FAILING_SEED,
          bgValue: "#ffffff",
          ratio: 1.2,
          min: 3,
          pass: false,
        };
        return { ok: false, failures: [failure], report: { checks: [failure], failures: [failure], pass: false } };
      }
      return actual.deriveTheme(input as never, options as never);
    },
  };
});
vi.mock("@/lib/auth/guards", async () => {
  const { ForbiddenError } = await import("@/lib/errors");
  return {
    requireSuperAdmin: async () => {
      if (h.actor.role !== "SUPER_ADMIN") throw new ForbiddenError();
      return h.actor;
    },
  };
});
vi.mock("@/lib/db", () => {
  const tx = {
    platformTheme: {
      findUnique: async () => ({
        presetKey: "rec-purple",
        brandSeed: "#6d28d9",
        accentSeed: "#b45309",
        radius: "0.75rem",
        paletteVersion: 3,
      }),
      upsert: async (args: Record<string, unknown>) => {
        h.upserts.push(args);
        return { paletteVersion: 4 };
      },
    },
  };
  return { db: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "iphash" }));
vi.mock("@/lib/brand/theme", () => ({ revalidateBrand: h.revalidateBrand }));

const { previewBrandTheme, saveBrandTheme } = await import("@/server/actions/super-branding");
const { REC_PURPLE_PALETTE } = await import("@recx/design/presets");

const REASON = "Align with the college's new brand guide";

beforeEach(() => {
  h.upserts.length = 0;
  h.audit.mockClear();
  h.revalidateBrand.mockClear();
  h.actor.role = "SUPER_ADMIN";
});

describe("previewBrandTheme", () => {
  it("returns the verbatim canonical palette for rec-purple, with every check", async () => {
    const result = await previewBrandTheme({ presetKey: "rec-purple", brandSeed: "#6d28d9", accentSeed: "#b45309", radius: "0.75rem" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.palette?.light).toEqual(REC_PURPLE_PALETTE.light);
    expect(result.data.palette?.dark).toEqual(REC_PURPLE_PALETTE.dark);
    expect(result.data.checks.length).toBeGreaterThan(20);
    expect(result.data.simulations.map((s) => s.type)).toEqual(["deuteranopia", "protanopia", "tritanopia", "grayscale"]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("reports a failing theme without saving anything", async () => {
    const result = await previewBrandTheme({ presetKey: "custom", brandSeed: FAILING_SEED, accentSeed: "#b45309", radius: "0.75rem" });
    expect(result.ok && result.data.ok).toBe(false);
    expect(h.upserts).toEqual([]);
  });

  it("refuses input outside the schema (status colours cannot be passed at all)", async () => {
    const result = await previewBrandTheme({ presetKey: "custom", brandSeed: "red", accentSeed: "#b45309", radius: "0.75rem", danger: "#00ff00" });
    expect(result.ok).toBe(false);
  });
});

describe("saveBrandTheme", () => {
  it("refuses a palette that fails a contrast pair, writing nothing", async () => {
    const result = await saveBrandTheme({
      theme: { presetKey: "custom", brandSeed: FAILING_SEED, accentSeed: "#b45309", radius: "0.75rem" },
      reason: REASON,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/contrast check/);
    expect(h.upserts).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.revalidateBrand).not.toHaveBeenCalled();
  });

  it("saves, bumps the version, revalidates the brand and audits the previous theme", async () => {
    const result = await saveBrandTheme({
      theme: { presetKey: "teal", brandSeed: "#0f766e", accentSeed: "#b45309", radius: "1rem" },
      reason: REASON,
    });
    expect(result).toEqual({ ok: true, data: { paletteVersion: 4 } });
    expect(h.upserts).toHaveLength(1);
    const upsert = h.upserts[0] as { update: Record<string, unknown> };
    expect(upsert.update).toMatchObject({ presetKey: "teal", radius: "1rem", paletteVersion: { increment: 1 }, updatedById: "super_1" });
    expect(String(upsert.update.css)).not.toMatch(/--(success|warning|danger|info)\b/);
    expect(h.revalidateBrand).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.brand.updated",
        sensitivity: "SENSITIVE",
        metadata: expect.objectContaining({
          previous: expect.objectContaining({ presetKey: "rec-purple", paletteVersion: 3 }),
          next: expect.objectContaining({ presetKey: "teal", paletteVersion: 4 }),
          reason: REASON,
        }),
      }),
    );
  });

  it("is SUPER_ADMIN only", async () => {
    h.actor.role = "ADMIN";
    const result = await saveBrandTheme({
      theme: { presetKey: "teal", brandSeed: "#0f766e", accentSeed: "#b45309", radius: "1rem" },
      reason: REASON,
    });
    expect(result.ok).toBe(false);
    expect(h.upserts).toEqual([]);
  });
});
