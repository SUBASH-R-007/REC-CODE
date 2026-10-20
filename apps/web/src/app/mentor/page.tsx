import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@recx/design";
import { AT_RISK_QUIET_DAYS, formatCampusDay } from "@recx/shared";
import { requireMentorPage } from "@/lib/auth/guards";
import { loadMentorScope } from "@/lib/auth/mentor-scope";
import { myMentees } from "@/server/queries/mentor-mentees";

export const metadata: Metadata = { title: "My mentees" };

/**
 * `/mentor` — the students I am the recorded mentor of (Phase 9d).
 *
 * It fails closed, and visibly: a mentor with no active assignment sees
 * nobody and is told so. That is the whole point of a named mentor of
 * record. A mentor surface that defaulted to "every student in my
 * department" would be a second, undeclared AdminScope with none of the
 * grant records behind it.
 *
 * What it shows is deliberately narrow: who, how long they have been quiet,
 * and why they were assigned. No integrity signal, no submission, no draft,
 * no note. A mentor is here to have a conversation, so the surface is shaped
 * so that the conversation is about coverage and effort.
 */
export default async function MentorPage() {
  const user = await requireMentorPage();
  const scope = await loadMentorScope(user);
  const mentees = await myMentees(scope);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">My mentees</h1>
        <p className="max-w-2xl text-sm text-text-secondary">
          Students the placement cell asked you to speak to. Nothing here is a judgement of them and nothing here is
          on any record a recruiter sees — it is a list of people who would benefit from a conversation.
        </p>
      </header>

      {mentees.length === 0 ? (
        <EmptyState
          title="Nobody is assigned to you"
          description="When the placement cell asks you to follow up with a student, they appear here with the reason they were assigned."
        />
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            {mentees.length === 1 ? "One student" : `${mentees.length} students`}, longest quiet first.
          </p>
          <ul className="space-y-3">
            {mentees.map((mentee) => {
              const quiet = mentee.quietDays !== null && mentee.quietDays >= AT_RISK_QUIET_DAYS;
              return (
                <li key={mentee.userId} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h2 className="font-display text-base font-semibold">
                      <Link href={`/mentor/${mentee.userId}`} className="text-primary underline">
                        {mentee.name}
                      </Link>
                    </h2>
                    <p className="text-sm text-text-secondary">
                      {mentee.collegeId}
                      {mentee.section ? ` · Section ${mentee.section}` : ""}
                    </p>
                  </div>

                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="text-text-secondary">Last active</dt>
                      {/*
                        The number of days, as text. Never a colour alone, and
                        never a word like "at risk" — that is the placement
                        cell's internal rule for routing, not a label to hang
                        on a person a mentor is about to talk to.
                      */}
                      <dd className={quiet ? "font-semibold" : ""}>
                        {mentee.lastActiveOn
                          ? `${formatCampusDay(mentee.lastActiveOn)} (${mentee.quietDays} day${mentee.quietDays === 1 ? "" : "s"} ago)`
                          : "Not recorded yet"}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-text-secondary">Service-tier coverage</dt>
                      <dd>
                        {mentee.serviceScore === null
                          ? "Not measurable yet"
                          : `${mentee.serviceScore} out of ${mentee.serviceAvailableWeight} measurable`}
                      </dd>
                    </div>
                  </dl>

                  <p className="mt-2 text-sm text-text-secondary">
                    Assigned {formatCampusDay(mentee.assignedAt.toISOString().slice(0, 10))}:{" "}
                    &ldquo;{mentee.reason}&rdquo;
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
