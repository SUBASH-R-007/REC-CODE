import type { Metadata } from "next";
import Link from "next/link";
import { Badge, EmptyState } from "@recx/design";
import { Calculator } from "lucide-react";
import { requireUser } from "@/lib/auth/guards";
import { patternCardsFor, topicProgressFor, topicsByArea } from "@/server/queries/aptitude";
import { PatternNotice } from "@/components/aptitude/pattern-notice";

export const metadata: Metadata = { title: "Aptitude" };

const minutes = (seconds: number) => Math.round(seconds / 60);

/**
 * `/aptitude` — the hub (Phase 7e).
 *
 * SPEC §5 opens Phase 7 by explaining who this page is for: the majority of
 * REC's 5,000 students are screened by an aptitude round BEFORE anyone reads
 * their code, so this is the surface the largest number of students will ever
 * use — and a sizeable number of them on a phone, which is why it works at
 * 375px.
 *
 * All 29 topics are listed, not only the ones a student has tried. A list
 * that grows as you use it hides the thing you have been avoiding, and the
 * student who has never opened Blood Relations is exactly the student who
 * needs to see it.
 *
 * A topic nobody has attempted shows no percentage at all rather than 0%: a
 * zero that means "untouched" is the kind of number a student reads as a
 * verdict on themselves.
 */
export default async function AptitudePage() {
  const user = await requireUser();
  const [progress, patterns] = await Promise.all([topicProgressFor(user.id), patternCardsFor(user.id)]);
  const areas = topicsByArea(progress);
  const attempted = progress.filter((row) => row.attempted > 0).length;

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Aptitude</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          Quantitative, logical and verbal practice, and full mocks against the shapes real recruiter rounds use.
          Every question has a worked explanation — if you get one wrong, you get the working, not a tick.
        </p>
        {attempted > 0 ? (
          <p className="text-sm text-text-secondary">
            You have practised {attempted} of {progress.length} topics.
          </p>
        ) : null}
      </header>

      {patterns.length > 0 ? (
        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold">Full mocks</h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {patterns.map((pattern) => (
              <li key={pattern.slug} className="space-y-2 rounded-xl border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-medium">
                      <Link href={`/aptitude/mock/${pattern.slug}`} className="text-primary underline">
                        {pattern.name}
                      </Link>
                    </h3>
                    <p className="text-xs text-muted">{pattern.funnelLabel}</p>
                  </div>
                  {pattern.liveAttemptId ? <Badge tone="info">In progress</Badge> : null}
                </div>

                {/* The notice is required beside the NAME, and it is text
                    rather than a tooltip so nobody can miss it. */}
                <PatternNotice notice={pattern.notice} />

                <p className="text-sm text-text-secondary">{pattern.description}</p>

                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
                  <div>
                    <dt className="inline">Sections: </dt>
                    <dd className="inline font-medium">{pattern.sections}</dd>
                  </div>
                  <div>
                    <dt className="inline">Questions: </dt>
                    <dd className="inline font-medium">{pattern.totalQuestions}</dd>
                  </div>
                  <div>
                    <dt className="inline">Time: </dt>
                    <dd className="inline font-medium">{minutes(pattern.totalTimeSec)} min</dd>
                  </div>
                  {pattern.hasNegativeMarking ? (
                    <div>
                      <dt className="inline">Wrong answers: </dt>
                      <dd className="inline font-medium text-warning">lose marks</dd>
                    </div>
                  ) : null}
                </dl>

                {pattern.bestPercent !== null ? (
                  <p className="text-sm">
                    Your best: <strong>{pattern.bestPercent}%</strong>
                    {pattern.medianPercent !== null ? (
                      <span className="text-text-secondary"> · the middle of the room is {pattern.medianPercent}%</span>
                    ) : null}
                  </p>
                ) : null}
                {/* The cohort number appears only once the pattern HAS a
                    cohort: a percentile over four attempts is noise, and this
                    is the only number a student is told about the room. */}
                {pattern.bestPercent !== null && !pattern.cohortIsMeaningful ? (
                  <p className="text-xs text-muted">
                    Not enough people have sat this yet for a comparison to mean anything.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-4">
        <h2 className="font-display text-lg font-semibold">Practise one topic at a time</h2>
        {progress.every((row) => row.available === 0) ? (
          <EmptyState
            icon={<Calculator aria-hidden="true" />}
            title="No questions yet"
            description="The aptitude bank is still being written. Nothing you did caused this, and the placement cell knows."
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            {areas.map((area) => (
              <section key={area.area} className="space-y-2">
                <h3 className="text-sm font-semibold">{area.label}</h3>
                <ul className="space-y-1">
                  {area.topics.map((topic) => (
                    <li key={topic.topic}>
                      {topic.available === 0 ? (
                        <span className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm text-muted">
                          <span>{topic.label}</span>
                          <span className="text-xs">none yet</span>
                        </span>
                      ) : (
                        <Link
                          href={`/aptitude/${topic.slug}`}
                          className="flex min-h-10 items-center justify-between gap-2 rounded-md px-3 py-2 text-sm hover:bg-elevated"
                        >
                          <span>{topic.label}</span>
                          <span className="flex items-center gap-2 text-xs text-text-secondary">
                            {topic.accuracyPercent === null ? (
                              <span>{topic.available} to try</span>
                            ) : (
                              <>
                                <span>
                                  {topic.correct}/{topic.attempted}
                                </span>
                                <span className="font-medium">{topic.accuracyPercent}%</span>
                              </>
                            )}
                          </span>
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
