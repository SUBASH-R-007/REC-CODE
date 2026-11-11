import type { Metadata } from "next";
import { CalendarClock } from "lucide-react";
import { Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { MOCK_INTERVIEW_LIMITS } from "@recx/shared";
import { requireMentorPage } from "@/lib/auth/guards";
import { loadMentorMocks } from "@/server/queries/mock-interviews";
import { OfferSlot } from "@/components/mock/offer-slot";
import { SlotRow } from "@/components/mock/slot-list";

export const metadata: Metadata = { title: "Mock interviews" };

/**
 * `/mentor/mock-interviews` — offer slots, and run them (Phase 12h).
 *
 * A mentor offers a time; one student takes it; at the time, both open the
 * room and the interviewer sees the candidate's editor, read-only. SPEC
 * §11 asks for exactly that and contrasts it with collaborative editing,
 * which is why there is no way to type into somebody else's editor here.
 */
export default async function MentorMockInterviewsPage() {
  const user = await requireMentorPage();
  const mocks = await loadMentorMocks(user.id);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Mock interviews</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          Offer a time, and a student takes it. In the room you set a problem and watch their editor while they work —
          you cannot type in it. Nothing you write goes on any record a recruiter sees; it is written for the
          candidate, and they read it as soon as you finish.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Offer a slot"
          subtitle={`${MOCK_INTERVIEW_LIMITS.durationMinutes.min}–${MOCK_INTERVIEW_LIMITS.durationMinutes.max} minutes, within the next ${MOCK_INTERVIEW_LIMITS.offerDaysAhead.max} days.`}
        />
        <CardBody>
          <OfferSlot />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Coming up" />
        <CardBody>
          {mocks.upcoming.length === 0 ? (
            <EmptyState
              compact
              icon={<CalendarClock className="h-5 w-5" />}
              title="Nothing offered"
              description="Offer a slot above and it appears here, and on every student's list."
            />
          ) : (
            <ul className="space-y-3">
              {mocks.upcoming.map((slot) => (
                <SlotRow key={slot.id} slot={slot} as="MENTOR" />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {mocks.past.length > 0 ? (
        <Card>
          <CardHeader title="Done" />
          <CardBody>
            <ul className="space-y-3">
              {mocks.past.map((slot) => (
                <SlotRow key={slot.id} slot={slot} as="MENTOR" />
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
