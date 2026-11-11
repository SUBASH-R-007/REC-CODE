import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import {
  INTERVIEW_MODE_LABEL,
  INTERVIEW_OUTCOME_LABEL,
  INTERVIEW_PREPARATION_LABEL,
  INTERVIEW_ROUND_LABEL,
  TOPIC_LABEL,
  formatCampusTime,
} from "@recx/shared";
import { requireMentorPage } from "@/lib/auth/guards";
import { loadPendingExperiences } from "@/server/queries/interviews";
import { ExperienceDecision } from "@/components/interviews/experience-decision";

export const metadata: Metadata = { title: "Interview submissions" };

const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * `/mentor/experiences` — interview accounts waiting to be read
 * (Phase 12e).
 *
 * This queue is more consequential than it looks. Approving a row makes a
 * public claim about a named company AND moves the "asked at" counts a
 * student revises against the night before a drive. So two things are
 * deliberate here:
 *
 *   * the moderator picks the CATALOGUE company at approval time, rather
 *     than the student's free-text name creating one — which is how a
 *     catalogue ends up with "Zoho", "zoho corp" and "ZOHO";
 *   * approving without a company is allowed. The account is still worth
 *     reading; it simply contributes no tag until somebody says which
 *     company it was.
 *
 * Moderators see the author's name. Students never do. A row nobody
 * stands behind cannot be followed up, and an account with a name on it
 * is one nobody would have posted.
 */
export default async function MentorExperiencesPage() {
  await requireMentorPage();
  const { pending, companies } = await loadPendingExperiences();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Interview submissions</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          Students&apos; accounts of interviews they sat, oldest first. Approving one publishes it anonymously and, if
          you say which company it was, adds what they recognised to that company&apos;s &ldquo;asked at&rdquo; counts
          on the problem catalogue. Your reason is shown to the student either way.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Waiting"
          subtitle={pending.length === 0 ? "Nothing to read" : `${pending.length} waiting`}
        />
        <CardBody>
          {pending.length === 0 ? (
            <EmptyState
              compact
              icon={<ClipboardCheck className="h-5 w-5" />}
              title="Nothing is waiting"
              description="Submissions appear here the moment a student sends one."
            />
          ) : (
            <ol className="space-y-5">
              {pending.map((entry) => (
                <li key={entry.id} className="rounded-2xl border border-border p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="font-display text-sm font-semibold">
                      {entry.company} · <span className="font-normal text-text-secondary">{entry.role}</span>
                    </h2>
                    <span className="text-xs text-muted">
                      {MONTHS[entry.heldMonth]} {entry.heldYear} · {INTERVIEW_MODE_LABEL[entry.mode]} ·{" "}
                      {INTERVIEW_OUTCOME_LABEL[entry.outcome]}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {entry.author ?? "Collected before launch"} · sent {formatCampusTime(entry.createdAt)} · shown to
                    students as &ldquo;{entry.by}&rdquo;
                  </p>

                  <p className="mt-2 text-sm">
                    {entry.rounds} round{entry.rounds === 1 ? "" : "s"}
                    {entry.longestRoundMinutes ? `, longest ${entry.longestRoundMinutes} min` : ""} ·{" "}
                    {entry.roundKinds.map((kind) => INTERVIEW_ROUND_LABEL[kind]).join(", ")}
                  </p>
                  {entry.topics.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1.5">
                      {entry.topics.map((topic) => (
                        <Badge key={topic}>{TOPIC_LABEL[topic]}</Badge>
                      ))}
                    </p>
                  )}
                  {entry.preparation.length > 0 && (
                    <p className="mt-1 text-xs text-text-secondary">
                      Helped: {entry.preparation.map((item) => INTERVIEW_PREPARATION_LABEL[item]).join(", ")}
                    </p>
                  )}
                  {entry.problems.length > 0 && (
                    <p className="mt-2 text-sm">
                      <span className="font-medium">Problems named: </span>
                      {entry.problems.map((problem, index) => (
                        <span key={problem.slug}>
                          {index > 0 ? ", " : ""}
                          <Link href={`/problems/${problem.slug}`} className="text-primary hover:underline">
                            {problem.displayCode}
                          </Link>
                        </span>
                      ))}
                    </p>
                  )}

                  <ExperienceDecision
                    experienceId={entry.id}
                    companies={companies}
                    suggestedCompanyId={entry.linkedCompanyId ?? entry.suggestedCompanyId}
                    problemCount={entry.problems.length}
                    typedCompanyName={entry.company}
                  />
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
