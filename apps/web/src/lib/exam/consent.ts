import "server-only";
import { createHash } from "node:crypto";
import {
  CONSENT_SETTING_KEY,
  PROCTORING_CONSENT_VERSION,
  consentContactSchema,
  consentPolicyText,
  type ConsentContact,
} from "@recx/shared";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";

/**
 * Recording and checking proctoring consent (Phase 16e).
 *
 * The words and the version live in `@recx/shared`; the hash lives here,
 * because `node:crypto` does not belong in a module the browser bundles.
 *
 * `hasConsented` is asked in two places and that is deliberate: the
 * readiness page asks it to decide what to draw, and the start route asks
 * it again before writing an attempt. The page's answer is a courtesy and
 * the route's is the rule — a candidate who tampers with the page gets a
 * refusal rather than a sitting whose consent nobody recorded.
 */

/** sha256 of the exact words shown. Stable across processes, which is what makes it evidence. */
export function consentPolicyHash(version = PROCTORING_CONSENT_VERSION): string {
  return createHash("sha256").update(consentPolicyText(version), "utf8").digest("hex");
}

export async function hasConsented(userId: string, assessmentId: string): Promise<boolean> {
  const row = await db.consentRecord.findUnique({
    where: {
      userId_assessmentId_policyVersion: {
        userId,
        assessmentId,
        policyVersion: PROCTORING_CONSENT_VERSION,
      },
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Record it. Idempotent: pressing the button twice is one record, because
 * the unique index says so and a second press is not a second decision.
 *
 * The hash is computed here rather than taken from the client. A client that
 * could choose the hash could record consent to words nobody wrote.
 */
export async function recordConsent(input: {
  userId: string;
  assessmentId: string;
  ipHash: string | null;
}): Promise<{ recorded: boolean }> {
  const existing = await hasConsented(input.userId, input.assessmentId);
  if (existing) return { recorded: false };
  try {
    await db.consentRecord.create({
      data: {
        userId: input.userId,
        assessmentId: input.assessmentId,
        policyVersion: PROCTORING_CONSENT_VERSION,
        policyHash: consentPolicyHash(),
        ipHash: input.ipHash,
      },
    });
    return { recorded: true };
  } catch (error) {
    // Two presses in the same second: the index refused the second, which
    // is the right outcome and not an error the candidate should see.
    const code = (error as { code?: unknown })?.code;
    if (code === "P2002" || code === "23505") return { recorded: false };
    throw error;
  }
}

/**
 * The named contact SPEC asks to be on screen, from `PlatformSetting`.
 * Returns null when a super-admin has not named one — the page then says so
 * rather than inventing an address nobody reads.
 */
export async function consentContact(): Promise<ConsentContact | null> {
  const row = await db.platformSetting.findUnique({
    where: { key: CONSENT_SETTING_KEY },
    select: { value: true },
  });
  if (!row) return null;
  const parsed = consentContactSchema.safeParse(row.value);
  return parsed.success ? parsed.data : null;
}

/**
 * Validate a contact, without writing it.
 *
 * The write itself is in `server/actions/super-settings.ts`, because
 * `tests/repo/platform-setting-writes.test.ts` keeps every `PlatformSetting`
 * write in the handful of super-admin settings actions — and it is right to:
 * a settings write that can happen anywhere is a settings write nobody can
 * find. This half is the shape, so the action does not re-derive it.
 */
export function parseConsentContact(input: unknown): ConsentContact {
  const parsed = consentContactSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "That contact is not valid.");
  }
  return parsed.data;
}
