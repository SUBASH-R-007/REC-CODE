import type { Metadata } from "next";
import { greetingForHour, pluralize } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { getDashboard } from "@/server/queries/dashboard";
import { getActiveAnnouncements } from "@/server/queries/announcements";
import { campusHour } from "@/components/dashboard/model";
import { AnnouncementBanner } from "@/components/dashboard/announcement-banner";
import { ContinueCard } from "@/components/dashboard/continue-card";
import { LevelCard, StreakCard, WeeklyGoalCard } from "@/components/dashboard/progress-cards";
import { DailyChallengeCard, RecentSubmissionsCard, StudyPlansCard } from "@/components/dashboard/activity-cards";

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
  const [data, announcements] = await Promise.all([getDashboard(user.id, now), getActiveAnnouncements(user.id, now)]);

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

      <AnnouncementBanner announcements={announcements} />

      <div className="grid gap-5 lg:grid-cols-3">
        <ContinueCard action={data.continueAction} now={now} className="lg:col-span-2" />
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
    </div>
  );
}
