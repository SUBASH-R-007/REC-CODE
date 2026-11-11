"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { runAction, type ActionResult } from "@/lib/errors";

/**
 * /notifications mutations. Each one touches only the caller's own rows
 * (userId in every WHERE), so another user's id is simply "0 updated".
 * Marking a notification read is not a sensitive mutation and is not
 * audited. The layout is revalidated so the top-bar unread count follows.
 */

const idSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "That notification is not valid."),
});

export async function markNotificationRead(input: z.input<typeof idSchema>): Promise<ActionResult<{ updated: number }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const { id } = idSchema.parse(input);
    const { count } = await db.notification.updateMany({
      where: { id, userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    revalidatePath("/", "layout");
    return { updated: count };
  }, "markNotificationRead");
}

export async function markAllNotificationsRead(): Promise<ActionResult<{ updated: number }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const { count } = await db.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    revalidatePath("/", "layout");
    return { updated: count };
  }, "markAllNotificationsRead");
}
