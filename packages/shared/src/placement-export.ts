import { csvRow } from "./csv";
import { TOPICS, type Topic } from "./topics";
import { READINESS_TIERS, type ReadinessTier } from "./readiness";

/**
 * The placement CSV's column allowlist (Phase 9e).
 *
 * This list IS the privacy boundary for exports. As data rather than as a
 * `select` somebody reviews by eye, a test can assert it against the schema
 * and against the spec's own sentence — and the boundary holds in BOTH
 * directions, which is the part that is easy to miss: narrowing a permitted
 * field is as much a departure as widening a forbidden one. The spec says
 * "solved counts, rating, readiness, assessment scores and activity dates",
 * so released assessment scores are IN, and an earlier draft that reduced
 * them to a count was wrong.
 *
 * Every column says what it is and where it comes from, because the question
 * a reader has is "could this one identify or judge somebody", and the
 * answer has to be checkable without reading the query.
 *
 * What is NOT here, and never will be: a submission's source, a draft, a
 * private note, a per-test detail, an accommodation, an audit row, a flag
 * count, an integrity band, or a percentile against a cohort too small to
 * hide anybody in.
 */

export interface PlacementExportColumn {
  /** The CSV header, which is also the key in the row object. */
  readonly key: string;
  /** What it holds, for the reader of this file and for the export page. */
  readonly describes: string;
  /** Where it comes from: the snapshot, the user row, or an aggregate. */
  readonly source: "user" | "snapshot" | "assessment" | "activity";
  /**
   * True for the columns that identify a person. The export page states how
   * many of these are in the file BEFORE the download starts, because "a CSV
   * of readiness figures" and "a CSV naming 5,000 students" are different
   * things to leave on a laptop.
   */
  readonly identifying?: true;
}

export const PLACEMENT_EXPORT_COLUMNS: readonly PlacementExportColumn[] = Object.freeze([
  { key: "collegeId", describes: "roll number", source: "user", identifying: true },
  { key: "name", describes: "the student's name", source: "user", identifying: true },
  { key: "departmentCode", describes: "department", source: "snapshot" },
  { key: "batchYear", describes: "batch", source: "snapshot" },
  { key: "section", describes: "section", source: "snapshot" },

  // Readiness, each score beside the weight that was measurable for it.
  // Never a score alone: a 70 out of 85 compared against an absolute 70
  // marks a student as behind because of a component nobody has built.
  { key: "serviceScore", describes: "SERVICE readiness", source: "snapshot" },
  { key: "serviceAvailableWeight", describes: "what was measurable for SERVICE", source: "snapshot" },
  { key: "productScore", describes: "PRODUCT readiness", source: "snapshot" },
  { key: "productAvailableWeight", describes: "what was measurable for PRODUCT", source: "snapshot" },
  { key: "topScore", describes: "TOP readiness", source: "snapshot" },
  { key: "topAvailableWeight", describes: "what was measurable for TOP", source: "snapshot" },
  { key: "readinessComputedOn", describes: "the campus day the figures were computed", source: "snapshot" },
  { key: "rulesVersion", describes: "the weights the figures were computed under", source: "snapshot" },

  // Solved counts. The spec's words, and the split that matters: a solve
  // reached with a hint counts for SERVICE and not for the two tiers above.
  { key: "solvedTotal", describes: "problems solved", source: "snapshot" },
  { key: "solvedUnassisted", describes: "problems solved without a hint or an editorial", source: "snapshot" },
  { key: "topicsTouched", describes: "how many of the fourteen topics have any unassisted solve", source: "snapshot" },
  { key: "limitingTopicProduct", describes: "the topic holding PRODUCT breadth down", source: "snapshot" },

  // Rating, with the count it rests on. A rating without its contest count
  // is a number nobody can weigh.
  { key: "rating", describes: "contest rating", source: "user" },
  { key: "contestsRated", describes: "how many rated contests the rating rests on", source: "user" },

  // Assessment scores, released only.
  { key: "releasedAssessments", describes: "how many released assessment scores exist", source: "assessment" },
  { key: "assessmentScoreAverage", describes: "mean released assessment score, as a percentage", source: "assessment" },

  // Activity dates.
  { key: "lastActiveOn", describes: "the last campus day with any activity", source: "activity" },
  { key: "activeDaysLast30", describes: "active days in the last thirty", source: "activity" },
] as const satisfies readonly PlacementExportColumn[]);

