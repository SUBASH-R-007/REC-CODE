import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { patternCoverFor } from "@/server/queries/aptitude";
import { PatternNotice } from "@/components/aptitude/pattern-notice";
import { StartMockButton } from "@/components/aptitude/start-mock-button";

export const metadata: Metadata = { title: "Mock" };

const minutes = (seconds: number) => Math.round(seconds / 60);

/**
 * `/aptitude/mock/[slug]` — the cover page (Phase 7e).
 *
 * Everything the scoring does is stated HERE, before the clock starts: the
 * sections and their order, the minutes, the question counts, the cutoffs,
 * the negative marking, and whether a section lets you go back. That is the
 * same posture as the rule that proctoring terms are never hidden until after
 * the start — a scoring rule a student cannot read is not a fair rule
 * (`docs/ACCESSIBILITY.md`).
 *
 * In particular: where `allowBackNavigation` is false the page SAYS SO, and
 * the sitting then has no Previous control at all rather than a disabled one.
 * A disabled control with no explanation is the version a screen-reader user
 * cannot make sense of.
 */
export default async function MockCoverPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const pattern = await patternCoverFor(slug, user.id);
  if (!pattern) notFound();

  const live = pattern.attempts.find((attempt) => attempt.status === "IN_PROGRESS") ?? null;
  const finished = pattern.attempts.filter(
    (attempt) => attempt.status === "SUBMITTED" || attempt.status === "AUTO_SUBMITTED",
  );
  const anyNegative = pattern.sections.some((section) => section.negativeMarkFraction > 0);
  const anyNoBack = pattern.sections.some((section) => !section.allowBackNavigation);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Link href="/aptitude" className="text-sm text-text-secondary hover:underline">
          ← Aptitude
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight">{pattern.name}</h1>
        <p className="text-sm text-muted">{pattern.funnelLabel}</p>
        <PatternNotice notice={pattern.notice} />
        <p className="max-w-3xl text-sm text-text-secondary">{pattern.description}</p>
        <p className="max-w-3xl text-xs text-muted">{pattern.sourceNote}</p>
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">How it is scored</h2>
        <ul className="max-w-3xl space-y-1 text-sm text-text-secondary">
          <li>
            {pattern.sections.length} sections, {pattern.totalQuestions} questions,{" "}
            {minutes(pattern.totalTimeSec)} minutes in all. Each section has its own clock.
          </li>
          <li>
            You clear the mock by clearing <strong>every</strong> section&apos;s cutoff. A high total does not make up
            for a section you missed — that is how the real round works, and a mock that averaged them would tell you
            the opposite of the truth.
          </li>
          {anyNegative ? (
            <li className="text-warning">
              Wrong answers lose marks in some sections. Leaving a question blank costs you nothing at all.
            </li>
          ) : (
            <li>Wrong answers do not lose marks. There is no reason not to attempt everything.</li>
          )}
          {anyNoBack ? (
            <li>
              Some sections do not let you return to an earlier question. They are marked below, and in those sections
              there is no Previous control.
            </li>
          ) : null}
          <li>A section you leave is closed for good. Its clock does not come back.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">The sections</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">
              Every section of {pattern.name}, with its length, time, cutoff and scoring
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-2 pr-3">
                  #
                </th>
                <th scope="col" className="py-2 pr-3">
                  Section
                </th>
                <th scope="col" className="py-2 pr-3">
                  Questions
                </th>
                <th scope="col" className="py-2 pr-3">
                  Time
                </th>
                <th scope="col" className="py-2 pr-3">
                  Cutoff
                </th>
                <th scope="col" className="py-2 pr-3">
                  Wrong answer
                </th>
                <th scope="col" className="py-2">
                  Going back
                </th>
              </tr>
            </thead>
            <tbody>
              {pattern.sections.map((section) => (
                <tr key={section.position} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3">{section.position}</td>
                  <td className="py-2 pr-3 font-medium">{section.label}</td>
                  <td className="py-2 pr-3">{section.questionCount}</td>
                  <td className="py-2 pr-3">{minutes(section.timeLimitSec)} min</td>
                  <td className="py-2 pr-3">
                    {section.cutoffPercent > 0 ? (
                      `${section.cutoffPercent}%`
                    ) : (
                      <span className="text-muted">none</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {section.negativeMarkFraction > 0 ? (
                      <span className="text-warning">
                        −{section.negativeMarkFraction * section.marksPerCorrect} mark
                      </span>
                    ) : (
                      <span className="text-muted">no penalty</span>
                    )}
                  </td>
                  <td className="py-2">
                    {section.allowBackNavigation ? (
                      "allowed, within the section"
                    ) : (
                      <span className="font-medium">not allowed</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {finished.length > 0 ? (
        <section className="space-y-2">
          <h2 className="font-display text-lg font-semibold">Your sittings</h2>
          <ul className="space-y-1 text-sm">
            {finished.map((attempt) => (
              <li key={attempt.id} className="flex items-center gap-3">
                <Badge tone={attempt.passedOverall ? "success" : "warning"}>
                  {attempt.passedOverall ? "Cleared" : "Not cleared"}
                </Badge>
                <span>{attempt.percent}%</span>
                <Link href={`/aptitude/mock/attempt/${attempt.id}/review`} className="text-primary underline">
                  See every question and its working
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <StartMockButton slug={pattern.slug} liveAttemptId={live?.id ?? null} />
    </div>
  );
}
