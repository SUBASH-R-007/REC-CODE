import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, Card, CardHeader, EmptyState } from "@recx/design";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { formatCampusDateTime } from "@/lib/help/copy";
import { getAssessmentDetail } from "@/server/queries/admin-assessments";
import {
  AddMcqForm,
  AddQuestionForm,
  RemoveMcqButton,
  RemoveQuestionButton,
  ScheduleHallForm,
  StatusButtons,
} from "@/components/admin/assessments/assessment-forms";
import { SebKeysForm } from "@/components/admin/assessments/seb-keys-form";
import { AssessmentLanguagesForm } from "@/components/admin/assessments/languages-form";
import { QuestionLanguagesForm } from "@/components/admin/assessments/question-languages-form";

export const metadata: Metadata = { title: "Assessment" };

const TD = "px-3 py-2";

const MODE_LABEL: Record<string, string> = {
  ADVISORY: "Advisory — watched and recorded, sat anywhere",
  REMOTE_MONITORED: "Remote monitored — a registered device",
  KIOSK_SEB: "Kiosk (Safe Exam Browser), verified per request",
  LAB_SUPERVISED: "Lab supervised — a college hall, on the hall's network",
};

/**
 * One assessment: its terms, its questions, its halls, and the one button
 * that moves it along (Phase 12a). While it is a DRAFT everything here is
 * editable; after that the database refuses, and so does this page.
 */
