"use server";

import { revalidatePath } from "next/cache";
import {
  SECOND_FACTOR_PATHS,
  type SecondFactorRole,
  TOTP_ENROLMENT_MINUTES,
  TOTP_MESSAGES,
  formatSecretForTyping,
  otpauthUri,
} from "@recx/shared";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { requireActionRole } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import {
  newRecoveryCodes,
  newSecret,
  openTotpSecret,
  sealTotpSecret,
  secondFactorConfigured,
  verifyCode,
} from "@/lib/auth/totp";

/**
 * Setting up and taking down an authenticator app (Phase 16j).
 *
 *   beginSecondFactorEnrolment   ADMIN, SUPER_ADMIN   auth.second_factor_started
 *   confirmSecondFactor          ADMIN, SUPER_ADMIN   auth.second_factor_enabled (SECURITY)
 *   regenerateRecoveryCodes      ADMIN, SUPER_ADMIN   auth.recovery_codes_regenerated (SECURITY)
 *   removeSecondFactor           ADMIN, SUPER_ADMIN   auth.second_factor_disabled (SECURITY)
 *
 * All four act on the caller's OWN account and no other. There is
 * deliberately no "remove somebody else's second factor" action anywhere in
 * the product: that is a privileged operation in the ordinary sense, and
 * `/super/governance` is where an operation needing two people belongs. The
 * recovery codes exist so that the usual case — a lost phone — does not need
 * anybody else at all.
 *
 * **A secret is shown once, and only to the account it is for.** The
 * unconfirmed row IS the pending enrolment: there is no server-side session
 * state, no cache and no second copy. Abandoning the page leaves a row that
 * cannot sign anybody in (`confirmedAt` is null, and
 * `secondFactorDemanded()` reads that column), and beginning again replaces
 * it.
 */

/**
 * The deployment check, which every one of the four shares.
 *
 * The ROLE check is NOT here: each action below opens with
 * `requireActionRole("ADMIN", "SUPER_ADMIN")` as its first statement,
 * because that is what `tests/repo/support/action-guards.ts` reads to
 * decide which roles an action admits, and a role check hidden inside a
 * helper is a role check the capability matrix cannot see.
 */
function requireConfigured(): void {
  if (!secondFactorConfigured()) {
    throw new ValidationError(
      "This deployment has no encryption key for authenticator secrets, so one cannot be set up. See docs/RUNBOOK.md §2.22.",
    );
  }
}

/**
 * The two roles ROADMAP §3.1 scoped this to.
 *
 * Spelled out as a literal rather than spread from
 * `SECOND_FACTOR_ROLES`, because the capability fence reads these
 * arguments STATICALLY: a computed list resolves to "unknown" and the
 * matrix then cannot say which roles the action admits, which is the one
 * thing it exists to say. `satisfies` keeps the two in step at compile
 * time, and `second-factor.test.ts` asserts they are the same set.
 */
const OWNERS = ["ADMIN", "SUPER_ADMIN"] as const satisfies readonly SecondFactorRole[];

export interface PendingEnrolment {
  /** The secret in groups of four, for typing in by hand. */
  readonly secretForTyping: string;
  /** The `otpauth://` URI, for an app that can take one. */
  readonly uri: string;
  readonly expiresInMinutes: number;
}

/**
 * Mint a secret and store it unconfirmed.
 *
 * Called again, it replaces the pending row rather than adding one — a
 * reload of the page must not leave two secrets of which only one works.
 * A CONFIRMED credential is never replaced silently: removing one is its
 * own action, so that losing a working second factor is always deliberate.
 */
