import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { publicName } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { formatCampusDateTime } from "@/lib/help/copy";
import { KIND_LABEL, contestHref } from "@/components/contests/model";
import { getStandings, type StandingRow } from "@/server/queries/contests";

export const metadata: Metadata = { title: "Standings" };

const TD = "px-3 py-2";

function Row({ row, kind, self }: { row: StandingRow; kind: "ICPC" | "SUBTASK"; self: boolean }) {
  return (
    <tr className={self ? "border-t border-border bg-primary-subtle" : "border-t border-border"}>
      <td className={`${TD} font-mono tabular-nums`}>{row.rank ?? "—"}</td>
      <td className={TD}>
        <Link className="text-primary underline-offset-2 hover:underline" href={`/u/${row.handle}`}>
          {publicName(row.firstName, row.lastName)}
        </Link>
        {self ? <span className="ml-2 text-xs text-primary">you</span> : null}
      </td>
      <td className={`${TD} font-mono tabular-nums`}>{row.score}</td>
      {kind === "ICPC" ? <td className={`${TD} font-mono tabular-nums`}>{row.penalty}</td> : null}
      <td className={`${TD} font-mono tabular-nums`}>{row.solved}</td>
    </tr>
  );
}

/**
 * Live standings (Phase 5).
 *
 * The freeze is applied in the query, in one place: during the last stretch
 * of a long contest a student sees the board as it was when it froze, and
 * their own row live beside it. Staff see it live throughout — they need the
 * real picture to run the contest. A virtual run never joins this board.
 */
export default async function StandingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser();
  const view = await getStandings(slug, user);
  if (!view) notFound();

  const ownShownSeparately = view.frozen && view.own !== null && !view.rows.some((r) => r.self);

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text">{view.title}</h1>
          <p className="mt-2 text-text-secondary">
            Standings · {KIND_LABEL[view.kind]}
            {" · "}
            <Link className="text-primary underline-offset-2 hover:underline" href={contestHref(slug)}>
              contest page
            </Link>
          </p>
        </div>
        {view.frozen ? <Badge tone="warning">Frozen</Badge> : null}
      </header>

      {view.frozen ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-text">
          The standings are frozen for the final stretch of this contest. Everyone else&apos;s rows are shown as they
          were when the freeze began{view.freezesAt ? ` (${formatCampusDateTime(view.freezesAt)})` : ""}. Your own row
          is live.
        </p>
      ) : null}

      {ownShownSeparately && view.own ? (
        <Card className="mt-6">
          <CardHeader title="Your row" subtitle="Live, even while the board is frozen." />
          <CardBody>
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-text-secondary">Rank</dt>
                <dd className="font-mono tabular-nums text-text">{view.own.rank ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Score</dt>
                <dd className="font-mono tabular-nums text-text">{view.own.score}</dd>
              </div>
              {view.kind === "ICPC" ? (
                <div>
                  <dt className="text-text-secondary">Penalty</dt>
                  <dd className="font-mono tabular-nums text-text">{view.own.penalty}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-text-secondary">Solved</dt>
                <dd className="font-mono tabular-nums text-text">{view.own.solved}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      ) : null}

      {view.rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="Nobody on the board yet"
            description="The first accepted submission puts someone here."
          />
        </div>
      ) : (
        <div tabIndex={0} aria-label="Standings" className="mt-6 overflow-x-auto rounded-xl border border-border">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">
              {view.title} standings{view.frozen ? ", frozen for the final stretch" : ""}
            </caption>
            <thead className="bg-elevated text-text-secondary">
              <tr>
                <th scope="col" className={TD}>
                  Rank
                </th>
                <th scope="col" className={TD}>
                  Student
                </th>
                <th scope="col" className={TD}>
                  {view.kind === "ICPC" ? "Solved" : "Score"}
                </th>
                {view.kind === "ICPC" ? (
                  <th scope="col" className={TD}>
                    Penalty
                  </th>
                ) : null}
                <th scope="col" className={TD}>
                  Problems
                </th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <Row key={row.userId} row={row} kind={view.kind} self={row.self} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
