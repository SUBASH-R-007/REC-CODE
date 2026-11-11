"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requestIpHash } from "@/lib/ip";
import { destroySession, getCurrentUser } from "@/lib/auth/session";

/**
 * Sign out. Signing IN is not a server action: /login is a plain HTML page
 * with no JavaScript (src/pages/login.tsx) whose form posts to the route
 * handler POST /api/auth/login (src/lib/auth/sign-in.ts holds the logic).
 * There is no public sign-up: accounts come from the REC Learning roster
 * (or the seed), and identity lives there.
 */

/** Sign out of this browser and return to the sign-in page. */
export async function logout(): Promise<void> {
  const user = await getCurrentUser();
  await destroySession();
  if (user) {
    // While impersonating, the session (and so the sign-out) is the super-admin's own.
    const actorId = user.impersonation?.impersonator.id ?? user.id;
    await audit({
      actorId,
      action: "auth.logout",
      entityType: "User",
      entityId: actorId,
      ipHash: await requestIpHash(),
    });
  }
  redirect("/login");
}
