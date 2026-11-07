"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AI_HELPER_DEFAULT,
  AI_HELPER_SETTING_KEY,
  AI_PROBE_MAX_TOKENS,
  AI_PROBE_PROMPT,
  AI_PROBE_REPLY_CHARS,
  AI_PROBE_SYSTEM,
  AI_PROVIDERS,
  aiHelperSettingSchema,
  aiModelIdSchema,
  aiModelLabel,
  clipForModel,
  effectiveAiHelperSetting,
  type AiHelperSetting,
} from "@recx/shared";
import { askProvider, AiProviderError } from "@/lib/ai/provider";
import { aiDeployment, resolveAiRuntime } from "@/lib/ai/settings";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * The AI helper's configuration (PlatformSetting "ai-helper"), SUPER_ADMIN
 * only (capability "settings.write").
 *
 * Switching it on sends students' draft code to whichever model is chosen,
 * so the change is audited with a reason like the governance kill switches,
 * and SECURITY-sensitivity because the decision is about what leaves the
 * college rather than about a number.
 *
 * The API key is never written here. It is `AI_API_KEY` in the server
 * environment (`apps/web/src/lib/env.ts`), and this surface deliberately
 * cannot set, read or clear it.
 */

const inputSchema = aiHelperSettingSchema.extend({
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
    .max(500, "Keep the reason under 500 characters."),
});
export type UpdateAiHelperInput = z.input<typeof inputSchema>;

export async function updateAiHelper(input: UpdateAiHelperInput): Promise<ActionResult<AiHelperSetting>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { reason, ...wanted } = inputSchema.parse(input);

    const before = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"setting:" + AI_HELPER_SETTING_KEY}))`;
      const row = await tx.platformSetting.findUnique({ where: { key: AI_HELPER_SETTING_KEY } });
      const current = effectiveAiHelperSetting(row?.value);
      if (
        current.enabled === wanted.enabled &&
        current.provider === wanted.provider &&
        current.modelId === wanted.modelId &&
        current.baseUrl === wanted.baseUrl &&
        current.dailyPerStudent === wanted.dailyPerStudent &&
        current.maxOutputTokens === wanted.maxOutputTokens
      ) {
        throw new ValidationError("Nothing would change. Edit a value first.");
      }
      await tx.platformSetting.upsert({
        where: { key: AI_HELPER_SETTING_KEY },
        create: { key: AI_HELPER_SETTING_KEY, value: wanted, updatedById: actor.id },
        update: { value: wanted, updatedById: actor.id },
      });
      return current;
    });

    await audit({
      actorId: actor.id,
      action: "settings.ai_helper_changed",
      entityType: "PlatformSetting",
      entityId: AI_HELPER_SETTING_KEY,
      sensitivity: "SECURITY",
      metadata: { from: before, to: wanted, reason },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/settings/ai");
    return wanted;
  }, "updateAiHelper");
}

/**
 * "Does this model answer?" — the Test button on /super/settings/ai.
 *
 * The model id is free text (Phase 15g), which is only a kindness if a
 * super-admin can check it before students do. So this asks the model the
 * one fixed question in `AI_PROBE_PROMPT` and reports what came back:
 * reachable, with a latency and the model's own sentence, or a failure by
 * shape.
 *
 * It tests the values IN THE FORM, not the saved ones — the point is to try
 * a model before saving it — and it resolves them through the same
 * `resolveAiRuntime` the student path uses, so a combination this deployment
 * cannot reach is reported here rather than discovered later.
 *
 * Three things it is not. It never carries a student's work: the prompt is a
 * constant and this module cannot reach the one that builds a real one. It
 * never writes an `AiAssist` row: that table is the record of what a student
 * was told, and nobody was told anything. And a failure is not an error
 * here — it is the answer to the question asked — so it comes back as a
 * result the page can draw rather than as a thrown refusal.
 */
const probeSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    modelId: z.union([z.literal(""), aiModelIdSchema]),
    baseUrl: z.union([z.literal(""), z.string().trim().url()]),
  })
  .strict();
export type TestAiModelInput = z.input<typeof probeSchema>;

export interface AiModelTestResult {
  /** True when the model answered. */
  readonly reachable: boolean;
  /** What was tried, as a human reads it. */
  readonly label: string;
  readonly latencyMs: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /** The model's own sentence, clipped. Empty when it did not answer. */
  readonly reply: string;
  /** Why not, by shape — "timeout", "http 401". Null when it answered. */
  readonly problem: string | null;
}

export async function testAiModel(input: TestAiModelInput): Promise<ActionResult<AiModelTestResult>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const wanted = probeSchema.parse(input);
    const runtime = resolveAiRuntime({ ...AI_HELPER_DEFAULT, ...wanted, enabled: true }, aiDeployment());
    const label = aiModelLabel({ provider: wanted.provider, modelId: wanted.modelId });

    const record = async (result: AiModelTestResult) => {
      await audit({
        actorId: actor.id,
        action: "settings.ai_helper_tested",
        entityType: "PlatformSetting",
        entityId: AI_HELPER_SETTING_KEY,
        sensitivity: "SECURITY",
        // What was tried and what happened. Never the reply: it is a
        // model's prose, and an audit row is not the place for it.
        metadata: {
          provider: wanted.provider,
          modelId: wanted.modelId,
          baseUrl: wanted.baseUrl,
          reachable: result.reachable,
          latencyMs: result.latencyMs,
          problem: result.problem,
        },
        ipHash: await requestIpHash(),
      });
      return result;
    };

    if (!runtime.model) {
      return record({
        reachable: false,
        label,
        latencyMs: 0,
        tokensIn: null,
        tokensOut: null,
        reply: "",
        problem: runtime.misconfiguration ?? "This deployment cannot reach that model.",
      });
    }

    const startedAt = Date.now();
    try {
      const completion = await askProvider({
        model: runtime.model,
        system: AI_PROBE_SYSTEM,
        prompt: AI_PROBE_PROMPT,
        maxOutputTokens: AI_PROBE_MAX_TOKENS,
      });
      return record({
        reachable: true,
        label: runtime.model.label,
        latencyMs: Date.now() - startedAt,
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
        reply: clipForModel(completion.text, AI_PROBE_REPLY_CHARS),
        problem: null,
      });
    } catch (error) {
      return record({
        reachable: false,
        label: runtime.model.label,
        latencyMs: Date.now() - startedAt,
        tokensIn: null,
        tokensOut: null,
        reply: "",
        problem:
          error instanceof AiProviderError
            ? error.message.replace(/^The AI provider did not answer: /, "").replace(/\.$/, "")
            : "the request failed",
      });
    }
  }, "testAiModel");
}
