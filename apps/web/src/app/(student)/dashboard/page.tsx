import type { Metadata } from "next";
import { greetingForHour, pluralize } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { getDashboard } from "@/server/queries/dashboard";
import { myStanding } from "@/server/queries/account";
import { DormancyChip } from "@/components/account/dormancy-chip";
import { getActiveAnnouncements } from "@/server/queries/announcements";
import { campusHour } from "@/components/dashboard/model";
import { AnnouncementBanner } from "@/components/dashboard/announcement-banner";
import { ContinueCard } from "@/components/dashboard/continue-card";
import { LevelCard, StreakCard, WeeklyGoalCard } from "@/components/dashboard/progress-cards";
import { DailyChallengeCard, RecentSubmissionsCard, StudyPlansCard } from "@/components/dashboard/activity-cards";
import { RevisionCard } from "@/components/dashboard/revision-card";
import { loadRevisionQueue } from "@/server/queries/revision";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The student home (homeForRole → /dashboard). Server-rendered from the
 * maintained read models; the only client JS of its own is the announcement
 * banner's "Dismiss" button (when there is a live announcement). Mentors and placement
 * officers also land here until their homes arrive (Phase 9), so the guard
 * is requireUser — every row read is the viewer's own.
 */
export default async function DashboardPage() {
  const user = await requireUser();
  const now = new Date();
  const [data, announcements, standing, revision] = await Promise.all([
    getDashboard(user.id, now),
    getActiveAnnouncements(user.id, now),
    // Phase 8e. Its own read rather than a field on the dashboard model: the
    // chip is about the account, not about progress, and a restricted student
    // must see it even on a day when nothing else on this page has anything
    // to say.
    myStanding(user.id, now),
    // Phase 12c. A schedule nobody is reminded of is a schedule nobody
    // keeps, and this is the page a student actually opens.
    loadRevisionQueue(user.id, now),
  ]);

  const summary =
    data.solvedTotal === 0
      ? "Welcome to REC Code. Solve your first problem to start a streak and earn XP."
      : `${data.solvedTotal} ${pluralize(data.solvedTotal, "problem")} solved so far · Level ${data.level.level}.`;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          {greetingForHour(campusHour(now))}, {user.firstName}.
        </h1>
        <p className="mt-1 text-sm text-text-secondary">{summary}</p>
      </header>

      {/* Before the announcements and before the cards: SPEC §5's rule is
          that the restriction explanation sits ahead of the page's content in
          DOM order, so a screen-reader user meets it first. It is also never
          a toast — a message that disappears is not an explanation. */}
      <DormancyChip chip={standing.chip} />

      <AnnouncementBanner announcements={announcements} />

      <div className="grid gap-5 lg:grid-cols-3">
        <ContinueCard recommendation={data.recommendation} className="lg:col-span-2" />
        <DailyChallengeCard daily={data.daily} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <WeeklyGoalCard weekly={data.weekly} />
        <StreakCard streak={data.streak} week={data.week} />
        <LevelCard level={data.level} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <RecentSubmissionsCard rows={data.recent} now={now} className="lg:col-span-2" />
        <StudyPlansCard plans={data.plans} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <RevisionCard queue={revision} className="lg:col-span-2" />
      </div>
    </div>
  );
}
