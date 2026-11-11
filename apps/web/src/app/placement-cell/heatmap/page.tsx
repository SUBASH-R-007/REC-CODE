import type { Metadata } from "next";
import { EmptyState } from "@recx/design";
import { TIER_TARGETS, TOPIC_LABEL, cellShare, formatCampusDay } from "@recx/shared";
import { requirePlacementPage } from "@/lib/auth/guards";
import { cohortHeatmap, latestRunDay } from "@/server/queries/placement-cohort";
import { CohortFilter } from "@/components/placement/cohort-filter";
import { cohortOptions } from "@/server/queries/placement-cohort";
import { cohortSize, describeCohort, parseCohortFilter } from "@/lib/placement/filter";

export const metadata: Metadata = { title: "Topic weakness by section" };

/**
 * `/placement-cell/heatmap` — fourteen topics by section (Phase 9e).
 *
 * A real `<table>` with a `<caption>`, `scope="col"` and `scope="row"`
 * headers, and the COUNT printed in every cell. SPEC §6 requires exactly
 * that, and the reason is practical rather than procedural: a heatmap whose
 * only encoding is colour is unreadable to a colour-blind reader and
 * unquotable by anybody. "The graphs column looks red" is not something a
 * head of department can act on. "19 of 54 in section B" is.
 *
 * Colour is a redundant encoding, applied with an opacity derived from the
 * same count. No hardcoded hex — the existing lint rule forbids it, and the
 * tokens are what keep dark mode readable.
 *
 * It reads `section` and `topicUnassisted` and nothing else: there is no user
 * id in the query at all, which is the strongest form the no-ranking rule
 * takes anywhere in this phase.
 */
export default async function HeatmapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlacementPage();
  const computedOn = await latestRunDay();
  const filter = parseCohortFilter(await searchParams);

  if (!computedOn) {
    return (
      <EmptyState
        title="No readiness run has finished yet"
        description="The grid is built from the nightly run. Once one completes, it appears here."
      />
    );
  }

  const [options, { map, weakest }] = await Promise.all([
    cohortOptions(computedOn),
    cohortHeatmap(computedOn, filter),
  ]);
  const total = cohortSize(options);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Topic weakness by section</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          How many students in each section have fewer than {map.perTopicTarget} unassisted solves on each topic — the
          PRODUCT tier&rsquo;s per-topic target. Unassisted means without a hint or an editorial, which is the only
          count that tells you whether somebody could do it alone.
        </p>
        <p className="text-xs text-muted">
          From the run of {formatCampusDay(computedOn)}, over {describeCohort(filter)}.
        </p>
      </header>

      <CohortFilter basePath="/placement-cell/heatmap" current={filter} options={options} total={total} />

      {weakest.length > 0 ? (
        <section className="space-y-2 rounded-xl border border-border p-4">
          <h2 className="font-display text-base font-semibold">Where the whole cohort is thinnest</h2>
          {/*
            The one ranking this phase permits, and it ranks the SYLLABUS.
            "Nobody here has touched graphs" is a teaching decision, reachable
            without ever seeing a name.
          */}
          <ul className="space-y-1 text-sm">
            {weakest.map((row) => (
              <li key={row.topic} className="flex flex-wrap justify-between gap-x-4">
                <span>{TOPIC_LABEL[row.topic]}</span>
                <span className="tabular-nums text-text-secondary">
                  {row.behind} of {row.total} students short of {map.perTopicTarget}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {map.sections.length === 0 ? (
        <EmptyState title="No students in this cohort" description="Widen the filter above." />
      ) : (
        <div className="scroll-thin overflow-x-auto" tabIndex={0} aria-label="Topic weakness grid">
          <table className="w-full border-collapse text-sm">
            <caption className="pb-2 text-left text-xs text-text-secondary">
              Students short of {map.perTopicTarget} unassisted solves per topic, by section, out of each
              section&rsquo;s total. Every cell shows the count; the shading repeats it and carries no extra meaning.
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="sticky left-0 bg-surface py-2 pr-3 text-left font-semibold">
                  Section
                </th>
                {map.topics.map((topic) => (
                  <th key={topic} scope="col" className="px-2 py-2 text-left font-semibold">
                    <span className="block max-w-24 text-xs leading-tight">{TOPIC_LABEL[topic]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {map.sections.map((section) => (
                <tr key={section} className="border-b border-border last:border-0">
                  <th scope="row" className="sticky left-0 bg-surface py-2 pr-3 text-left font-medium">
                    {section}
                  </th>
                  {map.topics.map((topic) => {
                    const cell = map.cells.find((c) => c.section === section && c.topic === topic)!;
                    const share = cellShare(cell);
                    return (
                      <td key={topic} className="px-2 py-2 tabular-nums">
                        <span
                          className="inline-block min-w-12 rounded px-1.5 py-0.5"
                          // The shading is the redundant encoding. The number
                          // inside it is the data.
                          style={{ backgroundColor: `color-mix(in oklab, var(--danger) ${Math.round(share * 55)}%, transparent)` }}
                        >
                          {cell.behind}/{cell.total}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="max-w-3xl text-xs text-muted">
        The TOP tier asks for {TIER_TARGETS.TOP.perTopic} unassisted solves per topic rather than{" "}
        {TIER_TARGETS.PRODUCT.perTopic}, so the same grid read at interview depth is harsher everywhere. Neither
        number is a pass mark: breadth is the LOWEST of the fourteen, so the thinnest column is what a student&rsquo;s
        own page names as holding them back.
      </p>
    </div>
  );
}
