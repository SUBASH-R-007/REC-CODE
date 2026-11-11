import { Card } from "@recx/design";
import {
  COMPLEXITY_LABEL,
  COMPLEXITY_REFUSAL_SENTENCE,
  STANDING_REFUSAL_SENTENCE,
  complexityCaveat,
  complexityEvidence,
  complexityHeadline,
  standingSentence,
  type ComplexityDetail,
  type ComplexityMetric,
  type ComplexityOutcome,
  type GrowthShare,
  type MetricStanding,
  type SolutionStanding,
  type StandingBand,
  type StandingOutcome,
} from "@recx/shared";
import { formatMemoryKb, formatTimeMs } from "@/lib/judge/view";

/**
 * "What is the complexity of this, and is it any good?" — the two questions
 * a student has after an Accepted, answered on the submission page (Phase
 * 17).
 *
 * Every line of copy here is written against one risk: that a measurement
 * reads as a fact. The preamble says what was measured and what `n` is, a
 * weak fit says so beside itself, a refusal says what the data could not
 * support instead of falling back on a guess, and nothing anywhere implies
 * that a slow solution is a worse one — Accepted is Accepted, and nothing
 * in this section touches a score, XP, a standing or an eligibility
 * decision.
 *
 * The distribution is a real `<table>` rather than a row of styled divs: a
 * bar is drawn inside each cell and marked `aria-hidden`, and the count
 * beside it is text, so a screen reader is read the actual numbers and the
 * student's own band is named in words rather than by colour alone.
 */

const METRICS: readonly { metric: ComplexityMetric; heading: string }[] = [
  { metric: "TIME", heading: "Time" },
  { metric: "SPACE", heading: "Memory" },
];

function GrowthCard({
  metric,
  heading,
  outcome,
}: {
  metric: ComplexityMetric;
  heading: string;
  outcome: ComplexityOutcome;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted">{heading}</h4>
      {outcome.fitted ? (
        <>
          {/* The symbol for the eye, the sentence for a screen reader: one
              or the other, never both, or it is read twice. */}
          <p className="mt-1 font-display text-lg font-semibold text-text">
            <span className="font-mono" aria-hidden>
              {COMPLEXITY_LABEL[outcome.growth]}
            </span>
            <span className="sr-only">{complexityHeadline(metric, outcome)}</span>
          </p>
          <p className="mt-1 text-sm text-text-secondary tabular-nums">{complexityEvidence(outcome)}</p>
          {complexityCaveat(outcome) !== null && (
            <p className="mt-1 text-sm text-text-secondary">{complexityCaveat(outcome)}</p>
          )}
        </>
      ) : (
        <p className="mt-1 text-sm text-text-secondary">{COMPLEXITY_REFUSAL_SENTENCE[outcome.reason]}</p>
      )}
    </div>
  );
}

function BandRow({
  band,
  widest,
  format,
}: {
  band: StandingBand;
  widest: number;
  format: (value: number) => string;
}) {
  const share = widest > 0 ? (band.count / widest) * 100 : 0;
  return (
    <tr className={band.mine ? "bg-primary-subtle" : undefined}>
      <th scope="row" className="py-1 pr-3 text-left font-mono text-xs font-normal whitespace-nowrap text-text-secondary">
        {band.from === band.to ? format(band.from) : `${format(band.from)} – ${format(band.to)}`}
      </th>
      <td className="w-full py-1">
        <div className="h-2 w-full overflow-hidden rounded-full bg-elevated" aria-hidden>
          <div
            className={band.mine ? "h-full rounded-full bg-primary" : "h-full rounded-full bg-border-strong"}
            style={{ width: `${share}%` }}
          />
        </div>
      </td>
      <td className="py-1 pl-3 text-right text-xs tabular-nums text-text-secondary">{band.count}</td>
      <td className="py-1 pl-2 text-xs whitespace-nowrap text-primary">{band.mine ? "yours" : ""}</td>
    </tr>
  );
}

