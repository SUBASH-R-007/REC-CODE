import type { Metadata } from "next";
import { Eye, Flame, Settings, Star, Trophy } from "lucide-react";
import {
  Avatar,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  ProgressBar,
  StatCard,
  fullName,
  pluralize,
} from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { getOwnProfile } from "@/server/queries/profile";
import { ActivityHeatmap } from "@/components/profile/activity-heatmap";
import { BadgeShelf } from "@/components/profile/badge-shelf";
import {
  AssistedSplit,
  LanguageSplit,
  SolvedByDifficulty,
  TimeToSolveTable,
} from "@/components/profile/progress-panels";
import { SkillRadar } from "@/components/profile/skill-radar";
import { VISIBILITY_OPTIONS } from "@/components/profile/visibility";

export const metadata: Metadata = { title: "Your profile" };

/**
 * The student's own progress page — private: only the signed-in student
 * ever sees it. /u/[handle] is the public, reduced view.
 */
export default async function ProfilePage() {
  const user = await requireUser();
  const profile = await getOwnProfile(user);
  const visibility = VISIBILITY_OPTIONS.find((o) => o.value === profile.visibility);
  const earnedBadges = profile.badges.filter((b) => b.awardedAt !== null).length;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar firstName={profile.name.firstName} lastName={profile.name.lastName} size="lg" />
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-bold tracking-tight">{fullName(profile.name)}</h1>
            <p className="text-sm text-text-secondary">
              @{profile.handle} · Profile page: {visibility?.label ?? profile.visibility}
              {profile.leaderboardOptOut ? " · Hidden from classmates' leaderboards" : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={`/u/${encodeURIComponent(profile.handle)}`} variant="outline" className="min-h-11">
            <Eye aria-hidden className="h-4 w-4" />
            {profile.visibility === "PRIVATE" ? "Preview your profile page" : "View your profile page"}
          </ButtonLink>
          <ButtonLink href="/profile/settings" variant="outline" className="min-h-11">
            <Settings aria-hidden className="h-4 w-4" />
            Settings
          </ButtonLink>
        </div>
      </div>
      {profile.bio ? <p className="mt-3 max-w-2xl whitespace-pre-line text-sm text-text-secondary">{profile.bio}</p> : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Level"
          icon={<Star aria-hidden className="h-4 w-4" />}
          value={profile.level.level}
          hint={
            <>
              <ProgressBar
                size="sm"
                value={profile.level.intoLevel}
                max={profile.level.span}
                label={`Progress to level ${profile.level.level + 1}`}
              />
              <span className="mt-1 block">
                {profile.level.span - profile.level.intoLevel} XP to level {profile.level.level + 1}
              </span>
            </>
          }
        />
        <StatCard
          label="Total XP"
          icon={<Trophy aria-hidden className="h-4 w-4" />}
          value={profile.xpTotal.toLocaleString("en-IN")}
        />
        <StatCard
          label="Current streak"
          icon={<Flame aria-hidden className="h-4 w-4" />}
          value={`${profile.streak.current} ${pluralize(profile.streak.current, "day")}`}
          hint="A day counts when you submit a solution (India time)."
        />
        <StatCard
          label="Longest streak"
          icon={<Flame aria-hidden className="h-4 w-4" />}
          value={`${profile.streak.longest} ${pluralize(profile.streak.longest, "day")}`}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Solved" subtitle="First accepted solutions" />
          <CardBody>
            <SolvedByDifficulty solved={profile.solved} />
          </CardBody>
        </Card>
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader title="Activity" subtitle="The last 365 days" />
          <CardBody>
            <ActivityHeatmap activity={profile.activity} today={profile.today} />
          </CardBody>
        </Card>

        <Card className="min-w-0 lg:col-span-2">
          <CardHeader title="Skill radar" subtitle="Problems solved on your own, by topic" />
          <CardBody>
            <SkillRadar topics={profile.topics} />
          </CardBody>
        </Card>
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader title="On your own vs assisted" subtitle="An honest view of how you solve" />
            <CardBody>
              <AssistedSplit assisted={profile.assisted.assisted} unassisted={profile.assisted.unassisted} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Languages" subtitle="Languages of your first accepted solutions" />
            <CardBody>
              <LanguageSplit languages={profile.languages} />
            </CardBody>
          </Card>
        </div>

        <Card className="min-w-0 lg:col-span-3">
          <CardHeader
            title="Time to solve"
            subtitle="Your active time to a first accepted solution, next to the median of everyone who solved it"
          />
          <CardBody>
            <TimeToSolveTable rows={profile.timeToSolve} />
          </CardBody>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader
            title="Badges"
            subtitle={`${earnedBadges} of ${profile.badges.length} earned`}
          />
          <CardBody>
            <BadgeShelf badges={profile.badges} emptyText="Badges arrive with your first milestones." />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