export default async function AdminAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  /**
   * The scoped guard (Phase 13j). This page reads no candidate itself,
   * but it shares a query module with the list, which counts sittings by
   * the reader's own students -- and `tests/repo/admin-scope.test.ts` R8
   * asks every page that can reach a student read to load its scope
   * rather than rely on which export it happens to call.
   */
  await requireAdminScopePage();
  const { id } = await params;
  const assessment = await getAssessmentDetail(id);
  if (!assessment) notFound();

  const draft = assessment.status === "DRAFT";
  /**
   * What the paper accepts, which is the most a question can be narrowed
   * to: the ticked list, or every installed language when nothing is
   * ticked (Phase 13c).
   */
  const paperLanguages =
    assessment.allowedLanguages.length === 0
      ? assessment.availableLanguages
      : assessment.availableLanguages.filter((language) => assessment.allowedLanguages.includes(language.key));
  const needsAllowlist = assessment.proctorMode === "LAB_SUPERVISED";
  /**
   * The next free number in the palette, which is ONE list across both
   * kinds (Phase 12r): suggesting a number a coding question already holds
   * would mean the author's first attempt is always refused.
   */
  const nextPosition =
    Math.max(0, ...assessment.problems.map((p) => p.position), ...assessment.mcqs.map((m) => m.position)) + 1;

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text">{assessment.title}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {assessment.slug} · {MODE_LABEL[assessment.proctorMode] ?? assessment.proctorMode}
          </p>
          {/**
            * The two per-paper watching options (Phase 12s), named only
            * when they are on: a list of everything that is off is a list
            * nobody reads. docs/PROCTORING.md §9 says what each does and
            * what it does not.
            */}
          {assessment.refuseOutsidePaste || assessment.sitInPopup ? (
            <p className="mt-1 flex flex-wrap gap-2 text-xs">
              {assessment.refuseOutsidePaste ? (
                <span className="rounded-md border border-primary/30 bg-primary-subtle px-1.5 py-0.5 text-text">
                  Only text copied inside pastes
                </span>
              ) : null}
              {assessment.sitInPopup ? (
                <span className="rounded-md border border-primary/30 bg-primary-subtle px-1.5 py-0.5 text-text">
                  Opens in its own window
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={assessment.status === "OPEN" ? "success" : assessment.status === "DRAFT" ? "warning" : "info"}>
            {assessment.status}
          </Badge>
          {/**
            * The way to the marks (Phase 12y). Shown once anybody has sat
            * the paper, because a Results link on a paper nobody has
            * opened leads to an empty table and reads like something is
            * broken.
            */}
          {assessment.attempts > 0 ? (
            <ButtonLink href={`/admin/assessments/${assessment.id}/results`}>
              Results ({assessment.attempts})
            </ButtonLink>
          ) : null}
          <ButtonLink href="/admin/assessments" variant="outline">
            Back
          </ButtonLink>
        </div>
      </div>

      <Card className="mb-6 p-5">
        <CardHeader title="Terms" />
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Window</dt>
            <dd>
              {formatCampusDateTime(assessment.opensAt)} → {formatCampusDateTime(assessment.closesAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Clock</dt>
            <dd>{Math.round(assessment.durationSec / 60)} minutes</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Attempts</dt>
            <dd>{assessment.maxAttempts}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Focus warnings</dt>
            <dd>
              {assessment.maxFocusWarnings}, then{" "}
              {assessment.onLimit === "AUTOSUBMIT" ? "submit what they have" : "flag it for a reviewer"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Placement</dt>
            <dd>{assessment.affectsPlacementEligibility ? "May count towards eligibility" : "Does not count"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Audience</dt>
            <dd>
              {[assessment.audienceBatchYear, assessment.audienceDepartmentCode, assessment.audienceSection]
                .filter(Boolean)
                .join(" · ") || "Everybody"}
            </dd>
          </div>
        </dl>
        <div className="mt-5 border-t border-border pt-5">
          <StatusButtons assessmentId={assessment.id} status={assessment.status} />
        </div>
      </Card>

      {/**
        * Which languages the paper is answered in (Phase 13a).
        *
        * Beside the terms rather than inside them, because unlike the
        * window and the clock it stays editable after publication: it
        * cannot move under anybody sitting (each attempt freezes its own
        * set) so the only thing an edit changes is what the next
        * candidate is offered.
        */}
      <Card className="mb-6 p-5">
        <CardHeader title="Languages" subtitle="What candidates may answer the programs in." />
        <div className="mt-4">
          <AssessmentLanguagesForm
            assessmentId={assessment.id}
            available={assessment.availableLanguages}
            selected={assessment.allowedLanguages}
            published={assessment.status !== "DRAFT"}
          />
        </div>
      </Card>

      <Card className="mb-6 p-5">
        <CardHeader title={`Questions (${assessment.problems.length})`} />
        <p className="mt-1 text-xs text-text-secondary">
          Each is pinned at the problem&rsquo;s live frozen revision, by id. A later revision of the problem does not
          change what this assessment asks.
        </p>
        {assessment.problems.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="No questions yet" description="An empty paper cannot be published." />
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-elevated text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className={TD}>#</th>
                  <th className={TD}>Problem</th>
                  <th className={TD}>Revision</th>
                  <th className={TD}>Points</th>
                  {/* Phase 13c: the paper says what it accepts, a question
                      may ask for less of it. The column is drawn only when
                      there is more than one language to choose between. */}
                  {assessment.availableLanguages.length > 1 ? <th className={TD}>Answered in</th> : null}
                  {draft ? <th className={TD} /> : null}
                </tr>
              </thead>
              <tbody>
                {assessment.problems.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className={`${TD} tabular-nums`}>{p.position}</td>
                    <td className={TD}>
                      <Link href={`/problems/${p.slug}`} className="text-primary hover:underline">
                        {p.displayCode} {p.title}
                      </Link>
                    </td>
                    <td className={`${TD} tabular-nums`}>r{p.revision}</td>
                    <td className={`${TD} tabular-nums`}>{p.points}</td>
                    {assessment.availableLanguages.length > 1 ? (
                      <td className={TD}>
                        <QuestionLanguagesForm
                          assessmentProblemId={p.id}
                          position={p.position}
                          paper={paperLanguages}
                          selected={p.allowedLanguages}
                        />
                      </td>
                    ) : null}
                    {draft ? (
                      <td className={TD}>
                        <RemoveQuestionButton assessmentProblemId={p.id} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {draft ? (
          <div className="mt-5 border-t border-border pt-5">
            <AddQuestionForm assessmentId={assessment.id} nextPosition={nextPosition} />
          </div>
        ) : null}
      </Card>

      <Card className="mb-6 p-5">
        <CardHeader title={`Multiple-choice questions (${assessment.mcqs.length})`} />
        <p className="mt-1 text-xs text-text-secondary">
          Marked without a judge: one mark for the right option, nothing for a wrong one, and nothing taken off. Each
          candidate sees the options in their own order, so &ldquo;the third one&rdquo; is no use to a neighbour.
        </p>
        {assessment.mcqs.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="No multiple-choice questions" description="A paper may be all code, all questions, or a mix." />
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-elevated text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className={TD}>#</th>
                  <th className={TD}>Question</th>
                  <th className={TD}>Answer</th>
                  <th className={TD}>Marks</th>
                  {draft ? <th className={TD} /> : null}
                </tr>
              </thead>
              <tbody>
                {assessment.mcqs.map((m) => (
                  <tr key={m.id} className="border-b border-border last:border-0">
                    <td className={`${TD} tabular-nums`}>{m.position}</td>
                    <td className={TD}>
                      <span className="block max-w-prose">{m.stem}</span>
                      <span className="mt-1 block text-xs text-text-secondary">{m.options.length} options</span>
                    </td>
                    {/* The author needs to see which one they marked right;
                        this page is staff-only and the candidate's view has
                        no field for it at all. */}
                    <td className={TD}>{m.options[m.correctIndex] ?? "—"}</td>
                    <td className={`${TD} tabular-nums`}>{m.points}</td>
                    {draft ? (
                      <td className={TD}>
                        <RemoveMcqButton assessmentMcqId={m.id} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {draft ? (
          <div className="mt-5 border-t border-border pt-5">
            <AddMcqForm assessmentId={assessment.id} nextPosition={nextPosition} />
          </div>
        ) : null}
      </Card>

      <Card className="p-5">
        <CardHeader title={`Halls (${assessment.sessions.length})`} />
        <p className="mt-1 text-xs text-text-secondary">
          {needsAllowlist
            ? "A lab-supervised sitting is seated in a hall, and the hall's network allowlist is what enforces it: a machine that leaves is refused on its next heartbeat."
            : "A hall is optional for this mode. Scheduling one still gives the invigilation page somebody to watch."}
        </p>
        {assessment.sessions.length > 0 ? (
          <div className="mt-4 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-elevated text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className={TD}>Hall</th>
                  <th className={TD}>Window</th>
                  <th className={TD}>Seats</th>
                  <th className={TD}>Networks</th>
                  <th className={TD}>Seated</th>
                </tr>
              </thead>
              <tbody>
                {assessment.sessions.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className={TD}>
                      <Link href={`/admin/invigilate/${s.id}`} className="text-primary hover:underline">
                        {s.label}
                      </Link>
                      {s.room ? <div className="text-xs text-muted">{s.room}</div> : null}
                    </td>
                    <td className={TD}>
                      {formatCampusDateTime(s.startsAt)} → {formatCampusDateTime(s.endsAt)}
                    </td>
                    <td className={`${TD} tabular-nums`}>{s.capacity}</td>
                    <td className={`${TD} font-mono text-xs`}>{s.allowedCidrs.join(", ") || "any"}</td>
                    <td className={`${TD} tabular-nums`}>{s.seated}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {assessment.status === "CLOSED" || assessment.status === "ARCHIVED" ? null : (
          <div className="mt-5 border-t border-border pt-5">
            <ScheduleHallForm assessmentId={assessment.id} needsAllowlist={needsAllowlist} />
          </div>
        )}
      </Card>

      {/**
        * The Safe Exam Browser keys (Phase 12z), on a kiosk paper only.
        *
        * The last link in the chain: 12y.8 generates the .seb file and the
        * readiness page hands it to SEB, SEB sends `sha256(url + key)` on
        * every request, and this is where the key it is compared against
        * is saved. Without it a kiosk paper refuses every candidate with
        * "no exam keys have been configured" — which is correct, and was
        * uncurable through the product.
        *
        * Beside the halls because that is where the person who needs it
        * already is, and one form per hall because the keys rotate per
        * sitting: `sebKeysFor` prefers a hall's own over the college's.
        */}
      {assessment.proctorMode === "KIOSK_SEB" ? (
        <Card className="mb-6 p-5">
          <CardHeader title="Safe Exam Browser keys" />
          <p className="mt-1 text-xs text-text-secondary">
            Open the paper&apos;s <code className="font-mono">.seb</code> file in SEB Config Tool and copy the key it
            shows. A hall&apos;s own keys win over the college&apos;s, so a sitting with a rotated file needs no
            change anywhere else. Until one is set, this paper refuses every candidate — which is the right answer to
            a kiosk exam nobody can verify, not a fault.
          </p>
          <p className="mt-2 text-xs text-text-secondary">
            The file candidates are given:{" "}
            <a className="text-primary underline-offset-2 hover:underline" href={`/api/exam/seb-config/${assessment.slug}`}>
              {assessment.slug}.seb
            </a>
          </p>
          <div className="mt-4 space-y-4">
            {assessment.sessions.length === 0 ? (
              <p className="rounded-lg border border-border p-3 text-sm text-text-secondary">
                No hall is scheduled yet, and keys belong to a hall. Schedule one above and its boxes appear here.
              </p>
            ) : null}
            <p className="text-xs text-muted">
              {/* Said plainly rather than pointing at a screen that does not
                  exist: the college-wide fallback predates this form and is
                  still read, but nothing in the product writes it. */}
              A hall with no keys of its own falls back to the college-wide pair, which is{" "}
              {assessment.sebCollegeKeys.configKey ? "set" : "not set"} — that one has no screen yet, so set each
              hall&apos;s own here.
            </p>
            {assessment.sessions.map((session) => (
              <SebKeysForm
                key={session.id}
                scope={{ kind: "hall", examSessionId: session.id }}
                label={`${session.label}${session.room ? ` · ${session.room}` : ""}`}
                configKeySet={session.sebKeys.configKey}
                browserExamKeySet={session.sebKeys.browserExamKey}
              />
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
