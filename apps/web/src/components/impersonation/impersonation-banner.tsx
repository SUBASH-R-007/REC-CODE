import { Eye, LogOut } from "lucide-react";
import { Button, publicName } from "@recx/design";
import { getCurrentUser } from "@/lib/auth/session";
import { endImpersonation } from "@/server/actions/super-impersonate";

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});

/**
 * Full-width banner on every surface while a SUPER_ADMIN views as another
 * user (rendered by the root layout). Read-only is enforced by the action
 * guards, not by this banner; the banner says so and offers the one action
 * that works: ending the impersonation (a plain form, no JavaScript needed).
 */
export async function ImpersonationBanner() {
  let user: Awaited<ReturnType<typeof getCurrentUser>> = null;
  try {
    user = await getCurrentUser();
  } catch {
    // The page itself reports a database problem; the banner never breaks a render.
    return null;
  }
  const impersonation = user?.impersonation;
  if (!user || !impersonation) return null;
  return (
    <div role="region" aria-label="Impersonation" className="relative z-40 border-b-2 border-danger bg-danger-subtle text-danger">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm sm:px-6">
        <Eye className="h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          <strong>
            Viewing as {publicName(user.firstName, user.lastName)} ({user.collegeId}), read-only.
          </strong>{" "}
          Changes are refused until you end this. Ends at {IST_TIME.format(impersonation.expiresAt)} IST.{" "}
          <span className="break-words">Reason: {impersonation.reason}</span>
        </p>
        <form action={endImpersonation}>
          <Button type="submit" size="sm" variant="danger">
            <LogOut className="h-3.5 w-3.5" aria-hidden />
            End impersonation
          </Button>
        </form>
      </div>
    </div>
  );
}