export async function beginSecondFactorEnrolment(): Promise<ActionResult<PendingEnrolment>> {
  return runAction(async () => {
    const user = await requireActionRole(...OWNERS);
    requireConfigured();

    const existing = await db.totpCredential.findUnique({
      where: { userId: user.id },
      select: { confirmedAt: true },
    });
    if (existing?.confirmedAt) throw new ValidationError(TOTP_MESSAGES.alreadyEnrolled);

    const secret = newSecret();
    const secretCipher = await sealTotpSecret({ userId: user.id, secretBase32: secret });
    await db.totpCredential.upsert({
      where: { userId: user.id },
      create: { userId: user.id, secretCipher },
      // An unconfirmed row only: the branch above refuses a confirmed one.
      update: { secretCipher, lastCounter: null, lastUsedAt: null, createdAt: new Date() },
    });

    await audit({
      actorId: user.id,
      action: "auth.second_factor_started",
      entityType: "User",
      entityId: user.id,
      targetUserId: user.id,
      sensitivity: "SECURITY",
      ipHash: await requestIpHash(),
    });

    return {
      // The only place a secret leaves the server, to the one account it
      // belongs to, over the same TLS the password came in on.
      secretForTyping: formatSecretForTyping(secret),
      uri: otpauthUri({ issuer: PRODUCT_NAME, account: user.collegeId || user.email, secretBase32: secret }),
      expiresInMinutes: TOTP_ENROLMENT_MINUTES,
    };
  }, "beginSecondFactorEnrolment");
}

export interface ConfirmedSecondFactor {
  /** Shown once. Not recoverable afterwards — only sha256 is stored. */
  readonly recoveryCodes: readonly string[];
}

/**
 * Prove the app works, then switch the factor on and hand over ten recovery
 * codes.
 *
 * The code is checked against the PENDING secret, which is the point of the
 * step: an admin who scanned nothing, or scanned the wrong entry, finds out
 * here rather than at their next sign-in, when they would be locked out of
 * the surface that could fix it.
 */
export async function confirmSecondFactor(
  _previous: ActionResult<ConfirmedSecondFactor> | null,
  formData: FormData,
): Promise<ActionResult<ConfirmedSecondFactor>> {
  return runAction(async () => {
    const user = await requireActionRole(...OWNERS);
    requireConfigured();

    const pending = await db.totpCredential.findUnique({
      where: { userId: user.id },
      select: { secretCipher: true, confirmedAt: true, createdAt: true },
    });
    if (!pending) throw new ValidationError(TOTP_MESSAGES.enrolmentExpired);
    if (pending.confirmedAt) throw new ValidationError(TOTP_MESSAGES.alreadyEnrolled);
    /**
     * The fifteen minutes the page promises, ENFORCED here.
     *
     * `beginSecondFactorEnrolment` resets `createdAt` for exactly this
     * comparison, and without this check the sentence on screen would be
     * false — an unconfirmed secret would sit usable for as long as nobody
     * finished the setup, which for a value that was on a screen and
     * possibly in a screenshot is the wrong answer. Starting again mints a
     * new one, so the cost of being too slow is one click.
     */
    if (Date.now() - pending.createdAt.getTime() > TOTP_ENROLMENT_MINUTES * 60_000) {
      await db.totpCredential.delete({ where: { userId: user.id } });
      throw new ValidationError(TOTP_MESSAGES.enrolmentExpired);
    }

    const secret = await openTotpSecret({ userId: user.id, sealed: pending.secretCipher });
    if (!secret) throw new ValidationError(TOTP_MESSAGES.enrolmentExpired);

    const checked = verifyCode({
      secretBase32: secret,
      typed: formData.get("code"),
      nowSeconds: Math.floor(Date.now() / 1000),
      // A pending credential has no counter yet, and the CHECK constraint
      // refuses one before confirmation.
      lastCounter: null,
    });
    if (!checked.ok) {
      throw new ValidationError(
        checked.problem === "format" ? TOTP_MESSAGES.codeFormat : TOTP_MESSAGES.enrolmentMismatch,
      );
    }

    const { shown, hashes } = newRecoveryCodes();
    await db.$transaction(async (tx) => {
      await tx.totpCredential.update({
        where: { userId: user.id },
        data: { confirmedAt: new Date(), lastCounter: BigInt(checked.counter), lastUsedAt: new Date() },
      });
      // Any codes from an earlier enrolment are gone: a set of recovery
      // codes belongs to one secret, and leaving the old ones live would
      // mean a removed factor could still be bypassed.
      await tx.totpRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.totpRecoveryCode.createMany({
        data: hashes.map((codeHash) => ({ userId: user.id, codeHash })),
      });
    });

    await audit({
      actorId: user.id,
      action: "auth.second_factor_enabled",
      entityType: "User",
      entityId: user.id,
      targetUserId: user.id,
      sensitivity: "SECURITY",
      // How many codes exist, never any code.
      metadata: { recoveryCodes: hashes.length },
      ipHash: await requestIpHash(),
    });

    revalidatePath(SECOND_FACTOR_PATHS.enrol);
    return { recoveryCodes: shown };
  }, "confirmSecondFactor");
}

