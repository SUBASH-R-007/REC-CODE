import type { Metadata } from "next";
import { EmptyState } from "@recx/design";
import { APTITUDE_AREAS, APTITUDE_AREA_LABEL } from "@recx/shared";
import { requirePlacementPage } from "@/lib/auth/guards";
import {
  APTITUDE_SECTION_MIN_ATTEMPTS,
  aptitudeSectionGaps,
  cohortOptions,
  latestRunDay,
} from "@/server/queries/placement-cohort";
import { CohortFilter } from "@/components/placement/cohort-filter";
import { cohortSize, describeCohort, parseCohortFilter } from "@/lib/placement/filter";

export const metadata: Metadata = { title: "Aptitude by section" };

/**
 * `/placement-cell/aptitude` — section-level aptitude accuracy (Phase 9e).
 *
 * Per SECTION and per AREA, never per student. "Section B is weak on verbal"
 * is a timetabling decision and it is reachable without naming anybody; "this
 * student is weak on verbal" is on their own page, where they can see it too.
 *
 * A section with fewer than {@link APTITUDE_SECTION_MIN_ATTEMPTS} attempts in
 * an area is reported as not measured rather than as a percentage. An
 * accuracy figure over nine questions is noise, and noise on a dashboard gets
 * acted on exactly as if it were signal.
 */
export default async function AptitudePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlacementPage();
  const filter = parseCohortFilter(await searchParams);
  const computedOn = await latestRunDay();
  const [gaps, options] = await Promise.all([
    aptitudeSectionGaps(filter),
    computedOn ? cohortOptions(computedOn) : Promise.resolve({ departments: [], batches: [], sections: [] }),
  ]);

  const sections = [...new Set(gaps.map((gap) => gap.section))].sort();
  const cell = (section: string, area: string) => gaps.find((g) => g.section === section && g.area === area);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Aptitude by section</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          Accuracy per section in each of the three areas, over every question those students have attempted. It is
          about the section, so the floor is on the section&rsquo;s total attempts rather than on each
          student&rsquo;s.
        </p>
        <p className="text-xs text-muted">Over {describeCohort(filter)}.</p>
      </header>

      <CohortFilter
        basePath="/placement-cell/aptitude"
        current={filter}
        options={options}
        total={cohortSize(options)}
      />

      {sections.length === 0 ? (
        <EmptyState
          title="No aptitude practice recorded in this cohort"
          description="Accuracy appears here once students have answered questions."
        />
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="pb-2 text-left text-xs text-text-secondary">
            Aptitude accuracy by section and area. A section with fewer than {APTITUDE_SECTION_MIN_ATTEMPTS} attempts
            in an area shows how many were attempted instead of a percentage, because an accuracy figure over a
            handful of questions is noise — and noise on a dashboard gets acted on exactly as if it were signal.
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-2 pr-3 text-left font-semibold">
                Section
              </th>
              {APTITUDE_AREAS.map((area) => (
                <th key={area} scope="col" className="px-2 py-2 text-left font-semibold">
                  {APTITUDE_AREA_LABEL[area]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => (
              <tr key={section} className="border-b border-border last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-medium">
                  {section}
                </th>
                {APTITUDE_AREAS.map((area) => {
                  const entry = cell(section, area);
                  return (
                    <td key={area} className="px-2 py-2 tabular-nums">
                      {entry && entry.accuracy !== null ? (
                        <>
                          {entry.accuracy}%{" "}
                          <span className="text-xs text-text-secondary">
                            ({entry.correct} of {entry.attempted})
                          </span>
                        </>
                      ) : (
                        <span className="text-text-secondary">
                          {entry?.attempted ? `${entry.attempted} attempted — too few` : "none yet"}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="max-w-3xl text-xs text-muted">
        Aptitude and verbal accuracy also feed readiness, as a percentile against the student&rsquo;s own batch — so a
        section that is weak here is a section whose SERVICE scores will be low for a reason that is fixable by
        teaching.
      </p>
    </div>
  );
}