export type PlacementExportColumnKey = (typeof PLACEMENT_EXPORT_COLUMNS)[number]["key"];

/** One row, keyed by column. A missing figure is an empty cell, never a zero. */
export type PlacementExportRow = Readonly<Partial<Record<string, string | number | null>>>;

/** The columns that name a person, for the count the export page states first. */
export const IDENTIFYING_COLUMNS: readonly string[] = Object.freeze(
  PLACEMENT_EXPORT_COLUMNS.filter((column) => column.identifying).map((column) => column.key),
);

/**
 * Refuse a column set that is not a subset of the allowlist.
 *
 * Throws rather than filtering. A silent filter would turn a request for a
 * forbidden column into a file that merely lacked it, and nobody would learn
 * that something tried.
 */
export function assertExportColumns(columns: readonly string[]): void {
  const allowed = new Set<string>(PLACEMENT_EXPORT_COLUMNS.map((column) => column.key));
  const unknown = columns.filter((column) => !allowed.has(column));
  if (unknown.length > 0) {
    throw new Error(`Not exportable: ${unknown.join(", ")}. See PLACEMENT_EXPORT_COLUMNS.`);
  }
  if (columns.length === 0) throw new Error("An export needs at least one column.");
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column)) throw new Error(`Column named twice: ${column}`);
    seen.add(column);
  }
}

/*
 * There is no `csvCell` here on purpose. `./csv` already has one, and it is
 * the stronger of the two: it quotes every cell AND prefixes a cell a
 * spreadsheet would read as a formula with an apostrophe, so an opened export
 * can never run something planted in a name. A second, weaker quoter beside
 * it is how an export surface loses that protection without anybody
 * noticing.
 */

/**
 * Each of the three line builders returns a COMPLETE line, CRLF included,
 * because `csvRow` in ./csv does — the aptitude export already relies on
 * that, and a second convention here would mean one of the two callers
 * doubling or dropping a terminator. A route concatenates; it never joins.
 */
export function placementCsvHeader(columns: readonly string[] = PLACEMENT_EXPORT_COLUMNS.map((c) => c.key)): string {
  assertExportColumns(columns);
  return csvRow(columns);
}

export function placementCsvRow(row: PlacementExportRow, columns: readonly string[]): string {
  return csvRow(columns.map((column) => row[column] ?? null));
}

/**
 * The provenance line the CSV opens with.
 *
 * SPEC's reasoning, carried: a leaked file has to be attributable to a
 * PERSON rather than to "the dashboard". So the first line names the
 * requester, the run the figures come from and the export's own id, and it is
 * a comment line rather than data so a spreadsheet still parses the rest.
 */
export function placementCsvProvenance(input: {
  readonly exportId: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly computedOn: string | null;
  readonly rowCount: number;
}): string {
  return csvRow([
    `REC Code placement export ${input.exportId} — requested by ${input.requestedBy} on ${input.requestedAt}; ` +
      `readiness computed ${input.computedOn ?? "never"}; ${input.rowCount} row(s). ` +
      "Every readiness score in this file is out of the measurable weight beside it, not out of 100.",
  ]);
}

/**
 * The topic columns the heatmap export uses, in `TOPICS` order.
 *
 * Separate from the row allowlist on purpose: the heatmap is counts per topic
 * per section and names no student at all, so it is a different file with a
 * different boundary.
 */
export function heatmapCsvHeader(): string {
  return csvRow(["section", ...TOPICS]);
}

export const EXPORTED_TIERS: readonly ReadinessTier[] = Object.freeze([...READINESS_TIERS]);
export const EXPORTED_TOPICS: readonly Topic[] = Object.freeze([...TOPICS]);
