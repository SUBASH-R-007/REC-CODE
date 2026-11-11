import { describe, expect, it } from "vitest";
import { TOPICS } from "../src/topics";
import {
  IDENTIFYING_COLUMNS,
  PLACEMENT_EXPORT_COLUMNS,
  assertExportColumns,
  heatmapCsvHeader,
  placementCsvHeader,
  placementCsvProvenance,
  placementCsvRow,
} from "../src/placement-export";

/**
 * The column allowlist is the privacy boundary for exports, and it binds in
 * BOTH directions — narrowing a permitted field is as much a departure as
 * widening a forbidden one. So these tests assert what must be present as
 * firmly as what must be absent.
 */

const keys = PLACEMENT_EXPORT_COLUMNS.map((column) => column.key);
const all = keys.join(" ");

describe("the allowlist carries what the spec permits", () => {
  it("has solved counts, rating, readiness, assessment scores and activity dates", () => {
    // The spec's own sentence, item by item. An export missing one of these
    // is as wrong as one carrying a forbidden field: the placement cell
    // cannot do its job from a file that leaves out what it was promised.
    expect(all).toMatch(/solvedTotal/);
    expect(all).toMatch(/solvedUnassisted/);
    expect(all).toMatch(/rating/);
    expect(all).toMatch(/serviceScore|productScore|topScore/);
    expect(all).toMatch(/assessmentScoreAverage/);
    expect(all).toMatch(/lastActiveOn/);
  });

  it("carries assessment SCORES, not merely a count of them", () => {
    /**
     * An earlier draft narrowed this to "how many released assessments
     * exist", which is not what the spec permits. Both are here: the count
     * says how much the mean rests on, and a mean without its n is a number
     * nobody can weigh.
     */
    expect(keys).toContain("assessmentScoreAverage");
    expect(keys).toContain("releasedAssessments");
  });

  it("puts the measurable weight beside every readiness score", () => {
    for (const tier of ["service", "product", "top"]) {
      expect(keys, tier).toContain(`${tier}Score`);
      expect(keys, tier).toContain(`${tier}AvailableWeight`);
    }
  });

  it("says which day and which weights the figures came from", () => {
    // Without these two a readiness column in a spreadsheet somebody keeps
    // for a year is a number with no provenance at all.
    expect(keys).toContain("readinessComputedOn");
    expect(keys).toContain("rulesVersion");
  });

  it("says how many rated contests a rating rests on", () => {
    expect(keys).toContain("contestsRated");
  });
});

describe("the allowlist carries nothing the spec forbids", () => {
  it("has no code, draft, note, per-test detail or accommodation", () => {
    expect(all).not.toMatch(/source|draft|note|testDetail|accommodation/i);
  });

  it("has no integrity signal of any kind", () => {
    // SPEC §7: never a band, never an integrity score, never a flag count —
    // not to a student, not to a recruiter, and not in a file an officer
    // can forward.
    expect(all).not.toMatch(/integrity|flag|band|proctor|suspicion|verdict/i);
  });

  it("has no email and no password material", () => {
    expect(all).not.toMatch(/email|password|token|secret|hash/i);
  });

  it("has no percentile, which would leak the cohort it was taken against", () => {
    // A percentile in a file alongside a roll number is a ranking of named
    // students, which is the one output SPEC §5 forbids outright.
    expect(all).not.toMatch(/percentile|rank/i);
  });
});