/** A fresh set of ten, replacing whatever is left of the old set. */
export async function regenerateRecoveryCodes(): Promise<ActionResult<ConfirmedSecondFactor>> {
  return runAction(async () => {
    const user = await requireActionRole(...OWNERS);
    requireConfigured();
    const credential = await db.totpCredential.findUnique({
      where: { userId: user.id },
      select: { confirmedAt: true },
    });
    if (!credential?.confirmedAt) throw new ValidationError(TOTP_MESSAGES.notEnrolled);

    const { shown, hashes } = newRecoveryCodes();
    await db.$transaction(async (tx) => {
      await tx.totpRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.totpRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId: user.id, codeHash })) });
    });

    await audit({
      actorId: user.id,
      action: "auth.recovery_codes_regenerated",
      entityType: "User",
      entityId: user.id,
      targetUserId: user.id,
      sensitivity: "SECURITY",
      metadata: { recoveryCodes: hashes.length },
      ipHash: await requestIpHash(),
    });

    revalidatePath(SECOND_FACTOR_PATHS.enrol);
    return { recoveryCodes: shown };
  }, "regenerateRecoveryCodes");
}

/**
 * Take the factor off this account.
 *
 * Guarded by a current code, not by the password: somebody who has the
 * password and not the phone is exactly the person this must refuse, and
 * they are also exactly the person a stolen session would be. The recovery
 * codes are the way through without the phone, and they work here too.
 */
export async function removeSecondFactor(
  _previous: ActionResult<{ removed: true }> | null,
  formData: FormData,
): Promise<ActionResult<{ removed: true }>> {
  return runAction(async () => {
    const user = await requireActionRole(...OWNERS);
    requireConfigured();
    const credential = await db.totpCredential.findUnique({
      where: { userId: user.id },
      select: { secretCipher: true, confirmedAt: true, lastCounter: true },
    });
    if (!credential?.confirmedAt) throw new ValidationError(TOTP_MESSAGES.notEnrolled);

    const secret = await openTotpSecret({ userId: user.id, sealed: credential.secretCipher });
    if (!secret) throw new ValidationError(TOTP_MESSAGES.notEnrolled);
    const checked = verifyCode({
      secretBase32: secret,
      typed: formData.get("code"),
      nowSeconds: Math.floor(Date.now() / 1000),
      lastCounter: credential.lastCounter === null ? null : Number(credential.lastCounter),
    });
    if (!checked.ok) {
      throw new ValidationError(checked.problem === "format" ? TOTP_MESSAGES.codeFormat : TOTP_MESSAGES.codeWrong);
    }

    // Cascade takes the recovery codes with it; deleted explicitly so the
    // intent is in this file rather than only in the schema.
    await db.$transaction(async (tx) => {
      await tx.totpRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.totpCredential.delete({ where: { userId: user.id } });
    });

    await audit({
      actorId: user.id,
      action: "auth.second_factor_disabled",
      entityType: "User",
      entityId: user.id,
      targetUserId: user.id,
      sensitivity: "SECURITY",
      ipHash: await requestIpHash(),
    });

    revalidatePath(SECOND_FACTOR_PATHS.enrol);
    return { removed: true as const };
  }, "removeSecondFactor");
}
