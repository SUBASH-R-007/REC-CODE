"use server";

import { z } from "zod";
import type { Prisma } from "@recx/db";
import {
  CVD_TYPES,
  deriveTheme,
  simulate,
  themeInputSchema,
  type ContrastCheck,
  type CvdType,
  type Palette,
  type ThemeInput,
  type ThemeWarning,
} from "@recx/design/derive";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { PLATFORM_THEME_ID } from "@/lib/brand/brand-core";
import { revalidateBrand } from "@/lib/brand/theme";
import { db } from "@/lib/db";
import { ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Brand theme, SUPER_ADMIN only. Exactly two seed colours plus a radius
 * (themeInputSchema); the palette is derived on the server
 * (@recx/design/derive), every REQUIRED_PAIRS contrast pair must pass in
 * both themes, and a failing palette is never saved. The status colours
 * (--success/--warning/--danger/--info) are not themeable at all. The
 * canonical rec-purple preset returns the verbatim LMS palette.
 *
 *   previewBrandTheme   read only (no audit)               supporting action
 *   saveBrandTheme      settings.brand.updated (SENSITIVE) capability "settings.write"
 */

export interface BrandPreview {
  ok: boolean;
  palette: Palette | null;
  warnings: ThemeWarning[];
  checks: ContrastCheck[];
  failures: ContrastCheck[];
  /** How the primary, accent and text-on-surface colours read under each colour-vision simulation. */
  simulations: Array<{ type: CvdType; light: { primary: string; accent: string }; dark: { primary: string; accent: string } }>;
}

function preview(input: ThemeInput): BrandPreview {
  const derived = deriveTheme(input);
  if (!derived.ok) {
    return {
      ok: false,
      palette: null,
      warnings: [],
      checks: derived.report.checks,
      failures: derived.failures,
      simulations: [],
    };
  }
  const { palette } = derived;
  return {
    ok: true,
    palette,
    warnings: derived.warnings,
    checks: derived.report.checks,
    failures: [],
    simulations: CVD_TYPES.map((type) => ({
      type,
      light: { primary: simulate(palette.light.primary ?? "", type), accent: simulate(palette.light.accent ?? "", type) },
      dark: { primary: simulate(palette.dark.primary ?? "", type), accent: simulate(palette.dark.accent ?? "", type) },
    })),
  };
}

/** Derive and evaluate a theme without saving it. */
export async function previewBrandTheme(input: unknown): Promise<ActionResult<BrandPreview>> {
  return runAction(async () => {
    await requireSuperAdmin();
    const theme = themeInputSchema.parse(input);
    return preview(theme);
  }, "previewBrandTheme");
}

const saveSchema = z.object({
  theme: themeInputSchema,
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
    .max(500, "Keep the reason under 500 characters."),
});
export type SaveBrandThemeInput = z.input<typeof saveSchema>;

export async function saveBrandTheme(
  input: SaveBrandThemeInput,
): Promise<ActionResult<{ paletteVersion: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { theme, reason } = saveSchema.parse(input);
    const derived = deriveTheme(theme);
    if (!derived.ok) {
      const first = derived.failures[0];
      throw new ValidationError(
        `This theme fails ${derived.failures.length} contrast check(s)${
          first ? ` (first: ${first.fg} on ${first.bg}, ${first.theme} theme, ${first.ratio.toFixed(2)}:1, needs ${first.min}:1)` : ""
        }. Nothing was saved.`,
      );
    }
    const palette = derived.palette as unknown as Prisma.InputJsonObject;
    const saved = await db.$transaction(async (tx) => {
      const previous = await tx.platformTheme.findUnique({
        where: { id: PLATFORM_THEME_ID },
        select: { presetKey: true, brandSeed: true, accentSeed: true, radius: true, paletteVersion: true },
      });
      const row = await tx.platformTheme.upsert({
        where: { id: PLATFORM_THEME_ID },
        create: {
          id: PLATFORM_THEME_ID,
          presetKey: theme.presetKey,
          brandSeed: theme.brandSeed,
          accentSeed: theme.accentSeed,
          radius: theme.radius,
          palette,
          css: derived.css,
          updatedById: actor.id,
        },
        update: {
          presetKey: theme.presetKey,
          brandSeed: theme.brandSeed,
          accentSeed: theme.accentSeed,
          radius: theme.radius,
          palette,
          css: derived.css,
          paletteVersion: { increment: 1 },
          updatedById: actor.id,
        },
        select: { paletteVersion: true },
      });
      return { previous, paletteVersion: row.paletteVersion };
    });
    await audit({
      actorId: actor.id,
      action: "settings.brand.updated",
      entityType: "PlatformTheme",
      entityId: PLATFORM_THEME_ID,
      sensitivity: "SENSITIVE",
      metadata: {
        previous: saved.previous
          ? {
              presetKey: saved.previous.presetKey,
              brandSeed: saved.previous.brandSeed,
              accentSeed: saved.previous.accentSeed,
              radius: saved.previous.radius,
              paletteVersion: saved.previous.paletteVersion,
            }
          : null,
        next: { ...theme, paletteVersion: saved.paletteVersion },
        warnings: derived.warnings.map((w) => w.code),
        reason,
      },
      ipHash: await requestIpHash(),
    });
    revalidateBrand();
    return { paletteVersion: saved.paletteVersion };
  }, "saveBrandTheme");
}