describe("every column is described, and the identifying ones are marked", () => {
  it("describes each column in words a reader can check", () => {
    for (const column of PLACEMENT_EXPORT_COLUMNS) {
      expect(column.describes.length, column.key).toBeGreaterThan(3);
      expect(["user", "snapshot", "assessment", "activity"]).toContain(column.source);
    }
  });

  it("marks the two columns that name a person, and only those", () => {
    /**
     * The export page states this count BEFORE the download starts: "a CSV
     * of readiness figures" and "a CSV naming 5,000 students" are different
     * things to leave on a laptop, and the officer should know which one
     * they are asking for.
     */
    expect([...IDENTIFYING_COLUMNS].sort()).toEqual(["collegeId", "name"]);
  });

  it("names each column once", () => {
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("assertExportColumns refuses rather than filters", () => {
  it("accepts a subset", () => {
    expect(() => assertExportColumns(["collegeId", "serviceScore", "serviceAvailableWeight"])).not.toThrow();
  });

  it("throws on a column that is not on the list", () => {
    /**
     * Throwing matters. A silent filter would turn a request for a forbidden
     * column into a file that merely lacked it, and nobody would ever learn
     * that something had tried.
     */
    expect(() => assertExportColumns(["collegeId", "submissionSource"])).toThrow(/submissionSource/);
    expect(() => assertExportColumns(["email"])).toThrow(/Not exportable/);
  });

  it("throws on an empty set and on a repeat", () => {
    expect(() => assertExportColumns([])).toThrow(/at least one column/);
    expect(() => assertExportColumns(["collegeId", "collegeId"])).toThrow(/twice/);
  });
});

describe("the CSV itself", () => {
  const columns = ["collegeId", "name", "serviceScore", "serviceAvailableWeight"];

  it("quotes every cell, and neutralises a formula", () => {
    /**
     * Reuses `csvCell` from ./csv rather than defining a second quoter: that
     * one prefixes a cell a spreadsheet would read as a formula with an
     * apostrophe, so an opened export can never run something planted in a
     * name. A placement CSV is exactly the file where that matters — it is
     * built from names and opened in Excel.
     */
    const row = placementCsvRow(
      { collegeId: "=SUM(A1:A9)", name: 'Priya "P" Sharma', serviceScore: 62, serviceAvailableWeight: 85 },
      columns,
    );
    expect(row).toContain("\"'=SUM(A1:A9)\"");
    expect(row).toContain('"Priya ""P"" Sharma"');
    // A complete line, CRLF included — the convention `csvRow` already sets,
    // so a route concatenates rather than joining.
    expect(row).toBe('"\'=SUM(A1:A9)","Priya ""P"" Sharma","62","85"\r\n');
  });

  it("writes an empty cell for a missing figure, never a zero", () => {
    // A student with nothing measurable has no score. A zero in that cell
    // would read as "not ready" in every spreadsheet it is opened in.
    const row = placementCsvRow({ collegeId: "R1", name: "A B", serviceScore: null }, columns);
    expect(row).toBe('"R1","A B","",""\r\n');
  });

  it("writes the header in the order asked for", () => {
    expect(placementCsvHeader(columns)).toBe('"collegeId","name","serviceScore","serviceAvailableWeight"\r\n');
  });

  it("refuses a header with a column off the list", () => {
    expect(() => placementCsvHeader(["collegeId", "note"])).toThrow(/Not exportable/);
  });

  it("defaults to every allowed column", () => {
    expect(placementCsvHeader()).toBe(placementCsvHeader(keys));
  });
});

describe("the provenance line makes a leaked file attributable to a person", () => {
  const line = placementCsvProvenance({
    exportId: "pex_1",
    requestedBy: "RECADMIN01",
    requestedAt: "2026-10-20 11:00 IST",
    computedOn: "2026-10-20",
    rowCount: 4312,
  });

  it("names the requester, the run and the export's own id", () => {
    // "The dashboard leaked a file" is not something anybody can act on;
    // "RECADMIN01 exported 4,312 rows on the 20th" is.
    expect(line).toContain("pex_1");
    expect(line).toContain("RECADMIN01");
    expect(line).toContain("2026-10-20 11:00 IST");
    expect(line).toContain("4312 row(s)");
  });

  it("repeats the denominator rule inside the file", () => {
    /**
     * The file outlives the page. A spreadsheet forwarded to a recruiter
     * three months later has no caption, no tooltip and no context — so the
     * sentence travels with it.
     */
    expect(line).toContain("out of the measurable weight beside it, not out of 100");
  });

  it("says so when no run has ever finished", () => {
    expect(
      placementCsvProvenance({
        exportId: "pex_2",
        requestedBy: "RECADMIN01",
        requestedAt: "now",
        computedOn: null,
        rowCount: 0,
      }),
    ).toContain("computed never");
  });

  it("is a single quoted cell, so a spreadsheet still parses the rest", () => {
    expect(line.startsWith('"')).toBe(true);
    expect(line.endsWith('"\r\n')).toBe(true);
    // No comma and no second quote inside it, so it is one field on one row
    // rather than a header the reader has to skip past.
    expect(line.slice(1, -3)).not.toContain('"');
    expect(line.split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("the heatmap export is a different file with a different boundary", () => {
  it("names a section and the fourteen topics, and no student", () => {
    const header = heatmapCsvHeader();
    expect(header).toContain('"section"');
    for (const topic of TOPICS) expect(header, topic).toContain(`"${topic}"`);
    expect(header).not.toMatch(/collegeId|name/);
  });
});
