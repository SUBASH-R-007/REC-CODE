import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { Avatar, Card, CardBody, CardHeader } from "@recx/design";
import { getCurrentUser } from "@/lib/auth/session";
import { findPublicProfile } from "@/server/queries/profile";
import { ActivityHeatmap } from "@/components/profile/activity-heatmap";
import { BadgeShelf } from "@/components/profile/badge-shelf";
import { SolvedByDifficulty } from "@/components/profile/progress-panels";
import { SkillRadar } from "@/components/profile/skill-radar";
import { VISIBILITY_OPTIONS } from "@/components/profile/visibility";

type Props = { params: Promise<{ handle: string }> };

/** The same lookup as the page (cached per request), so a hidden profile's name never reaches the <title>. */
async function load(params: Props["params"]) {
  const { handle } = await params;
  const viewer = await getCurrentUser();
  return findPublicProfile(handle, viewer?.id ?? null);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const profile = await load(params);
  return { title: profile ? `${profile.name} (@${profile.handle})` : "Profile not found" };
}

/**
 * Public profile. The guard is canViewProfile() inside findPublicProfile():
 * PUBLIC → anyone; REC_ONLY → signed-in users; PRIVATE → the owner. Anything
 * else is a 404, never a 403. Shows ONLY solved counts, badges, the heatmap
 * and the radar, under the display name ("Priya S.").
 */
export default async function PublicProfilePage({ params }: Props) {
  const profile = await load(params);
  if (!profile) notFound();
  const visibility = VISIBILITY_OPTIONS.find((o) => o.value === profile.visibility);

  return (
    <div>
      {profile.isOwner ? (
        <p className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-info/25 bg-info-subtle px-4 py-3 text-sm text-text-secondary">
          {profile.visibility === "PRIVATE" ? <Lock aria-hidden className="h-4 w-4 text-info" /> : null}
          <span>
            This is your profile page as others see it. Visibility: <strong className="text-text">{visibility?.label}</strong>
            {profile.visibility === "PRIVATE" ? " — only you can see it." : "."}
          </span>
          <Link href="/profile/settings" className="font-medium text-text underline decoration-primary decoration-2 underline-offset-4 hover:decoration-text">
            Change in settings
          </Link>
        </p>
      ) : null}

      <div className="flex min-w-0 items-center gap-4">
        <Avatar firstName={profile.avatar.firstName} lastName={profile.avatar.lastName} size="lg" />
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight">{profile.name}</h1>
          <p className="text-sm text-text-secondary">@{profile.handle}</p>
        </div>
      </div>
      {profile.bio ? <p className="mt-3 max-w-2xl whitespace-pre-line text-sm text-text-secondary">{profile.bio}</p> : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Solved" subtitle="First accepted solutions" />
          <CardBody>
            <SolvedByDifficulty solved={profile.solved} />
          </CardBody>
        </Card>
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader title="Activity" subtitle="The last 365 days" />
          <CardBody>
            <ActivityHeatmap activity={profile.activity} today={profile.today} subject={profile.name} />
          </CardBody>
        </Card>
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader title="Skill radar" subtitle="Problems solved unassisted, by topic" />
          <CardBody>
            <SkillRadar topics={profile.topics} subject={profile.name} showAssisted={false} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Badges" />
          <CardBody>
            <BadgeShelf badges={profile.badges} emptyText="No badges earned yet." />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
