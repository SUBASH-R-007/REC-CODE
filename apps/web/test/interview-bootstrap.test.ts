import { describe, expect, it } from "vitest";
import {
  INTERVIEW_BOOTSTRAP_COLUMNS,
  INTERVIEW_BOOTSTRAP_CSV_SHAPE,
  INTERVIEW_EARLIEST_YEAR,
  INTERVIEW_LIMITS,
  INTERVIEW_MODES,
  INTERVIEW_OUTCOMES,
  INTERVIEW_PREPARATION,
  INTERVIEW_ROUND_KINDS,
  TOPICS,
  bootstrapRowFrom,
  bootstrapRowKey,
  parseCsvRecords,
  splitBootstrapList,
} from "@recx/shared";

/**
 * The pre-launch interview collection, read from a file (Phase 16q,
 * `docs/ROADMAP.md` §1.7).
 *
 * What is worth testing is not that a CSV parses. It is that this reader
 * REFUSES rather than guesses, because every row becomes an account of a
 * real company's interview that a moderator reads and a student revises
 * from: a silently coerced month or a misspelt outcome would become a fact
 * about a company that nobody said.
 *
 * And that re-running the import is safe, which is `bootstrapRowKey`.
 */

const YEAR = 2026;

const GOOD: Record<string, string> = {
  companyName: "Zoho",
  role: "Member Technical Staff",
  mode: "On campus",
  heldYear: "2025",
  heldMonth: "8",
  rounds: "3",
  longestRoundMinutes: "60",
  outcome: "Offer",
  roundKinds: "ONLINE_ASSESSMENT|Technical|HR",
  topics: `${TOPICS[0]}|${TOPICS[1]}`,
  preparation: "REC_CODE_PRACTICE|Mock interviews",
  problemSlugs: "two-sum|handle-maker",
};

const row = (over: Record<string, string> = {}) => bootstrapRowFrom({ ...GOOD, ...over }, YEAR);

describe("the file's shape", () => {
  it("names every column the archive stores, and nothing else", () => {
    expect([...INTERVIEW_BOOTSTRAP_CSV_SHAPE.columns]).toEqual([...INTERVIEW_BOOTSTRAP_COLUMNS]);
    // No free-text column beyond the company name, which is the one the
    // student's own form has too: the archive's value is that it is
    // structured, and a notes box would make the bootstrap easy to collect
    // and useless to query.
    expect(INTERVIEW_BOOTSTRAP_COLUMNS).not.toContain("notes");
    expect(INTERVIEW_BOOTSTRAP_COLUMNS).not.toContain("comments");
  });

  it("lets a survey that did not ask the optional questions still import", () => {
    const optional = new Set(INTERVIEW_BOOTSTRAP_CSV_SHAPE.optionalColumns ?? []);
    expect(optional.has("longestRoundMinutes")).toBe(true);
    expect(optional.has("topics")).toBe(true);
    expect(optional.has("preparation")).toBe(true);
    expect(optional.has("problemSlugs")).toBe(true);
    // The ones that identify the interview are NOT optional.
    for (const column of ["companyName", "role", "mode", "heldYear", "heldMonth", "rounds", "outcome", "roundKinds"]) {
      expect(optional.has(column), column).toBe(false);
    }
  });

  it("is bounded for a moderator rather than for a database", () => {
    // Two graduated batches, every row read by a person.
    expect(INTERVIEW_BOOTSTRAP_CSV_SHAPE.maxRows).toBeLessThanOrEqual(500);
  });

  it("parses against the real CSV reader, header and all", () => {
    const header = INTERVIEW_BOOTSTRAP_COLUMNS.join(",");
    const line = INTERVIEW_BOOTSTRAP_COLUMNS.map((c) => GOOD[c]!).join(",");
    const parsed = parseCsvRecords(`${header}\n${line}\n`, INTERVIEW_BOOTSTRAP_CSV_SHAPE);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(bootstrapRowFrom(parsed.rows[0]!.cells, YEAR).row?.companyName).toBe("Zoho");
  });
});

describe("splitBootstrapList", () => {
  it("is pipe-separated, trimmed, and empty means none", () => {
    expect(splitBootstrapList("A | B|c ")).toEqual(["A", "B", "c"]);
    expect(splitBootstrapList("")).toEqual([]);
    expect(splitBootstrapList(undefined)).toEqual([]);
    // A comma is NOT a separator: a comma inside a CSV field is a quoting
    // problem nobody should have to think about while typing sixty rows.
    expect(splitBootstrapList("A, B")).toEqual(["A, B"]);
  });
});

describe("a row a survey produced", () => {
  it("reads the human spelling of a closed enumeration", () => {
    // "On campus" is what a survey answer says; ON_CAMPUS is what the
    // archive stores. Refusing the human spelling would mean somebody
    // rewriting a spreadsheet by hand.
    const read = row();
    expect(read.issues).toEqual([]);
    expect(read.row?.mode).toBe("ON_CAMPUS");
    expect(read.row?.outcome).toBe("OFFER");
    expect(read.row?.roundKinds).toEqual(["ONLINE_ASSESSMENT", "TECHNICAL", "HR"]);
    expect(read.row?.preparation).toEqual(["REC_CODE_PRACTICE", "MOCK_INTERVIEWS"]);
  });

  it("keeps the problems as ADDRESSES, because a survey cannot know a cuid", () => {
    expect(row().row?.problemSlugs).toEqual(["two-sum", "handle-maker"]);
  });

  it("reads an absent round length as null and not as a zero", () => {
    // Null is the archive's own way of saying "we did not ask".
    expect(row({ longestRoundMinutes: "" }).row?.longestRoundMinutes).toBeNull();
    expect(row({ longestRoundMinutes: "  " }).row?.longestRoundMinutes).toBeNull();
    expect(row({ longestRoundMinutes: "0" }).row).toBeNull();
  });
});

