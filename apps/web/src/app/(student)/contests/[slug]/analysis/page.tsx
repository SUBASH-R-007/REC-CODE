import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { isProvisional } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { formatCampusDateTime } from "@/lib/help/copy";
import { KIND_LABEL, contestHref } from "@/components/contests/model";
import { getContest, getRatingSummary } from "@/server/queries/contests";

export const metadata: Metadata = { title: "Analysis" };

/**
 * After a contest: what this student did, and what it did to their rating.
 *
 * The editorials are the problems' own (unlocked by the normal Phase 3
 * policy), so this page links to them rather than duplicating them. A
 * provisional rating is shown with "?" and is excluded from readiness, as
 * SPEC §5 requires.
 */
export default async function AnalysisPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser();
  const contest = await getContest(slug, user);
  if (!contest) notFound();

  const rating = await getRatingSummary(user.id);
  const mine = rating.history.find((h) => h.contestSlug === slug) ?? null;
  const solved = contest.problems.filter((p) => p.own?.solved).length;

  return (
    <div>
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-text">{contest.title}</h1>
        <p className="mt-2 text-text-secondary">
          Analysis · {KIND_LABEL[contest.kind]}
          {" · "}
          <Link className="text-primary underline-offset-2 hover:underline" href={contestHref(slug, "standings")}>
            final standings
          </Link>
        </p>
      </header>

      {contest.phase !== "finished" ? (
        <p className="mt-6 rounded-xl border border-info/40 bg-info-subtle px-4 py-3 text-sm text-text">
          This contest is still running. The analysis fills in once it is over.
        </p>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Your round" subtitle={`${solved} of ${contest.problems.length} solved`} />
          <CardBody>
            {contest.problems.length === 0 ? (
              <p className="text-sm text-text-secondary">No problems to show.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {contest.problems.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="font-mono font-semibold text-text-secondary">{p.index}</span>
                      <Link
                        className="truncate text-primary underline-offset-2 hover:underline"
                        href={`/problems/${p.slug}`}
                      >
                        {p.title}
                      </Link>
                    </span>
                    <span className="shrink-0">
                      {p.own?.solved ? (
                        <Badge tone="success">Solved</Badge>
                      ) : p.own && p.own.wrongAttempts > 0 ? (
                        <span className="text-text-secondary">{p.own.wrongAttempts} rejected</span>
                      ) : (
                        <span className="text-muted">Not attempted</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Rating"
            subtitle={
              rating.provisional
                ? "Provisional — shown with a ? until five rated contests are behind it, and left out of readiness."
                : `${rating.division.replace("DIV", "Div ")}`
            }
          />
          <CardBody>
            {mine ? (
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-text-secondary">This contest</dt>
                  <dd className="text-text">
                    <span className="font-mono tabular-nums">{mine.before}</span> →{" "}
                    <span className="font-mono tabular-nums font-semibold">{mine.after}</span>{" "}
                    <span className={mine.delta >= 0 ? "text-success" : "text-danger"}>
                      ({mine.delta >= 0 ? "+" : ""}
                      {mine.delta})
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Rank</dt>
                  <dd className="font-mono tabular-nums text-text">{mine.rank}</dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Released</dt>
                  <dd className="text-text">{formatCampusDateTime(mine.at)}</dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Rating now</dt>
                  <dd className="font-mono tabular-nums text-text">
                    {rating.rating}
                    {isProvisional(rating.contestsRated) ? "?" : ""}
                  </dd>
                </div>
              </dl>
            ) : (
              <EmptyState
                compact
                title={contest.isRated ? "No rating change yet" : "Unrated contest"}
                description={
                  contest.isRated
                    ? "Ratings are released after the contest, and only when at least 30 students took part."
                    : "This contest was announced as unrated, so nobody's rating moved."
                }
              />
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
