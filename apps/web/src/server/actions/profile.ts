"use server";

import { revalidatePath } from "next/cache";
import type { Prisma, ProfileVisibility } from "@recx/db";
import { requireActionUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
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
