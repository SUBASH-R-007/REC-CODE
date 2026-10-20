import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { ArenaClock } from "@/components/contests/arena-clock";
import { ArenaNarrowBlock } from "@/components/contests/narrow-block";
import { contestHref } from "@/components/contests/model";
import { getContest } from "@/server/queries/contests";

export const metadata: Metadata = { title: "Arena" };

/**
 * The contest arena (Phase 5).
 *
 * Three refusals, in this order:
 *   - a contest this student cannot see is a 404 (the query decides);
 *   - a student who never entered is sent to the landing page, where they
 *     can register — the arena is not a way in;
 *   - a run whose clock has not started, or has run out, goes back to the
 *     landing page too.
 *
 * Below 768 px the arena is replaced by an explanation, not a narrow
 * version of itself (§7). Both halves are in the markup and chosen by CSS.
 */
export default async function ArenaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const { p } = await searchParams;
  const user = await requireUser();
  const contest = await getContest(slug, user);
  if (!contest) notFound();
  if (contest.registeredAs === null) redirect(contestHref(slug));

  const now = new Date();
  if (now < contest.window.startsAt || now >= contest.window.endsAt) redirect(contestHref(slug));

  const selected =
    (typeof p === "string" ? contest.problems.find((problem) => problem.index === p) : undefined) ??
    contest.problems[0];

  return (
    <>
      <ArenaNarrowBlock slug={slug} title={contest.title} />

      <div className="hidden md:block">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-3 sm:px-6 lg:px-8">
          <div className="min-w-0">
            <h1 className="truncate font-display text-lg font-bold tracking-tight text-text">{contest.title}</h1>
            <p className="text-sm text-text-secondary">
              {contest.registeredAs === "VIRTUAL" ? "Virtual run · unrated" : contest.isRated ? "Rated" : "Unrated"}
              {" · "}
              <Link className="text-primary underline-offset-2 hover:underline" href={contestHref(slug, "standings")}>
                standings
              </Link>
            </p>
          </div>
          <ArenaClock endsAtIso={contest.window.endsAt.toISOString()} />
        </header>

        <nav aria-label="Contest problems" className="border-b border-border px-4 py-2 sm:px-6 lg:px-8">
          <ul className="flex flex-wrap gap-2">
            {contest.problems.map((problem) => {
              const active = problem.index === selected?.index;
              return (
                <li key={problem.id}>
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={
                      active
                        ? "inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg"
                        : "inline-flex items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm text-text hover:bg-elevated"
                    }
                    href={`${contestHref(slug, "arena")}?p=${encodeURIComponent(problem.index)}`}
                  >
                    <span className="font-mono font-semibold">{problem.index}</span>
                    <span className="max-w-[12rem] truncate">{problem.title}</span>
                    {problem.own?.solved ? <Badge tone="success">✓</Badge> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="px-4 py-6 sm:px-6 lg:px-8">
          {selected ? (
            <section aria-labelledby="arena-problem-heading">
              <h2 id="arena-problem-heading" className="font-display text-base font-semibold tracking-tight text-text">
                {selected.index}. {selected.title}
              </h2>
              <p className="mt-2 text-sm text-text-secondary">
                {contest.kind === "SUBTASK" ? `Worth ${selected.points} points.` : "Worth one point."}
                {selected.own?.solved
                  ? " You have solved this."
                  : selected.own && selected.own.wrongAttempts > 0
                    ? ` ${selected.own.wrongAttempts} rejected submission${selected.own.wrongAttempts === 1 ? "" : "s"} so far.`
                    : ""}
              </p>
              <p className="mt-6">
                <Link
                  className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover"
                  href={`/problems/${selected.slug}`}
                >
                  Open the workspace
                </Link>
              </p>
              <p className="mt-3 text-xs text-text-secondary">
                The workspace is the same editor you practise in. Submissions you make while this contest is running
                count towards it.
              </p>
            </section>
          ) : (
            <p className="text-sm text-text-secondary">This contest has no problems yet.</p>
          )}
        </div>
      </div>
    </>
  );
}
