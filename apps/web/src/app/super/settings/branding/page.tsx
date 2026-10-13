import type { Metadata } from "next";
import { Card, CardBody, CardHeader } from "@recx/design";
import { DEFAULT_THEME_INPUT } from "@recx/design/presets";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { PLATFORM_THEME_ID } from "@/lib/brand/brand-core";
import { db } from "@/lib/db";
import { BrandingForm } from "@/components/super/branding-form";
import { formatIst, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Branding · Super-admin" };

/** The platform brand: two seed colours and a radius, derived and contrast-checked on the server. */
export default async function SuperBrandingPage() {
  await requireSuperAdminPage();
  const row = await db.platformTheme.findUnique({
    where: { id: PLATFORM_THEME_ID },
    select: { presetKey: true, brandSeed: true, accentSeed: true, radius: true, paletteVersion: true, updatedAt: true },
  });
  const current = row ?? { ...DEFAULT_THEME_INPUT, paletteVersion: 0, updatedAt: null };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Branding"
        description="REC Purple is the canonical palette (identical to REC Learning). Success, warning, danger and info colours are never themeable."
      />
      <Card>
        <CardHeader
          title="Theme"
          subtitle={`Current: ${current.presetKey}, palette version ${current.paletteVersion}${row ? `, saved ${formatIst(row.updatedAt)}` : " (default, never saved)"}`}
        />
        <CardBody>
          <BrandingForm
            initial={{
              presetKey: current.presetKey,
              brandSeed: current.brandSeed,
              accentSeed: current.accentSeed,
              radius: current.radius,
            }}
          />
        </CardBody>
      </Card>
    </div>
  );
}
