"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Prisma, ProfileVisibility } from "@recx/db";
import { requireActionUser } from "@/lib/auth/guards";
import { hashPassword, passwordIssues, verifyPassword } from "@/lib/auth/password";
import { destroyAllSessions } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { RateLimitError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { hitRateLimit, PASSWORD_CHANGE_RATE_LIMIT } from "@/lib/rate-limit";
import {
  mergeEditorPrefs,
  settingsFromForm,
  settingsSchema,
  type TabSize,
} from "@/components/profile/settings-schema";

/**
 * /profile/settings. One form, one action; it works with and without
 * JavaScript (useActionState). A user only ever edits their own row.
 *
 *   saveProfileSettings   any signed-in user   profile.visibility.changed
 *                                              profile.leaderboard_opt_out.changed
 *   changeMyPassword      any signed-in user   auth.password_changed (SECURITY)
 */

export interface SavedSettings {
  visibility: ProfileVisibility;
  leaderboardOptOut: boolean;
  bio: string;
  fontSize: number;
  tabSize: TabSize;
}

export async function saveProfileSettings(
  _previous: ActionResult<SavedSettings> | null,
  formData: FormData,
): Promise<ActionResult<SavedSettings>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const input = settingsSchema.parse(settingsFromForm(formData));

    await db.user.update({
      where: { id: user.id },
      data: {
        visibility: input.visibility,
        leaderboardOptOut: input.leaderboardOptOut,
        bio: input.bio === "" ? null : input.bio,
        editorPrefs: mergeEditorPrefs(user.editorPrefs, {
          fontSize: input.fontSize,
          tabSize: input.tabSize,
        }) as Prisma.InputJsonObject,
      },
    });

    const visibilityChanged = user.visibility !== input.visibility;
    const optOutChanged = user.leaderboardOptOut !== input.leaderboardOptOut;
    if (visibilityChanged || optOutChanged) {
      const ipHash = await requestIpHash();
      if (visibilityChanged) {
        await audit({
          actorId: user.id,
          action: "profile.visibility.changed",
          entityType: "User",
          entityId: user.id,
          targetUserId: user.id,
          metadata: { from: user.visibility, to: input.visibility },
          ipHash,
        });
      }
      if (optOutChanged) {
        await audit({
          actorId: user.id,
          action: "profile.leaderboard_opt_out.changed",
          entityType: "User",
          entityId: user.id,
          targetUserId: user.id,
          metadata: { from: user.leaderboardOptOut, to: input.leaderboardOptOut },
          ipHash,
        });
      }
    }

    revalidatePath("/profile", "layout");
    revalidatePath(`/u/${encodeURIComponent(user.handle)}`);
    revalidatePath("/leaderboard");

    return {
      visibility: input.visibility,
      leaderboardOptOut: input.leaderboardOptOut,
      bio: input.bio,
      fontSize: input.fontSize,
      tabSize: input.tabSize,
    };
  }, "saveProfileSettings");
}

// ── Changing your own password ───────────────────────────────────────────

const passwordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password.").max(1024),
    next: z.string().min(1, "Enter a new password.").max(1024),
    confirm: z.string().min(1, "Type the new password again.").max(1024),
  })
  .strict();

/**
 * Change a password you already know.
 *
 * The companion to the one-time link (Phase 11a), and the other half of a
 * gap that had been open since Phase 1: there was NO way for anybody — a
 * student, an admin, a super-admin — to change their own password. Somebody
 * who suspected their password was known had to ask for a reset link to
 * replace it, which works and is a strange thing to have to do.
 *
 * Three decisions:
 *
 *   * **The current password is required** and verified with Argon2id. A
 *     change that only needed a live session would turn any borrowed,
 *     unlocked laptop in a lab into a permanent account takeover.
 *   * **That makes this a guessing oracle**, so it is rate-limited per
 *     account like sign-in is, and a wrong current password is audited.
 *   * **Every session ends, including this one.** The person is sent back
 *     to sign in with the new password. Keeping the current session alive
 *     is friendlier and means a change made because somebody else has your
 *     password leaves them signed in on their machine.
 *
 * An account with no password at all is told to use the link on the sign-in
 * page rather than being asked for a password it does not have.
 */
export async function changeMyPassword(
  _previous: ActionResult<{ changed: true }> | null,
  formData: FormData,
): Promise<ActionResult<{ changed: true }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const input = passwordSchema.parse({
      current: String(formData.get("current") ?? ""),
      next: String(formData.get("next") ?? ""),
      confirm: String(formData.get("confirm") ?? ""),
    });

    const hit = await hitRateLimit(`password-change:${user.id}`, PASSWORD_CHANGE_RATE_LIMIT);
    if (!hit.allowed) throw new RateLimitError();

    const row = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    if (row.passwordHash === null) {
      throw new ValidationError(
        "This account has no password yet. Use “Forgot your password, or never set one?” on the sign-in page to choose one.",
      );
    }

    const ipHash = await requestIpHash();
    if (!(await verifyPassword(input.current, row.passwordHash))) {
      await audit({
        actorId: user.id,
        action: "auth.password_change_failed",
        entityType: "User",
        entityId: user.id,
        targetUserId: user.id,
        sensitivity: "SECURITY",
        ipHash,
      });
      throw new ValidationError("That is not your current password.");
    }

    if (input.next !== input.confirm) throw new ValidationError("The two new passwords do not match.");
    const issues = passwordIssues(input.next);
    if (issues.length > 0) throw new ValidationError(`Choose a longer password: ${issues.join(", ").toLowerCase()}.`);
    if (input.next === input.current) throw new ValidationError("Choose a password you have not used here before.");

    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.next) } });
    await audit({
      actorId: user.id,
      action: "auth.password_changed",
      entityType: "User",
      entityId: user.id,
      targetUserId: user.id,
      sensitivity: "SECURITY",
      ipHash,
    });
    // Everywhere, including here. The redirect lands on the sign-in page
    // with the notice the reset flow uses: the password is set, sign in.
    await destroyAllSessions(user.id);
    redirect("/login?reset=1");
  }, "changeMyPassword");
}
