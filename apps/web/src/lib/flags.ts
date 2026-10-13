import "server-only";
import { cache } from "react";
import { effectiveFeatureFlags, FLAGS_SETTING_KEY, type FeatureFlagKey } from "@recx/shared";
import { db } from "@/lib/db";

/**
 * Governance feature flags (PlatformSetting "flags"; registry in
 * packages/shared/src/governance.ts). Read per request — the flags are kill
 * switches, so a change must take effect on the very next request. A missing
 * row or a malformed value means the registry defaults.
 */
export const getFeatureFlags = cache(async (): Promise<Readonly<Record<FeatureFlagKey, boolean>>> => {
  const row = await db.platformSetting.findUnique({ where: { key: FLAGS_SETTING_KEY }, select: { value: true } });
  return effectiveFeatureFlags(row?.value);
});

export async function isFeatureEnabled(key: FeatureFlagKey): Promise<boolean> {
  return (await getFeatureFlags())[key];
}
