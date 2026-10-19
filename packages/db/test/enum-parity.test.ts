import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMPARE_MODES,
  IO_MODES,
  JUDGE_LANES,
  JUDGE_NODE_STATUSES,
  SCORING_MODES,
  SUBTASK_AGGREGATIONS,
  VERDICTS,
  XP_RULES,
  TOPICS,
  XP_PERIODS,
  HELP_CONTEXTS,
  PROCTOR_EVENT_KINDS,
  ACCOMMODATION_KINDS,
  CONTEST_KINDS,
  DIVISIONS,
  APTITUDE_AREAS,
  APTITUDE_TOPICS,
  APTITUDE_QUESTION_KINDS,
  MOCK_PATTERN_STATUSES,
  MOCK_ATTEMPT_STATUSES,
} from "@recx/shared";
import { CONTENT_ORIGINS } from "@recx/shared/authoring";
import { describe, expect, it } from "vitest";

/**
 * The Prisma enums that mirror @recx/shared are storage copies only
 * (docs/OPEN-QUESTIONS.md, decision 3). They must hold the same members in
 * the same order, both in schema.prisma and in the database the migrations
 * build — otherwise a value the worker reports could fail to store, or a
 * stored value could fail the protocol's zod schema.
 */

const PRISMA_DIR = fileURLToPath(new URL("../prisma/", import.meta.url));

/** Parse `enum Name { A B @map("b") … }` blocks out of a Prisma schema. */
function parsePrismaEnums(schema: string): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  const withoutComments = schema.replace(/\/\/.*$/gm, "");
  for (const m of withoutComments.matchAll(/^\s*enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const members = m[2]!
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/)[0]!);
    enums.set(m[1]!, members);
  }
  return enums;
}

/**
 * Replay the CREATE TYPE / ALTER TYPE statements of every migration, in
 * order, to get each Postgres enum's labels as the migrations leave them.
 */
function replayMigrationEnums(migrationsDir: string): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  const quoted = (s: string) => s.replace(/^(?:"public"\.)?"?|"?$/g, "");
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(`${migrationsDir}${dir}/migration.sql`, "utf8").replace(/--.*$/gm, "");
    const statement =
      /CREATE\s+TYPE\s+((?:"public"\.)?"[^"]+")\s+AS\s+ENUM\s*\(([^)]*)\)|ALTER\s+TYPE\s+((?:"public"\.)?"[^"]+")\s+(ADD\s+VALUE(?:\s+IF\s+NOT\s+EXISTS)?\s+'([^']+)'(?:\s+(BEFORE|AFTER)\s+'([^']+)')?|RENAME\s+VALUE\s+'([^']+)'\s+TO\s+'([^']+)'|RENAME\s+TO\s+("[^"]+"))|DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?((?:"public"\.)?"[^"]+")/gi;
    for (const m of sql.matchAll(statement)) {
      if (m[1]) {
        enums.set(quoted(m[1]), [...m[2]!.matchAll(/'([^']+)'/g)].map((v) => v[1]!));
      } else if (m[3]) {
        const name = quoted(m[3]);
        const labels = enums.get(name) ?? [];
        if (m[5]) {
          if (labels.includes(m[5])) continue;
          const anchor = m[7] ? labels.indexOf(m[7]) : -1;
          if (anchor === -1) labels.push(m[5]);
          else labels.splice(m[6]!.toUpperCase() === "BEFORE" ? anchor : anchor + 1, 0, m[5]);
          enums.set(name, labels);
        } else if (m[8]) {
          enums.set(
            name,
            labels.map((l) => (l === m[8] ? m[9]! : l)),
          );
        } else if (m[10]) {
          enums.delete(name);
          enums.set(quoted(m[10]), labels);
        }
      } else if (m[11]) {
        enums.delete(quoted(m[11]));
      }
    }
  }
  return enums;
}

const MIRRORS: Array<[prismaEnum: string, sharedName: string, shared: readonly string[]]> = [
  ["Verdict", "VERDICTS", VERDICTS],
  ["JudgeLane", "JUDGE_LANES", JUDGE_LANES],
  ["CompareMode", "COMPARE_MODES", COMPARE_MODES],
  ["ScoringMode", "SCORING_MODES", SCORING_MODES],
  ["IoMode", "IO_MODES", IO_MODES],
  ["JudgeNodeStatus", "JUDGE_NODE_STATUSES", JUDGE_NODE_STATUSES],
  ["SubtaskAggregation", "SUBTASK_AGGREGATIONS", SUBTASK_AGGREGATIONS],
  ["Topic", "TOPICS", TOPICS],
  ["XpPeriod", "XP_PERIODS", XP_PERIODS],
  ["HelpContext", "HELP_CONTEXTS", HELP_CONTEXTS],
  ["ProctorEventKind", "PROCTOR_EVENT_KINDS", PROCTOR_EVENT_KINDS],
  ["AccommodationKind", "ACCOMMODATION_KINDS", ACCOMMODATION_KINDS],
  ["ContentOrigin", "CONTENT_ORIGINS (@recx/shared/authoring)", CONTENT_ORIGINS],
  ["ContestKind", "CONTEST_KINDS", CONTEST_KINDS],
  ["ContestDivision", "DIVISIONS", DIVISIONS],
  ["AptitudeArea", "APTITUDE_AREAS", APTITUDE_AREAS],
  ["AptitudeTopic", "APTITUDE_TOPICS", APTITUDE_TOPICS],
  ["AptitudeQuestionKind", "APTITUDE_QUESTION_KINDS", APTITUDE_QUESTION_KINDS],
  ["MockPatternStatus", "MOCK_PATTERN_STATUSES", MOCK_PATTERN_STATUSES],
  ["MockAttemptStatus", "MOCK_ATTEMPT_STATUSES", MOCK_ATTEMPT_STATUSES],
  // Difficulty keys the XP table; the Prisma enum must offer exactly those.
  ["Difficulty", "the keys of XP_RULES.firstSolve", Object.keys(XP_RULES.firstSolve)],
];

const schemaEnums = parsePrismaEnums(readFileSync(`${PRISMA_DIR}schema.prisma`, "utf8"));
const migratedEnums = replayMigrationEnums(`${PRISMA_DIR}migrations/`);

describe("Prisma enum parity with @recx/shared", () => {
  it("parses enums with comments, attributes and @map", () => {
    const parsed = parsePrismaEnums(
      ["// enum Ignored { X }", "enum Sample {", "  A // first", '  B @map("b")', "  @@map(\"sample\")", "}"].join("\n"),
    );
    expect([...parsed.entries()]).toEqual([["Sample", ["A", "B"]]]);
  });

  it.each(MIRRORS)("schema.prisma enum %s equals %s (same members, same order)", (prismaEnum, _sharedName, shared) => {
    expect(schemaEnums.get(prismaEnum), `enum ${prismaEnum} in schema.prisma`).toEqual([...shared]);
  });

  it.each(MIRRORS)("migrated Postgres enum %s equals %s", (prismaEnum, _sharedName, shared) => {
    expect(migratedEnums.get(prismaEnum), `CREATE/ALTER TYPE "${prismaEnum}" in migrations`).toEqual([...shared]);
  });

  it("every schema.prisma enum is created by the migrations with the same labels", () => {
    for (const [name, members] of schemaEnums) {
      expect(migratedEnums.get(name), name).toEqual(members);
    }
  });
});
