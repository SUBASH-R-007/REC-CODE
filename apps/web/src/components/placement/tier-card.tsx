import { Badge, Card, CardBody, CardHeader, ProgressBar } from "@recx/design";
import { MISSING_REASON_COPY, TOPIC_LABEL, type ComponentBreakdown } from "@recx/shared";
import type { TierView } from "@/server/queries/readiness";

/**
 * One readiness tier, as a student reads it (Phase 9c).
 *
 * Every number on this card carries its denominator. That is the single
 * design rule here and it is not a style preference: `mockInterviewScore` is
 * 15 % of TOP and has no source in this plan at any phase, so a TOP score is
 * a score out of 85. A bare "62" would read as 62 out of 100 and make a
 * student believe they are further behind than they are — and the weights are
 * NOT renormalised to hide it, because renormalising would make somebody who
 * has never done a mock interview look exactly as ready as somebody who has
 * done five.
 *
 * No client JavaScript: this is a server component and the route is in
 * `size-budgets.json`'s `serverRendered` list, so a regression that pulls a
 * client component in here fails the size gate rather than quietly costing
 * every student a download.
 */

/** "0.17" is useless; "graphs — you have 1 of 4" is actionable. */
function detailOf(row: ComponentBreakdown): string | null {
  if (row.component !== "TOPIC_BREADTH" || !row.limitingTopic) return null;
  const target = row.perTopicTarget ?? 0;
  return `${TOPIC_LABEL[row.limitingTopic]} is the lowest — ${row.limitingCount ?? 0} of ${target} solved without help`;
}

function ComponentRow({ row }: { row: ComponentBreakdown }) {
  const weightPct = Math.round(row.weight * 100);
  const detail = detailOf(row);

  return (
    <li className="space-y-1.5 border-b border-border py-3 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{row.label}</span>
        {row.state.state === "PRESENT" ? (
          <span className="text-sm tabular-nums text-text-secondary">
            {/* The component's own contribution, against what it can give. */}
            {row.points.toFixed(1)} of {weightPct}
          </span>
        ) : (
          <Badge tone="default">Not measured</Badge>
        )}
      </div>

      {row.state.state === "PRESENT" ? (
        <ProgressBar
          value={row.points}
          max={weightPct}
          size="sm"
          tone={row.points >= weightPct * 0.75 ? "success" : "primary"}
          label={`${row.label}: ${row.points.toFixed(1)} out of ${weightPct} points`}
        />
      ) : (
        <p className="text-xs text-text-secondary">{MISSING_REASON_COPY[row.state.reason]}</p>
      )}

      {detail ? <p className="text-xs text-text-secondary">{detail}</p> : null}
    </li>
  );
}

export function TierCard({ tier }: { tier: TierView }) {
  const unmeasurable = tier.score === null;

  return (
    <Card className="flex flex-col">
      <CardHeader title={tier.label} subtitle={tier.examples} />
      <CardBody className="flex flex-1 flex-col gap-4">
        {unmeasurable ? (
          /**
           * Nothing in the tier could be measured. The card says that rather
           * than showing a zero — "show missing components as missing, never
           * silently as zero", which the database refuses to store any other
           * way.
           */
          <p className="text-sm text-text-secondary">
            Nothing in this tier can be measured for you yet. It is not a zero — there is simply nothing to score
            from. Start with the list below and it will fill in.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="flex items-baseline gap-1.5">
              <span className="font-display text-3xl font-bold tabular-nums">{tier.score}</span>
              <span className="text-sm text-text-secondary">
                out of {tier.availableWeight} measurable
              </span>
            </p>
            <ProgressBar
              value={tier.score ?? 0}
              max={tier.availableWeight}
              label={`${tier.label}: ${tier.score} out of ${tier.availableWeight} measurable points`}
            />
            {tier.availableWeight < 100 ? (
              <p className="text-xs text-text-secondary">
                {100 - tier.availableWeight} of the 100 points for this tier cannot be measured yet, so the most
                anybody can score here today is {tier.availableWeight}. Nothing has been redistributed to hide that.
              </p>
            ) : null}
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            What makes up this number
          </h3>
          <ul className="-my-1">
            {tier.components.map((row) => (
              <ComponentRow key={row.component} row={row} />
            ))}
          </ul>
        </div>

        {tier.gaps.length > 0 ? (
          <div className="space-y-2 rounded-xl bg-primary-subtle/40 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Where the points are
            </h3>
            <ul className="space-y-1 text-sm">
              {tier.gaps.map((row) => (
                <li key={row.component} className="flex justify-between gap-3">
                  <span>{row.label}</span>
                  <span className="shrink-0 tabular-nums text-text-secondary">
                    +{row.pointsAvailable.toFixed(1)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
