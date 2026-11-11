import type { Metadata } from "next";
import { CalendarClock } from "lucide-react";
import { Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { MOCK_INTERVIEW_LIMITS, MOCK_JOIN_BEFORE_MINUTES } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { loadStudentMocks } from "@/server/queries/mock-interviews";
import { SlotRow } from "@/components/mock/slot-list";

export const metadata: Metadata = { title: "Mock interviews" };

/**
 * `/mock-interviews` — book a mock with a TA, and read the feedback
 * afterwards (Phase 12h).
 *
 * The page says two things before it says anything else, because both
 * change how a student uses it: the interviewer can see the editor while
 * the interview runs, and none of this touches XP or readiness. A mock
 * that counted for something would be a thing to game rather than a thing
 * to learn from.
 */
export default async function MockInterviewsPage() {
  const user = await requireUser();
  const mocks = await loadStudentMocks(user.id);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Mock interviews</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          Half an hour with a TA, on a problem they set. Your interviewer can see your editor while it runs — they
          cannot type in it, and nobody else can see it. Nothing here goes on a record: no XP, no readiness, no
          leaderboard. You can hold {MOCK_INTERVIEW_LIMITS.concurrentBookings} bookings at a time, and the room opens{" "}
          {MOCK_JOIN_BEFORE_MINUTES} minutes before the start.
        </p>
      </header>

      <Card>
        <CardHeader title="Yours" />
        <CardBody>
          {mocks.mine.length === 0 ? (
            <EmptyState compact title="Nothing booked" description="Take an open slot below." />
          ) : (
            <ul className="space-y-3">
              {mocks.mine.map((slot) => (
                <SlotRow key={slot.id} slot={slot} as="CANDIDATE" />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Open slots" subtitle="Offered by TAs and mentors, soonest first." />
        <CardBody>
          {mocks.open.length === 0 ? (
            <EmptyState
              compact
              icon={<CalendarClock className="h-5 w-5" />}
              title="Nothing is open"
              description="Slots appear here the moment a TA offers one."
            />
          ) : (
            <ul className="space-y-3">
              {mocks.open.map((slot) => (
                <SlotRow key={slot.id} slot={slot} as="BROWSING" />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {mocks.past.length > 0 ? (
        <Card>
          <CardHeader title="Done" subtitle="With whatever your interviewer wrote." />
          <CardBody>
            <ul className="space-y-3">
              {mocks.past.map((slot) => (
                <SlotRow key={slot.id} slot={slot} as="CANDIDATE" />
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
