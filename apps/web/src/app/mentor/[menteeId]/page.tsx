import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TOPIC_LABEL, TOPICS, formatCampusDay } from "@recx/shared";
import { requireMentorPage } from "@/lib/auth/guards";
import { loadMentorScope, requireScopedMenteePage } from "@/lib/auth/mentor-scope";
import { menteeDetail } from "@/server/queries/mentor-mentees";

export const metadata: Metadata = { title: "A mentee's coverage" };

/**
 * `/mentor/[menteeId]` — one mentee's coverage (Phase 9d).
 *
 * The id goes through `requireScopedMenteePage`, which only passes for a
 * student this viewer is the RECORDED mentor of, and gives a student who
 * does not exist and a student who is somebody else's mentee the same 404 —
 * so ids cannot be probed to learn who is on the platform.
 *
 * The columns are the same allowlist the officer view reads, plus nothing.
 * Never a submission's source, a code draft, a private note, a per-test
 * detail, an accommodation, an audit row, or any integrity signal.
 * `tests/repo/placement-fence.test.ts` is what keeps that true.
 *
 * The three gaps are ranked by the same points figure the student's own card
 * ranks by, so the two of them are looking at the same list. A conversation
 * that starts from a different list than the student sees starts with an
 * argument.
 */
export default async function MenteePage({ params }: { params: Promise<{ menteeId: string }> }) {
  const user = await requireMentorPage();
  const scope = await loadMentorScope(user);
  const { menteeId } = await params;
  const scopedId = requireScopedMenteePage(scope, menteeId);
  const mentee = await menteeDetail(scopedId, user.id);
  if (!mentee) notFound();

  return (
    <div className="space-y-7">
      <header className="space-y-2">
        <p className="text-sm">
          <Link href="/mentor" className="text-primary underline">
            Back to my mentees
          </Link>
        </p>
        <h1 className="font-display text-2xl font-bold tracking-tight">{mentee.name}</h1>
        <p className="text-sm text-text-secondary">
          {mentee.collegeId}
          {mentee.section ? ` · Section ${mentee.section}` : ""}
          {mentee.lastActiveOn
            ? ` · last active ${formatCampusDay(mentee.lastActiveOn)} (${mentee.quietDays} day${mentee.quietDays === 1 ? "" : "s"} ago)`
            : " · no activity recorded yet"}
        </p>
        <p className="max-w-2xl text-sm">
          Assigned to you because: &ldquo;{mentee.reason}&rdquo;
        </p>
      </header>

      {mentee.tiers.length === 0 ? (
        <p className="max-w-2xl text-sm text-text-secondary">
          Nothing has been worked out for this student yet. It is computed overnight from what they practise, so it
          will appear after the next nightly run.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted">
            Worked out on {formatCampusDay(mentee.computedOn)}, from everything up to that day. Each score is out of
            the weight that could actually be measured, not out of 100.
          </p>

          <div className="grid gap-5 md:grid-cols-3">
            {mentee.tiers.map((tier) => (
              <section key={tier.tier} className="space-y-3 rounded-xl border border-border p-4">
                <h2 className="font-display text-base font-semibold">{tier.label}</h2>
                <p className="flex items-baseline gap-1.5">
                  {tier.score === null ? (
                    <span className="text-sm text-text-secondary">Nothing measurable yet</span>
                  ) : (
                    <>
                      <span className="font-display text-2xl font-bold tabular-nums">{tier.score}</span>
                      <span className="text-sm text-text-secondary">out of {tier.availableWeight} measurable</span>
                    </>
                  )}
                </p>
                {tier.gaps.length > 0 ? (
                  <div className="space-y-1">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      Worth the most to them
                    </h3>
                    <ul className="space-y-1 text-sm">
                      {tier.gaps.map((row) => (
                        <li key={row.component} className="flex justify-between gap-3">
                          <span>{row.label}</span>
                          <span className="shrink-0 tabular-nums text-text-secondary">
                            +{row.pointsAvailable.toFixed(1)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ))}
          </div>

          <section className="space-y-3">
            <h2 className="font-display text-lg font-semibold">Breadth, topic by topic</h2>
            <p className="max-w-2xl text-sm text-text-secondary">
              Unassisted solves per topic — the counts the breadth MINIMUM was taken over. The lowest one is what the
              student&rsquo;s own page names as holding them back, so this is the list to open the conversation with.
            </p>
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {TOPICS.map((topic) => (
                <li
                  key={topic}
                  className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 text-sm"
                >
                  <span>{TOPIC_LABEL[topic]}</span>
                  <span className="tabular-nums text-text-secondary">{mentee.topicUnassisted[topic] ?? 0}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <p className="max-w-2xl border-t border-border pt-5 text-xs text-muted">
        This page shows coverage and activity. It deliberately does not show their code, their drafts, their private
        notes or anything about proctoring — none of that would help the conversation, and all of it is theirs.
      </p>
    </div>
  );
}
