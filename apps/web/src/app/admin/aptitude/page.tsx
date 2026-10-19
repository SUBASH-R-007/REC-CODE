import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { Badge, Button, ButtonLink, EmptyState } from "@recx/design";
import { APTITUDE_AREA_LABEL, type AptitudeArea, type AptitudeTopic } from "@recx/shared";
import { requirePageRole } from "@/lib/auth/guards";
import {
  APTITUDE_FILTER_OPTIONS,
  listAptitudeQuestions,
  publishedPoolByTopic,
} from "@/server/queries/admin-aptitude";
import { AdminPageHeader, TBODY_ROW, TD, TH, THEAD_ROW, TableFrame, formatDateTime } from "@/components/admin/admin-ui";

export const metadata: Metadata = { title: "Aptitude bank" };

type SearchParams = Promise<{
  area?: string | string[];
  topic?: string | string[];
  status?: string | string[];
  q?: string | string[];
  page?: string | string[];
}>;

const one = (value: string | string[] | undefined): string | undefined =>
  (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

/**
 * `/admin/aptitude` — the question bank (Phase 7d).
 *
 * PAGED at 50, never a full render. SPEC §7: "Do not render 5,000 DOM rows.
 * Virtualise." The bank is sized at ~2,000 questions, and the sibling this
 * copies (`/admin/problems`) already settled the shape.
 *
 * Reads go through `server/queries/admin-aptitude.ts`, because an `/admin`
 * page may not import `@/lib/db` at all (`tests/repo/admin-scope.test.ts`
 * R9). The list carries no worked explanations: 50 rows is 50 rows, not 50
 * essays, and the one page that shows a key shows one question.
 *
 * The pool table under the list is the thing an author actually needs before
 * publishing a pattern — how many PUBLISHED questions each topic has — so
 * `BlueprintUnfillable` is something they see coming rather than something a
 * candidate discovers mid-sitting.
 */
export default async function AdminAptitudePage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageRole("ADMIN", "SUPER_ADMIN");
  const params = await searchParams;

  const area = one(params.area);
  const topic = one(params.topic);
  const status = one(params.status);
  const list = await listAptitudeQuestions({
    ...(area && APTITUDE_FILTER_OPTIONS.areas.includes(area as AptitudeArea) ? { area: area as AptitudeArea } : {}),
    ...(topic && APTITUDE_FILTER_OPTIONS.topics.some((t) => t.topic === topic)
      ? { topic: topic as AptitudeTopic }
      : {}),
    ...(status && (APTITUDE_FILTER_OPTIONS.statuses as readonly string[]).includes(status)
      ? { status: status as "DRAFT" }
      : {}),
    ...(one(params.q) ? { q: one(params.q)! } : {}),
    page: Number(one(params.page) ?? "1") || 1,
  });
  const pool = await publishedPoolByTopic();

  const link = (next: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ area, topic, status, q: one(params.q), ...next })) {
      if (value) query.set(key, value);
    }
    const qs = query.toString();
    return qs.length > 0 ? `/admin/aptitude?${qs}` : "/admin/aptitude";
  };

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Aptitude bank"
        description={`${list.total} question${list.total === 1 ? "" : "s"}. A published question's wording is frozen — students have already been scored on it — so a wrong question is retired and replaced, never rewritten.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/admin/aptitude/new" size="sm">
              New question
            </ButtonLink>
            <ButtonLink href="/admin/aptitude/import" size="sm" variant="secondary">
              Import a CSV
            </ButtonLink>
            {/* A plain anchor, not a Link: this is a download, and the route
                answers with Content-Disposition: attachment so a browser
                never renders an answer key inline. */}
            <a
              href="/api/admin/aptitude/export"
              download
              className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium"
            >
              Export the bank
            </a>
          </div>
        }
      />

      <form className="flex flex-wrap items-end gap-3" method="get" action="/admin/aptitude">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-secondary">Search</span>
          <input
            type="search"
            name="q"
            defaultValue={one(params.q) ?? ""}
            placeholder="A code or words from the question"
            className="h-9 w-64 rounded-md border border-border bg-surface px-3 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-secondary">Area</span>
          <select name="area" defaultValue={area ?? ""} className="h-9 rounded-md border border-border bg-surface px-2 text-sm">
            <option value="">Every area</option>
            {APTITUDE_FILTER_OPTIONS.areas.map((value) => (
              <option key={value} value={value}>
                {APTITUDE_AREA_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-secondary">Topic</span>
          <select name="topic" defaultValue={topic ?? ""} className="h-9 rounded-md border border-border bg-surface px-2 text-sm">
            <option value="">Every topic</option>
            {APTITUDE_FILTER_OPTIONS.topics.map((entry) => (
              <option key={entry.topic} value={entry.topic}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-secondary">Status</span>
          <select name="status" defaultValue={status ?? ""} className="h-9 rounded-md border border-border bg-surface px-2 text-sm">
            <option value="">Every status</option>
            {APTITUDE_FILTER_OPTIONS.statuses.map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase().replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" variant="secondary">
          Filter
        </Button>
      </form>

      {list.rows.length === 0 ? (
        <EmptyState
          icon={<ListChecks aria-hidden="true" />}
          title="No questions match"
          description="Nothing in the bank matches those filters yet. Import a CSV exported from the LMS question bank, or write one here."
        />
      ) : (
        <TableFrame label="Aptitude questions">
          <thead>
            <tr className={THEAD_ROW}>
              <th className={TH}>Code</th>
              <th className={TH}>Topic</th>
              <th className={TH}>Kind</th>
              <th className={TH}>Status</th>
              <th className={TH}>Working</th>
              <th className={TH}>Served</th>
              <th className={TH}>Accuracy</th>
              <th className={TH}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((row) => (
              <tr key={row.id} className={TBODY_ROW}>
                <td className={TD}>
                  <Link href={`/admin/aptitude/${row.id}`} className="font-medium text-primary underline">
                    {row.displayCode}
                  </Link>
                </td>
                <td className={TD}>
                  <div>{row.topicLabel}</div>
                  <div className="text-xs text-muted">{APTITUDE_AREA_LABEL[row.area]}</div>
                </td>
                <td className={TD}>{row.kind.toLowerCase().replaceAll("_", " ")}</td>
                <td className={TD}>
                  <Badge tone={row.status === "PUBLISHED" ? "success" : row.status === "RETIRED" ? "default" : "info"}>
                    {row.status.toLowerCase().replace("_", " ")}
                  </Badge>
                </td>
                <td className={TD}>
                  {/* The explanation is mandatory at publish, so a draft with
                      none is a draft that cannot be published yet. */}
                  {row.hasExplanation ? (
                    <span className="text-text-secondary">Written</span>
                  ) : (
                    <span className="text-warning">Missing</span>
                  )}
                </td>
                <td className={TD}>{row.timesServed}</td>
                <td className={TD}>
                  {row.accuracyPercent === null ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <span>{row.accuracyPercent}%</span>
                  )}
                </td>
                <td className={TD}>{formatDateTime(row.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}

      {list.pageCount > 1 ? (
        <nav className="flex items-center gap-3 text-sm" aria-label="Pages">
          {list.page > 1 ? (
            <Link href={link({ page: String(list.page - 1) })} className="text-primary underline">
              Previous
            </Link>
          ) : null}
          <span className="text-text-secondary">
            Page {list.page} of {list.pageCount}
          </span>
          {list.page < list.pageCount ? (
            <Link href={link({ page: String(list.page + 1) })} className="text-primary underline">
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Published questions by topic</h2>
        <p className="text-sm text-text-secondary">
          A mock pattern draws from these. A section whose blueprint asks for more than a topic has cannot be prepared,
          and a candidate is told it is not their problem — so check here before publishing a pattern.
        </p>
        <TableFrame label="Published pool by topic">
          <thead>
            <tr className={THEAD_ROW}>
              <th className={TH}>Topic</th>
              <th className={TH}>Published</th>
            </tr>
          </thead>
          <tbody>
            {pool.map((entry) => (
              <tr key={entry.topic} className={TBODY_ROW}>
                <td className={TD}>{entry.label}</td>
                <td className={TD}>
                  {entry.count === 0 ? <span className="text-warning">None</span> : entry.count}
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </section>
    </div>
  );
}
