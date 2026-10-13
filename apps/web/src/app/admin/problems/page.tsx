import type { Metadata } from "next";
import Link from "next/link";
import { FilePlus2, Upload } from "lucide-react";
import { ButtonLink, Card, DifficultyBadge, EmptyState, Input, Select } from "@recx/design";
import { REVIEW_STAGE_LABEL, REVIEW_STAGES } from "@recx/shared/authoring";
import { requirePageRole } from "@/lib/auth/guards";
import { listAdminProblems, parseStage } from "@/server/queries/admin-problems";
import { StageBadge } from "@/components/admin/problems/stage-badge";

export const metadata: Metadata = { title: "Problems" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/**
 * Problem authoring: every problem with its live revision and open draft,
 * filterable by review stage (the review queue), title and difficulty.
 */
export default async function AdminProblemsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");
  const params = await searchParams;
  const stage = parseStage(first(params.stage));
  const q = first(params.q).slice(0, 100);
  const rawDifficulty = first(params.difficulty);
  const difficulty = rawDifficulty === "EASY" || rawDifficulty === "MEDIUM" || rawDifficulty === "HARD" ? rawDifficulty : null;
  const page = Number(first(params.page)) || 1;
  const list = await listAdminProblems({ id: user.id, role: user.role }, { stage, q, difficulty, page });
  const pageHref = (n: number) => {
    const sp = new URLSearchParams();
    if (stage) sp.set("stage", stage);
    if (q) sp.set("q", q);
    if (difficulty) sp.set("difficulty", difficulty);
    sp.set("page", String(n));
    return `/admin/problems?${sp.toString()}`;
  };
  const queue = [
    { stage: "DRAFT", label: "Drafts", count: list.queue.draft },
    { stage: "IN_REVIEW", label: "Waiting for review", count: list.queue.inReview },
    { stage: "APPROVED", label: "Approved, not published", count: list.queue.approved },
    { stage: "PUBLISHED", label: "Published", count: list.queue.published },
    { stage: "RETIRED", label: "Retired", count: list.queue.retired },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Problems</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Author, review, validate and publish. Every revision is reviewed by a second admin before students see it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/admin/problems/import" variant="outline">
            <Upload className="h-4 w-4" aria-hidden />
            Import
          </ButtonLink>
          <ButtonLink href="/admin/problems/new">
            <FilePlus2 className="h-4 w-4" aria-hidden />
            New problem
          </ButtonLink>
        </div>
      </div>

      <nav aria-label="Review queue">
        <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {queue.map((item) => (
            <li key={item.stage}>
              <Link
                href={`/admin/problems?stage=${item.stage}`}
                aria-current={stage === item.stage ? "page" : undefined}
                className="block rounded-2xl border border-border bg-surface p-4 shadow-card hover:border-primary/40"
              >
                <span className="block text-xs font-medium uppercase tracking-wide text-muted">{item.label}</span>
                <span className="mt-1 block font-display text-2xl font-bold tabular-nums">{item.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <form method="get" className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end" role="search" aria-label="Filter problems">
        <div>
          <label htmlFor="problems-q" className="mb-1.5 block text-sm font-medium text-text">
            Search
          </label>
          <Input id="problems-q" name="q" defaultValue={q} placeholder="Title, slug or REC code" maxLength={100} />
        </div>
        <div>
          <label htmlFor="problems-stage" className="mb-1.5 block text-sm font-medium text-text">
            Stage
          </label>
          <Select id="problems-stage" name="stage" defaultValue={stage ?? ""}>
            <option value="">Any stage</option>
            {REVIEW_STAGES.filter((s) => s !== "SUPERSEDED").map((s) => (
              <option key={s} value={s}>
                {REVIEW_STAGE_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="problems-difficulty" className="mb-1.5 block text-sm font-medium text-text">
            Difficulty
          </label>
          <Select id="problems-difficulty" name="difficulty" defaultValue={difficulty ?? ""}>
            <option value="">Any difficulty</option>
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </Select>
        </div>
        <button
          type="submit"
          className="h-10 rounded-xl border border-border-strong bg-surface px-4 text-sm font-medium text-text hover:bg-primary-subtle"
        >
          Filter
        </button>
      </form>

      {list.rows.length === 0 ? (
        <EmptyState title="No problems match" description="Change the filters, create a problem, or import a package." />
      ) : (
        <Card className="p-0">
          <div tabIndex={0} aria-label="Problems" className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <caption className="sr-only">
                Problems, page {list.page} of {list.pageCount} ({list.total} in all)
              </caption>
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Problem
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Difficulty
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Live
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Open revision
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <Link href={`/admin/problems/${p.id}`} className="font-medium text-text hover:text-primary hover:underline">
                        {p.title}
                      </Link>
                      <div className="font-mono text-xs text-muted">
                        {p.displayCode} · {p.slug}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <DifficultyBadge difficulty={p.difficulty} />
                    </td>
                    <td className="px-4 py-3">
                      {p.status === "RETIRED" ? (
                        <StageBadge stage="RETIRED" />
                      ) : p.liveRevision !== null ? (
                        <span className="tabular-nums">Revision {p.liveRevision}</span>
                      ) : (
                        <span className="text-muted">Not published</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {p.open ? (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span className="tabular-nums">r{p.open.revision}</span>
                          <StageBadge stage={p.open.stage} />
                        </span>
                      ) : (
                        <span className="text-muted">None</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{DATE.format(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {list.pageCount > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between text-sm">
          {list.page > 1 ? <Link href={pageHref(list.page - 1)}>← Previous</Link> : <span />}
          <span className="text-text-secondary tabular-nums">
            Page {list.page} of {list.pageCount}
          </span>
          {list.page < list.pageCount ? <Link href={pageHref(list.page + 1)}>Next →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
