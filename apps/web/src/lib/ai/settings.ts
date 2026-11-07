import "server-only";
import { cache } from "react";
import {
  AI_HELPER_SETTING_KEY,
  aiAllowedEndpoints,
  aiModelLabel,
  aiProviderNeedsEndpoint,
  effectiveAiHelperSetting,
  type AiHelperSetting,
  type AiModelTarget,
} from "@recx/shared";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * The AI helper's configuration (PlatformSetting "ai-helper"), read per
 * request like the governance flags: `enabled` is a kill switch, and a kill
 * switch that waits for a cache to expire is not one.
 *
 * The setting holds what a super-admin should be choosing — whether the
 * helper answers, which wire format and which model answer, which of the
 * deployment's addresses to use, and how much a student gets. The API key
 * and the list of addresses that may be reached come from the environment
 * (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`), because a key in a settings row
 * is a key in every backup and on every admin's screen — and because an
 * address chosen from a settings page is an address a stolen super-admin
 * session could point at itself.
 */

export const getAiHelperSetting = cache(async (): Promise<AiHelperSetting> => {
  const row = await db.platformSetting.findUnique({
    where: { key: AI_HELPER_SETTING_KEY },
    select: { value: true },
  });
  return effectiveAiHelperSetting(row?.value);
});

/** What the deployment contributes. Whether a key is set, never the key. */
export interface AiDeployment {
  readonly hasKey: boolean;
  /** The addresses `AI_BASE_URL` allows, already validated and de-duplicated. */
  readonly endpoints: readonly string[];
  /** `AI_MODEL`: the model an endpoint-named deployment falls back to. */
  readonly defaultModelId: string;
}

export interface AiRuntime {
  readonly setting: AiHelperSetting;
  readonly model: AiModelTarget | null;
  /** Null when the deployment can answer; a sentence for a super-admin when it cannot. */
  readonly misconfiguration: string | null;
  /** The addresses a super-admin may choose between. */
  readonly endpoints: readonly string[];
}

/**
 * The setting plus whether this deployment could actually answer with it.
 *
 * Pure, and separately tested, because this is where a free-text model id
 * and a deployment-owned address meet: every way the two can fail to add up
 * to something askable ends in one sentence a super-admin can act on, and a
 * `null` model, so a helper that is switched on but cannot answer reads as
 * off everywhere rather than failing at the student who pressed the button.
 *
 * The order is the order a super-admin can fix things in: what they chose
 * on this page first, then what the deployment owes them.
 */
export function resolveAiRuntime(setting: AiHelperSetting, deployment: AiDeployment): AiRuntime {
  const needsEndpoint = aiProviderNeedsEndpoint(setting.provider);
  const id = setting.modelId || (needsEndpoint ? deployment.defaultModelId : "");
  let baseUrl: string | null = null;
  let misconfiguration: string | null = null;

  if (needsEndpoint) {
    if (deployment.endpoints.length === 0) {
      misconfiguration =
        "An OpenAI-compatible endpoint needs an address, and this deployment sets no usable AI_BASE_URL.";
    } else if (setting.baseUrl === "") {
      baseUrl = deployment.endpoints[0] ?? null;
    } else if (deployment.endpoints.includes(setting.baseUrl)) {
      baseUrl = setting.baseUrl;
    } else {
      misconfiguration =
        "The address saved here is not one this deployment allows. Choose one of its addresses, or have AI_BASE_URL name this one.";
    }
  }

  if (misconfiguration === null && !id) {
    misconfiguration = needsEndpoint
      ? "No model is named here, and the deployment sets no AI_MODEL to fall back on."
      : "No model is named. Type the id the provider publishes.";
  }
  if (misconfiguration === null && !deployment.hasKey) {
    misconfiguration = "No API key is set on the server, so the assistant cannot call a model.";
  }

  const model: AiModelTarget | null =
    misconfiguration === null
      ? { provider: setting.provider, id, baseUrl, label: aiModelLabel({ provider: setting.provider, modelId: id }) }
      : null;
  return { setting, model, misconfiguration, endpoints: deployment.endpoints };
}

/** What this server contributes to the decision above. */
export function aiDeployment(): AiDeployment {
  const e = env();
  return {
    hasKey: !!e.AI_API_KEY,
    endpoints: aiAllowedEndpoints(e.AI_BASE_URL),
    defaultModelId: e.AI_MODEL ?? "",
  };
}

export async function getAiRuntime(): Promise<AiRuntime> {
  return resolveAiRuntime(await getAiHelperSetting(), aiDeployment());
}

/** True when a student could get an answer right now, before their own quota is counted. */
export function aiUsable(runtime: AiRuntime): boolean {
  return runtime.setting.enabled && runtime.misconfiguration === null;
}