function MetricBlock({
  heading,
  measure,
  verb,
  best,
  standing,
  languageLabel,
  format,
}: {
  heading: string;
  /**
   * What the number IS, said rather than assumed. The verdict summary higher
   * up this page shows the SLOWEST single case and the PEAK memory; these are
   * the CPU total and the same peak, and two unexplained time figures on one
   * page is how a student concludes the platform cannot count.
   */
  measure: string;
  verb: string;
  best: string;
  standing: MetricStanding;
  languageLabel: string;
  format: (value: number) => string;
}) {
  const widest = Math.max(...standing.bands.map((band) => band.count), 1);
  return (
    <div className="space-y-2">
      <h4 className="font-display text-base font-semibold">{heading}</h4>
      <p className="text-sm text-text-secondary">
        <span className="font-semibold text-text">{standingSentence(standing, verb, languageLabel)}</span> Yours{" "}
        <span className="font-mono tabular-nums">{format(standing.mine)}</span> {measure}, {best}{" "}
        <span className="font-mono tabular-nums">{format(standing.best)}</span>, the middle one{" "}
        <span className="font-mono tabular-nums">{format(standing.median)}</span>.
      </p>
      <table className="w-full table-auto">
        <caption className="sr-only">
          {heading} ({measure}) of the {standing.population} accepted solutions, grouped into {standing.bands.length}{" "}
          bands, with this submission&apos;s band marked.
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">{heading}</th>
            <th scope="col">Share of solutions</th>
            <th scope="col">Solutions</th>
            <th scope="col">This submission</th>
          </tr>
        </thead>
        <tbody>
          {standing.bands.map((band, k) => (
            <BandRow key={k} band={band} widest={widest} format={format} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GrowthSpread({ shares, unmeasured }: { shares: readonly GrowthShare[]; unmeasured: number }) {
  return (
    <div className="space-y-2">
      <h4 className="font-display text-base font-semibold">What the others grow like</h4>
      <ul className="space-y-1">
        {shares.map((share) => (
          <li key={share.growth} className="flex items-center gap-3 text-sm">
            <span className={share.mine ? "w-24 font-mono text-text" : "w-24 font-mono text-text-secondary"}>
              {COMPLEXITY_LABEL[share.growth]}
            </span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-elevated" aria-hidden>
              <span
                className={share.mine ? "block h-full rounded-full bg-primary" : "block h-full rounded-full bg-border-strong"}
                style={{ width: `${Math.round(share.share * 100)}%` }}
              />
            </span>
            <span className="w-28 text-right tabular-nums text-text-secondary">
              {share.count} {share.count === 1 ? "solution" : "solutions"}
              {share.mine ? <span className="ml-1 text-primary">· yours</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {unmeasured > 0 && (
        <p className="text-sm text-text-secondary">
          {unmeasured} of them could not be measured, for the same reasons listed above.
        </p>
      )}
    </div>
  );
}

function Standing({ standing, languageLabel }: { standing: SolutionStanding; languageLabel: string }) {
  return (
    <div className="space-y-5">
      <h3 className="font-display text-base font-semibold">Among the accepted solutions</h3>
      <MetricBlock
        heading="Time"
        measure="of CPU over every test"
        verb="Faster"
        best="the fastest"
        standing={standing.time}
        languageLabel={languageLabel}
        format={formatTimeMs}
      />
      <MetricBlock
        heading="Memory"
        measure="at its peak"
        verb="Lighter"
        best="the lightest"
        standing={standing.space}
        languageLabel={languageLabel}
        format={formatMemoryKb}
      />
      {standing.growth !== null && <GrowthSpread shares={standing.growth} unmeasured={standing.growthUnmeasured} />}
      <p className="text-xs text-text-secondary">
        One solution per student — their fastest accepted one — against this revision of the problem, in this language.
        Times are what each would have cost on the machine that judged yours, scaled by the calibration recorded with
        every result.
      </p>
    </div>
  );
}

/**
 * The whole section. Rendered only when there is something in it: a
 * submission with no stored measurement and no ranking shows nothing rather
 * than an empty frame.
 */
export function SolutionProfile({
  complexity,
  standing,
  languageLabel,
}: {
  complexity: ComplexityDetail | null;
  standing: StandingOutcome | null;
  languageLabel: string;
}) {
  if (complexity === null && standing === null) return null;
  const outcomes: Record<ComplexityMetric, ComplexityOutcome | null> = {
    TIME: complexity?.time ?? null,
    SPACE: complexity?.space ?? null,
  };
  return (
    <section aria-labelledby="solution-profile" className="space-y-3">
      <h2 id="solution-profile" className="font-display text-lg font-semibold">
        How this run behaved
      </h2>
      <Card className="space-y-5 p-5">
        <p className="text-sm text-text-secondary">
          These are measurements of this run, not facts about your program. The judge timed every test case and recorded
          its peak memory; what follows compares those readings against the sizes of the inputs they were given, so a
          class below is the curve your readings fit rather than a proof of your algorithm&apos;s complexity. Here{" "}
          <span className="font-mono">n</span> is the size of the input in bytes. Nothing in this section affects your
          verdict, your score or your XP.
        </p>

        {complexity !== null && (
          <div className="space-y-3">
            <h3 className="font-display text-base font-semibold">Measured growth</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {METRICS.map(({ metric, heading }) => {
                const outcome = outcomes[metric];
                return outcome === null ? null : (
                  <GrowthCard key={metric} metric={metric} heading={heading} outcome={outcome} />
                );
              })}
            </div>
          </div>
        )}

        {standing !== null &&
          (standing.ranked ? (
            <Standing standing={standing} languageLabel={languageLabel} />
          ) : (
            <p className="text-sm text-text-secondary">{STANDING_REFUSAL_SENTENCE[standing.reason]}</p>
          ))}
      </Card>
    </section>
  );
}
