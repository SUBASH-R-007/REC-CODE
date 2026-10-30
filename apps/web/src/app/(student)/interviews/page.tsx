import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Briefcase, CheckCircle2, Clock, XCircle } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import {
  INTERVIEW_MODE_LABEL,
  INTERVIEW_OUTCOME_LABEL,
  INTERVIEW_PREPARATION_LABEL,
  INTERVIEW_ROUND_LABEL,
  TOPIC_LABEL,
  formatCampusTime,
} from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { loadArchive } from "@/server/queries/interviews";
import { ShareExperience } from "@/components/interviews/share-experience";

export const metadata: Metadata = { title: "Interviews" };

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9-]+$/);

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `/interviews` — what students were actually asked (Phase 12e).
 *
 * SPEC §11 calls this archive "the only legal and genuinely REC-specific
 * source of company tags and 'asked at' frequency, and therefore
 * load-bearing rather than a nicety". Two consequences are visible on this
 * page and worth knowing before changing it.
 *
 * **There is no prose anywhere.** Every field is a closed list or a
 * number, except the company and the role. That is not a missing feature:
 * an account of an interview written in a hurry names interviewers,
 * repeats questions under an NDA, and says things about a company the
 * college would have to answer for. And prose cannot be counted, which is
 * what the archive is for.
 *
 * **Nobody's name appears.** The author is stored and shown to moderators
 * only; students see "A CSE student, batch of 2026". A rejection with a
 * name on it is a thing students do not post, and an archive nobody posts
 * to is worth nothing.
 */
export default async function InterviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string | string[] }>;
}) {
  const user = await requireUser();
  const raw = (await searchParams).company;
  const parsed = slugSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  const company = parsed.success ? parsed.data : null;

  const [archive, problems] = await Promise.all([
    loadArchive(user.id, company),
    db.problem.findMany({
      where: { status: "PUBLISHED" },
      orderBy: { displayCode: "asc" },
      take: 300,
      select: { id: true, displayCode: true, title: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Interviews</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          What companies actually asked, reported by students here and checked by a TA before it appears. Nobody&apos;s
          name is shown. Everything is a field rather than a story — partly so it can be counted into the
          &ldquo;asked at&rdquo; tags on the problem catalogue, and partly because an account written in a hurry says
          things about a company that none of us should be publishing.
        </p>
      </header>

      <ShareExperience problems={problems} />

      {archive.mine.length > 0 && (
        <Card>
          <CardHeader title="Yours" subtitle="Submissions you have made, and what happened to them." />
          <CardBody>
            <ul className="space-y-2 text-sm">
              {archive.mine.map((row) => (
                <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0">
                  <span className="min-w-0">
                    <span className="font-medium">{row.company}</span>{" "}
                    <span className="text-xs text-muted">{formatCampusTime(row.createdAt)}</span>
                    {row.decisionReason ? <span className="block text-text-secondary">{row.decisionReason}</span> : null}
                  </span>
                  <StatusBadge status={row.status} />
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {archive.companies.length > 0 && (
        <nav aria-label="Filter by company" className="flex flex-wrap gap-2">
          <Link
            href="/interviews"
            className={`rounded-full border px-3 py-1 text-sm ${company === null ? "border-primary bg-primary-subtle text-primary" : "border-border text-text-secondary hover:text-text"}`}
          >
            Everything
          </Link>
          {archive.companies.map((entry) => (
            <Link
              key={entry.slug}
              href={`/interviews?company=${entry.slug}`}
              className={`rounded-full border px-3 py-1 text-sm ${company === entry.slug ? "border-primary bg-primary-subtle text-primary" : "border-border text-text-secondary hover:text-text"}`}
            >
              {entry.name} <span className="text-muted">{entry.count}</span>
            </Link>
          ))}
        </nav>
      )}

      {archive.experiences.length === 0 ? (
        <EmptyState
          icon={<Briefcase className="h-6 w-6" />}
          title="Nothing here yet"
          description="Until students report interviews, the company tracks on the problem catalogue are the placement cell's own curation — and they say so. If you have sat one, add it above."
        />
      ) : (
        <ol className="space-y-4">
          {archive.experiences.map((entry) => (
            <li key={entry.id}>
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="font-display text-base font-semibold">
                      {entry.company} · <span className="font-normal text-text-secondary">{entry.role}</span>
                    </h2>
                    <span className="text-xs text-muted">
                      {MONTHS[entry.heldMonth]} {entry.heldYear} · {INTERVIEW_MODE_LABEL[entry.mode]}
                    </span>
                  </div>
                  <p className="text-xs text-muted">{entry.by}</p>

                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="inline font-medium">Rounds </dt>
                      <dd className="inline">
                        {entry.rounds}
                        {entry.longestRoundMinutes ? ` · longest ${entry.longestRoundMinutes} min` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-medium">Outcome </dt>
                      <dd className="inline">{INTERVIEW_OUTCOME_LABEL[entry.outcome]}</dd>
                    </div>
                  </dl>

                  <Chips label="What the rounds were" items={entry.roundKinds.map((k) => INTERVIEW_ROUND_LABEL[k])} />
                  <Chips label="Topics they asked about" items={entry.topics.map((t) => TOPIC_LABEL[t])} />
                  <Chips label="What helped" items={entry.preparation.map((p) => INTERVIEW_PREPARATION_LABEL[p])} />

                  {entry.problems.length > 0 && (
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted">Problems they recognised</p>
                      <ul className="mt-1 flex flex-wrap gap-2">
                        {entry.problems.map((problem) => (
                          <li key={problem.slug}>
                            <Link
                              href={`/problems/${problem.slug}`}
                              className="rounded-full border border-border px-3 py-1 text-sm hover:border-primary hover:text-primary"
                            >
                              <span className="font-mono text-xs text-muted">{problem.displayCode}</span> {problem.title}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardBody>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li key={item}>
            <Badge>{item}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: "PENDING" | "APPROVED" | "REJECTED" }) {
  if (status === "APPROVED") {
    return (
      <Badge tone="success">
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        Published
      </Badge>
    );
  }
  if (status === "REJECTED") {
    return (
      <Badge tone="danger">
        <XCircle className="h-3 w-3" aria-hidden />
        Not published
      </Badge>
    );
  }
  return (
    <Badge>
      <Clock className="h-3 w-3" aria-hidden />
      Waiting for a TA
    </Badge>
  );
}
