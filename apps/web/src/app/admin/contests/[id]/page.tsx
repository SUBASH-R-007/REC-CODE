import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { requirePageRole } from "@/lib/auth/guards";
import { formatCampusDateTime } from "@/lib/help/copy";
import {
  AddProblemForm,
  PublishContestButton,
  RemoveProblemButton,
} from "@/components/admin/contests/contest-forms";
import { KIND_LABEL, formatDuration } from "@/components/contests/model";
import { getAdminContest } from "@/server/queries/admin-contests";

export const metadata: Metadata = { title: "Contest" };

const TD = "px-3 py-2";

/**
 * One contest: its window, its pinned problems and the way to publish it.
 *
 * The pinned revision is shown per problem, and a problem that has since
 * moved on is marked — a contest deliberately keeps asking what it asked,
 * and this page makes that visible rather than leaving a surprise.
 */
export default async function AdminContestPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageRole("ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  const contest = await getAdminContest(id);
  if (!contest) notFound();

  const draft = contest.status === "DRAFT";

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text">{contest.title}</h1>
          <p className="mt-2 text-text-secondary">
            <span className="font-mono">{contest.slug}</span> · {KIND_LABEL[contest.kind]} ·{" "}
            {contest.isRated ? "rated" : "unrated"} ·{" "}
            {contest.visibility === "PUBLIC" ? "whole college" : "cohort"}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            <Link className="text-primary underline-offset-2 hover:underline" href="/admin/contests">
              Back to contests
            </Link>
            {!draft ? (
              <>
                {" · "}
                <Link className="text-primary underline-offset-2 hover:underline" href={`/contests/${contest.slug}`}>
                  Student view
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={draft ? "warning" : contest.status === "RUNNING" ? "success" : "default"}>
            {contest.status}
          </Badge>
          {draft ? <PublishContestButton contestId={contest.id} /> : null}
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Problems"
            subtitle={
              draft
                ? "Each problem is pinned at its published revision when you add it."
                : "Fixed: a published contest's problem set never changes."
            }
          />
          <CardBody>
            {contest.problemList.length === 0 ? (
              <EmptyState compact title="No problems yet" description="Add at least one before publishing." />
            ) : (
              <div tabIndex={0} aria-label="Contest problems" className="overflow-x-auto rounded-xl border border-border">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-elevated text-text-secondary">
                    <tr>
                      <th scope="col" className={TD}>
                        Letter
                      </th>
                      <th scope="col" className={TD}>
                        Problem
                      </th>
                      <th scope="col" className={TD}>
                        Pinned revision
                      </th>
                      <th scope="col" className={TD}>
                        Points
                      </th>
                      {draft ? (
                        <th scope="col" className={TD}>
                          <span className="sr-only">Actions</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {contest.problemList.map((p) => (
                      <tr key={p.id} className="border-t border-border">
                        <td className={`${TD} font-mono font-semibold`}>{p.index}</td>
                        <td className={TD}>
                          <Link
                            className="text-primary underline-offset-2 hover:underline"
                            href={`/problems/${p.problemSlug}`}
                          >
                            {p.problemTitle}
                          </Link>
                        </td>
                        <td className={TD}>
                          <span className="font-mono tabular-nums">r{p.revision}</span>
                          {p.supersededByLive ? (
                            <span className="ml-2 text-xs text-text-secondary">
                              (the problem has a newer revision; this contest keeps r{p.revision})
                            </span>
                          ) : null}
                        </td>
                        <td className={`${TD} font-mono tabular-nums`}>{p.points}</td>
                        {draft ? (
                          <td className={TD}>
                            <RemoveProblemButton contestProblemId={p.id} index={p.index} />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {draft ? <AddProblemForm contestId={contest.id} kind={contest.kind} /> : null}
          </CardBody>
        </Card>

        <aside className="space-y-4">
          <Card>
            <CardHeader title="Window" />
            <CardBody>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-text-secondary">Starts</dt>
                  <dd className="text-text">{formatCampusDateTime(contest.startsAt)}</dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Ends</dt>
                  <dd className="text-text">{formatCampusDateTime(contest.endsAt)}</dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Length</dt>
                  <dd className="text-text">
                    {formatDuration(Math.round((contest.endsAt.getTime() - contest.startsAt.getTime()) / 60_000))}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Freeze</dt>
                  <dd className="text-text">
                    {contest.freezes
                      ? `Last ${contest.freezeMinutes} minutes`
                      : contest.freezeMinutes === 0
                        ? "None"
                        : "None — the contest is under 90 minutes"}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="State" />
            <CardBody>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-text-secondary">Registered</dt>
                  <dd className="font-mono tabular-nums text-text">{contest.registrations}</dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Rating</dt>
                  <dd className="text-text">
                    {contest.ratingComputedAt
                      ? `Released ${formatCampusDateTime(contest.ratingComputedAt)} for ${contest.ratedParticipants} participants`
                      : contest.isRated
                        ? "Not released yet"
                        : "Unrated"}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Standings version</dt>
                  <dd className="font-mono tabular-nums text-text">{contest.standingsVersion}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}
