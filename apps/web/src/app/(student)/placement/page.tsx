import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody } from "@recx/design";
import {
  MIN_PERCENTILE_COHORT,
  READINESS_CALIBRATION_NOTE,
  READINESS_EMPTY_STATES,
  READINESS_FRAMING,
  READINESS_WILL_COUNT,
  TOPIC_LABEL,
  TOPICS,
  formatCampusDay,
} from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { headlineAction, myReadiness } from "@/server/queries/placement";
import { TierCard } from "@/components/placement/tier-card";

export const metadata: Metadata = { title: "Placement readiness" };

/**
 * `/placement` — how much of the preparation you have covered (Phase 9c).
 *
 * SPEC §5 makes the framing MANDATORY, and it is the first thing in DOM
 * order rather than a footnote: a student who reads this number as a
 * prediction will either coast on a high one or give up on a low one, and
 * both are worse outcomes than not showing it at all. `READINESS_FRAMING` is
 * a constant so a copy test can assert it is here and a redesign cannot trim
 * it.
 *
 * Three things this page must never do, each of which a fence enforces:
 *
 *   1. Show a band, an "integrity score", or a flag count. There is none
 *      here and none is queryable from the student's own readiness.
 *   2. Show a bare score. Every figure carries the weight that was
 *      measurable, because `mockInterviewScore` has no source in this plan
 *      and a TOP score is a score out of 85.
 *   3. Show a zero where it means "not measured". The database refuses to
 *      store that pair, and the card renders the sentence instead.
 *
 * Server-rendered, no client JavaScript: it is in `size-budgets.json`'s
 * `serverRendered` list.
 */
export default async function PlacementPage() {
  const user = await requireUser();
  const readiness = await myReadiness(user.id);
  const headline = headlineAction(readiness);

  return (
    <div className="space-y-8">
      {/* The framing first, in DOM order, before any number. */}
      <header className="space-y-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">Placement readiness</h1>
        <p className="max-w-2xl text-sm">{READINESS_FRAMING}</p>
      </header>

      {readiness.kind === "EXCLUDED" ? (
        <section className="space-y-3 rounded-xl border border-border p-5">
          <h2 className="font-display text-lg font-semibold">{READINESS_EMPTY_STATES.EXCLUDED.heading}</h2>
          <p className="max-w-2xl text-sm text-text-secondary">{READINESS_EMPTY_STATES.EXCLUDED.body}</p>
          <p className="text-sm">
            <Link href="/profile" className="text-primary underline">
              {READINESS_EMPTY_STATES.EXCLUDED.cta}
            </Link>
          </p>
        </section>
      ) : null}

      {readiness.kind === "NONE" ? (
        <section className="space-y-4 rounded-xl border border-border p-5">
          <h2 className="font-display text-lg font-semibold">{READINESS_EMPTY_STATES.NONE.heading}</h2>
          <p className="max-w-2xl text-sm text-text-secondary">{READINESS_EMPTY_STATES.NONE.body}</p>
          <div className="space-y-2">
            {/* What it will be computed FROM. Never a zero in the meantime. */}
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              What it will be worked out from
            </h3>
            <ul className="max-w-2xl space-y-1.5 text-sm">
              {READINESS_WILL_COUNT.map((line) => (
                <li key={line} className="flex gap-2">
                  <span aria-hidden="true" className="text-muted">
                    ·
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-sm">
            <Link href="/problems" className="text-primary underline">
              {READINESS_EMPTY_STATES.NONE.cta}
            </Link>
          </p>
        </section>
      ) : null}

      {readiness.kind === "READY" ? (
        <>
          {headline ? (
            <Card>
              <CardBody className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  The most useful thing you could do next
                </h2>
                {/*
                  SPEC §5's literal format: "+9 points available: graphs, 6
                  unassisted mediums". The points figure is what makes it a
                  decision rather than a nag — and the gap lists below are
                  ranked by the same figure, so the headline and the lists
                  cannot disagree.
                */}
                <p className="font-display text-lg font-semibold">{headline.action.sentence}</p>
                <p className="text-sm text-text-secondary">
                  Towards {headline.tier.label}. Nothing here is a deadline — it is simply where the next hour buys
                  you the most.
                </p>
                <p className="text-sm">
                  <Link href="/problems" className="text-primary underline">
                    Find a problem for this
                  </Link>
                </p>
              </CardBody>
            </Card>
          ) : null}

          {readiness.stale ? (
            <p className="rounded-lg border border-warning/25 bg-warning-subtle p-3 text-sm">
              These figures were worked out on {formatCampusDay(readiness.computedOn)} and have not been updated
              since. Anything you have done after that day is not in them yet.
            </p>
          ) : (
            <p className="text-xs text-muted">
              Worked out on {formatCampusDay(readiness.computedOn)}, from everything up to that day.
            </p>
          )}

          <div className="grid gap-5 lg:grid-cols-3">
            {readiness.tiers.map((tier) => (
              <TierCard key={tier.tier} tier={tier} />
            ))}
          </div>

          <section className="space-y-3">
            <h2 className="font-display text-lg font-semibold">Breadth, topic by topic</h2>
            <p className="max-w-2xl text-sm text-text-secondary">
              Breadth is the LOWEST of these fourteen, not the average. That is deliberate: 200 array problems and no
              graphs looks strong on an average and fails a real interview on the first graph question. These count
              only solves you reached without a hint or an editorial.
            </p>
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {TOPICS.map((topic) => (
                <li
                  key={topic}
                  className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 text-sm"
                >
                  <span>{TOPIC_LABEL[topic]}</span>
                  <span className="tabular-nums text-text-secondary">{readiness.topicUnassisted[topic] ?? 0}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm">
              <Link href="/profile" className="text-primary underline">
                See the same topics on your skill radar
              </Link>
            </p>
          </section>

          <section className="space-y-2 border-t border-border pt-5 text-xs text-muted">
            <p className="max-w-2xl">{READINESS_CALIBRATION_NOTE}</p>
            <p className="max-w-2xl">
              {readiness.cohortRankable
                ? `The aptitude, verbal and rating parts compare you with the ${readiness.cohortSize} students in your batch.`
                : `Your batch has ${readiness.cohortSize} students on the platform, which is fewer than the ${MIN_PERCENTILE_COHORT} needed to compare anybody without effectively naming them — so those parts are shown as not measured rather than ranked.`}
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