describe("what it refuses, and it refuses rather than guesses", () => {
  const refusal = (over: Record<string, string>) => {
    const read = row(over);
    expect(read.row, JSON.stringify(over)).toBeNull();
    return read.issues.join(" | ");
  };

  it("refuses a value outside a closed enumeration, naming the whole list", () => {
    const why = refusal({ outcome: "Got the job" });
    expect(why).toContain("Got the job");
    for (const value of INTERVIEW_OUTCOMES) expect(why).toContain(value);
  });

  it("refuses a mode, a round kind, a topic or a preparation it does not know", () => {
    expect(refusal({ mode: "Walk-in" })).toContain(INTERVIEW_MODES[0]);
    expect(refusal({ roundKinds: "TECHNICAL|Coffee chat" })).toContain("Coffee chat");
    expect(refusal({ topics: "Vibes" })).toContain("Vibes");
    expect(refusal({ preparation: "Luck" })).toContain("Luck");
    // And it names every one of the allowed values, so the fix is in the
    // message rather than in the source.
    expect(refusal({ roundKinds: "Coffee chat" })).toContain(INTERVIEW_ROUND_KINDS[0]);
    expect(refusal({ preparation: "Luck" })).toContain(INTERVIEW_PREPARATION[0]);
  });

  it("refuses a number that is not one, rather than reading 3 from \"3 rounds\"", () => {
    expect(refusal({ rounds: "3 rounds" })).toContain("not a whole number");
    expect(refusal({ heldMonth: "August" })).toContain("not a whole number");
    expect(refusal({ heldYear: "2025.5" })).toContain("not a whole number");
  });

  it("refuses a year before the archive starts or after today", () => {
    expect(refusal({ heldYear: String(INTERVIEW_EARLIEST_YEAR - 1) })).toContain("outside");
    expect(refusal({ heldYear: String(YEAR + 1) })).toContain("outside");
    // The boundaries themselves are fine.
    expect(row({ heldYear: String(INTERVIEW_EARLIEST_YEAR) }).row).not.toBeNull();
    expect(row({ heldYear: String(YEAR) }).row).not.toBeNull();
  });

  it("refuses a month that is not one, and a round count the archive will not hold", () => {
    expect(refusal({ heldMonth: "0" })).toContain("not a month");
    expect(refusal({ heldMonth: "13" })).toContain("not a month");
    expect(refusal({ rounds: "0" })).toContain("outside");
    expect(refusal({ rounds: String(INTERVIEW_LIMITS.rounds.max + 1) })).toContain("outside");
  });

  it("refuses an empty company or role", () => {
    expect(refusal({ companyName: " " })).toContain("companyName");
    expect(refusal({ role: "" })).toContain("role");
  });

  it("refuses a row with no kind of round, because that is what it is for", () => {
    expect(refusal({ roundKinds: "" })).toContain("names no kind of round");
  });

  it("notices when the survey's two answers disagree", () => {
    // More kinds of round than rounds: a moderator cannot tell which answer
    // is the mistake, so neither should this.
    expect(refusal({ rounds: "1", roundKinds: "TECHNICAL|HR" })).toContain("for 1 round");
  });

  it("refuses a duplicate in any list", () => {
    expect(refusal({ roundKinds: "TECHNICAL|Technical" })).toContain("twice");
    expect(refusal({ problemSlugs: "two-sum|two-sum" })).toContain("twice");
  });

  it("reports every problem with a row, not the first", () => {
    const read = row({ mode: "Walk-in", outcome: "Got the job", heldMonth: "13" });
    expect(read.row).toBeNull();
    // One pass over the file fixes it, rather than one problem per upload.
    expect(read.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("bootstrapRowKey, which is what makes re-running safe", () => {
  const key = (over: Record<string, string> = {}) => bootstrapRowKey(row(over).row!);

  it("is company, role, month and outcome", () => {
    expect(key()).toBe(key());
    expect(key({ companyName: "Freshworks" })).not.toBe(key());
    expect(key({ role: "SDE" })).not.toBe(key());
    expect(key({ heldMonth: "9" })).not.toBe(key());
    expect(key({ outcome: "No offer" })).not.toBe(key());
  });

  it("ignores case and spacing in the company and the role", () => {
    // The same interview typed twice by two people is one interview.
    expect(key({ companyName: "  ZOHO " })).toBe(key());
    expect(key({ role: "Member  Technical  Staff" })).toBe(key());
  });

  it("is NOT the whole row, so better notes are the same interview", () => {
    /**
     * A second pass of the same survey may have added the round length, the
     * topics or the problems. That is the same interview with better notes,
     * and keying on the whole row would import it again and double the
     * company tag.
     */
    expect(key({ longestRoundMinutes: "" })).toBe(key());
    expect(key({ topics: "" })).toBe(key());
    expect(key({ problemSlugs: "" })).toBe(key());
    expect(key({ rounds: "4", roundKinds: "TECHNICAL|HR|MANAGERIAL|ONLINE_ASSESSMENT" })).toBe(key());
  });
});
