import type { AccountStatus, ProfileVisibility } from "@recx/db";

/**
 * Who may open /u/[handle]. The one rule, used by the page, its metadata and
 * the tests:
 *
 *   owner     always (while signed in)
 *   PUBLIC    anyone, including signed-out visitors
 *   REC_ONLY  any signed-in REC Code user (the default)
 *   PRIVATE   the owner only
 *
 * Disabled and archived accounts have no public profile. Everyone else gets
 * a 404 — never a 403 — so a hidden profile is indistinguishable from a
 * handle that does not exist.
 */
const PROFILE_STATUSES: ReadonlySet<AccountStatus> = new Set<AccountStatus>(["ACTIVE", "SOFT_RESTRICTED", "GRADUATED"]);

export interface ProfileOwner {
  id: string;
  visibility: ProfileVisibility;
  status: AccountStatus;
}

export function canViewProfile(owner: ProfileOwner, viewerId: string | null): boolean {
  if (!PROFILE_STATUSES.has(owner.status)) return false;
  if (viewerId !== null && viewerId === owner.id) return true;
  switch (owner.visibility) {
    case "PUBLIC":
      return true;
    case "REC_ONLY":
      return viewerId !== null;
    case "PRIVATE":
      return false;
  }
}

export const VISIBILITY_OPTIONS: ReadonlyArray<{ value: ProfileVisibility; label: string; description: string }> = [
  {
    value: "REC_ONLY",
    label: "REC only",
    description: "Anyone signed in to REC Code can see your profile page. This is the default.",
  },
  {
    value: "PUBLIC",
    label: "Public",
    description: "Anyone with the link can see it, even without signing in.",
  },
  {
    value: "PRIVATE",
    label: "Private",
    description: "Only you can see your profile page.",
  },
];
