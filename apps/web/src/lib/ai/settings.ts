import "server-only";
import { cache } from "react";
import { AI_HELPER_SETTING_KEY, aiModel, effectiveAiHelperSetting, type AiHelperSetting, type AiModelChoice } from "@recx/shared";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * The AI helper's configuration (PlatformSetting "ai-helper"), read per
 * request like the governance flags: `enabled` is a kill switch, and a kill
 * switch that waits for a cache to expire is not one.
 *
 * The setting holds only what a super-admin should be choosing — whether the
 * helper answers, which model answers, and how many questions a student gets
 * a day. The API key and any college-hosted endpoint come from the
 * environment (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`), because a key in a
 * settings row is a key in every backup and on every admin's screen.
 */

export const getAiHelperSetting = cache(async (): Promise<AiHelperSetting> => {
  const row = await db.platformSetting.findUnique({
    where: { key: AI_HELPER_SETTING_KEY },
    select: { value: true },
  });
  return effectiveAiHelperSetting(row?.value);
});

export interface AiRuntime {
  readonly setting: AiHelperSetting;
  readonly model: AiModelChoice | null;
  /** Null when the deployment cannot answer: no key, or a custom model with no endpoint. */
  readonly misconfiguration: string | null;
}

/**
 * The setting plus whether this deployment could actually answer. A helper
 * that is switched on but has no key must read as off everywhere — in the
 * panel, in the action and on the super-admin page — rather than failing at
 * the student when they press the button.
 */
export async function getAiRuntime(): Promise<AiRuntime> {
  const setting = await getAiHelperSetting();
  const model = aiModel(setting.modelId);
  const e = env();
  let misconfiguration: string | null = null;
  if (!model) {
    misconfiguration = "The configured model is not one this build knows. Choose one again.";
  } else if (!e.AI_API_KEY) {
    misconfiguration = "No API key is set on the server, so the assistant cannot call a model.";
  } else if (model.provider === "openai-compatible" && (!e.AI_BASE_URL || !e.AI_MODEL)) {
    misconfiguration = "The college-hosted model needs AI_BASE_URL and AI_MODEL set on the server.";
  }
  return { setting, model, misconfiguration };
}

/** True when a student could get an answer right now, before their own quota is counted. */
export function aiUsable(runtime: AiRuntime): boolean {
  return runtime.setting.enabled && runtime.misconfiguration === null;
}
