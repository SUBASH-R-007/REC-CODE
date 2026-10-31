import { useId } from "react";
import type { TopicCount } from "@/server/queries/profile";
import {
  labelAnchor,
  radarPoint,
  radarPolygon,
  radarRing,
  radarScaleMax,
  wrapLabel,
} from "@/components/profile/radar-model";

const WIDTH = 520;
const HEIGHT = 340;
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };
const RADIUS = 118;
const RINGS = 4;

/**
 * Skill radar over the 14 topics: unassisted first solves per topic
 * (UserStats.topicSolved). An SVG image with a text summary, plus the same
 * numbers as a data table (with assisted solves alongside on your own profile).
 */
export function SkillRadar({
  topics,
  subject = "you",
  showAssisted = true,
}: {
  topics: readonly TopicCount[];
  subject?: string;
  /** The assisted column is part of the student's own honest mirror, not the public profile. */
  showAssisted?: boolean;
}) {
  const id = useId();
  const values = topics.map((t) => t.unassisted);
  const max = radarScaleMax(values, RINGS);
  const total = values.reduce((a, b) => a + b, 0);
  const strongest = [...topics]
    .filter((t) => t.unassisted > 0)
    .sort((a, b) => b.unassisted - a.unassisted)
    .slice(0, 3)
    .map((t) => `${t.label} (${t.unassisted})`);
  const heading = subject === "you" ? "Skill radar" : `Skill radar for ${subject}`;
  const summary =
    total === 0
      ? `No unassisted solves yet across the ${topics.length} topics.`
      : `Unassisted solves across ${topics.length} topics. Strongest: ${strongest.join(", ")}.`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby={`${id}-title`}
        className="mx-auto h-auto w-full max-w-xl"
      >
        <title id={`${id}-title`}>{`${heading}${heading.endsWith(".") ? "" : "."} ${summary}`}</title>
        {Array.from({ length: RINGS }, (_, i) => (
          <polygon
            key={i}
            points={radarRing(topics.length, (i + 1) / RINGS, RADIUS, CENTER)}
            className="fill-none stroke-border"
            strokeWidth={1}
          />
        ))}
        {topics.map((t, i) => {
          const end = radarPoint(i, topics.length, 1, RADIUS, CENTER);
          return <line key={t.topic} x1={CENTER.x} y1={CENTER.y} x2={end.x} y2={end.y} className="stroke-border" strokeWidth={1} />;
        })}
        <polygon
          points={radarPolygon(values, max, RADIUS, CENTER)}
          className="fill-primary/20 stroke-primary"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {topics.map((t, i) => {
          const p = radarPoint(i, topics.length, t.unassisted / max, RADIUS, CENTER);
          return <circle key={t.topic} cx={p.x} cy={p.y} r={3} className="fill-primary" />;
        })}
        {topics.map((t, i) => {
          const at = radarPoint(i, topics.length, 1, RADIUS + 14, CENTER);
          const lines = wrapLabel(t.label);
          const anchor = labelAnchor(i, topics.length);
          // Keep two-line labels centred on their axis end.
          const dy = at.y < CENTER.y - RADIUS / 2 ? -(lines.length - 1) * 12 : at.y > CENTER.y + RADIUS / 2 ? 0 : -((lines.length - 1) * 12) / 2;
          return (
            <text key={t.topic} x={at.x} y={at.y + dy} textAnchor={anchor} dominantBaseline="middle" className="fill-text-secondary text-[11px]">
              {lines.map((line, j) => (
                <tspan key={j} x={at.x} dy={j === 0 ? 0 : 12}>
                  {line}
                </tspan>
              ))}
            </text>
          );
        })}
        <text x={CENTER.x + 4} y={CENTER.y - RADIUS - 2} className="fill-muted text-[10px]" aria-hidden>
          {max}
        </text>
      </svg>

      <details className="mt-2 text-sm">
        <summary className="inline-flex min-h-10 cursor-pointer items-center font-medium text-text underline decoration-primary decoration-2 underline-offset-4 hover:decoration-text">
          Show the skill radar as a table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-sm">
            <caption className="sr-only">Solves per topic</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Topic</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Unassisted solves</th>
                {showAssisted ? <th scope="col" className="py-2 text-right font-medium">Assisted solves</th> : null}
              </tr>
            </thead>
            <tbody>
              {topics.map((t) => (
                <tr key={t.topic} className="border-b border-border last:border-b-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">{t.label}</th>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{t.unassisted}</td>
                  {showAssisted ? <td className="py-1.5 text-right tabular-nums">{t.assisted}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
