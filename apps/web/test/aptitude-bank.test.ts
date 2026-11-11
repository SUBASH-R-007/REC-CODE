import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APTITUDE_CSV_SHAPE,
  APTITUDE_LIMITS,
  APTITUDE_TOPIC_AREA,
  aptitudePublishSchema,
  MOCK_PATTERN_SEEDS,
  buildMockLayout,
  parseCsvRecords,
  rowToQuestion,
  type AptitudeTopic,
} from "@recx/shared";

/**
 * The authored aptitude bank (Phase 16k, `docs/ROADMAP.md` §1.2).
 *
 * Six mock patterns have been seeded since Phase 7 and **nothing seeded a
 * single question**, so a student who started a TCS-NQT mock sat down in
 * front of structure and no questions. That was the starkest gap in the
 * product: not a missing improvement, a feature that could not work.
 *
 * `apps/web/content/aptitude/*.csv` is 192 questions written for this
 * platform. They are CSVs and not a seed module on purpose — the seeder
 * already records the decision ("the QUESTIONS are a content programme with
 * named owners and are imported from CSV rather than seeded"), and this
 * honours it: the files go in through `/admin/aptitude/import`, the same
 * pipeline a faculty member uses, so the contract is exercised rather than
 * bypassed.
 *
 * It lives beside the app rather than in `tests/repo` because it reads them
 * with the PRODUCT'S OWN parser rather than a copy of it, and the repo
 * fences are text-and-structure tests that import no workspace package.
 * A separate validator would be a second definition of a valid question,
 * and the two would drift. `rowToQuestion` and `aptitudePublishSchema` are
 * what the import route and the publish action use, so a file that passes
 * here is a file that imports.
 *
 * What it checks:
 *   1. every file parses against `APTITUDE_CSV_SHAPE`;
 *   2. every row becomes a question with no errors AND no warnings;
 *   3. every question would pass the PUBLISH gate, which is where the worked
 *      explanation becomes mandatory — a bank that imports but cannot be
 *      published is a bank nobody can use;
 *   4. no two questions share a stem, because a shuffled section showing the
 *      same stem twice reads as a bug to a candidate;
 *   5. the bank covers the blueprint: for every topic, at least twice the
 *      largest number any ONE seeded pattern draws from it, which is
 *      §1.2's own bar ("a fresh paper twice over");
 *   6. every passage carries at least two questions, which is the rule a
 *      single row's CHECK cannot see.
 */

/** Beside the app that owns both the content and the importer. */
const DIR = path.join(__dirname, "..", "content", "aptitude");

const files = readdirSync(DIR)
  .filter((name) => name.endsWith(".csv"))
  .sort();

interface Parsed {
  readonly file: string;
  readonly index: number;
  readonly topic: AptitudeTopic;
  readonly stem: string;
  readonly passage: string | null;
  readonly question: Extract<ReturnType<typeof rowToQuestion>, { ok: true }>["question"];
}

/** Every row of every file, read exactly as the import route reads it. */
function readAll(): { rows: Parsed[]; problems: string[] } {
  const rows: Parsed[] = [];
  const problems: string[] = [];

  for (const file of files) {
    const text = readFileSync(path.join(DIR, file), "utf8");
    const parsed = parseCsvRecords(text, APTITUDE_CSV_SHAPE);
    // File-level problems mean nothing in the file is trusted, which is a
    // different thing from a row that fails validation — so they are
    // reported and the file is skipped.
    for (const issue of parsed.errors) problems.push(`${file}:${issue.line} ${issue.message}`);
    if (parsed.errors.length > 0) continue;
    parsed.rows.forEach(({ line, cells }) => {
      const result = rowToQuestion(cells, {
        area: null,
        topic: null,
        // What the import would be told at upload. `ai` because these were
        // written by an assistant, which is what the column is for: a
        // reviewer publishing one is told where it came from.
        origin: "AI_ASSISTED",
        sourceBatch: "seed-bank-2026-11",
      });
      // Warnings on either branch: the two LMS columns that warn are not in
      // these files, so a warning here means a column crept in that nothing
      // stores.
      for (const warning of result.warnings) problems.push(`${file}:${line} (warning) ${warning}`);
      if (!result.ok) {
        for (const error of result.errors) problems.push(`${file}:${line} ${error}`);
        return;
      }
      rows.push({
        file,
        index: line,
        topic: result.question.topic,
        stem: result.question.stem,
        passage: result.passage?.body ?? null,
        question: result.question,
      });
    });
  }
  return { rows, problems };
}

const { rows, problems } = readAll();

describe("the authored aptitude bank", () => {
  it("has files to read (sanity)", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(100);
  });

  it("every row parses with no error and no warning", () => {
    expect(problems).toEqual([]);
  });

  it("every question would pass the publish gate, explanation included", () => {
    const refused: string[] = [];
    for (const row of rows) {
      const ready = aptitudePublishSchema.safeParse({
        ...row.question,
        // The importer assigns the passage id; a passage-grouped row cannot
        // carry one, so the gate is given the shape it would have after
        // import.
        passageId: row.passage === null ? null : "passage-under-test",
      });
      if (!ready.success) {
        refused.push(`${row.file}:${row.index} ${ready.error.issues.map((i) => i.message).join("; ")}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it("every explanation is a worked one, not a tick", () => {
    // The publish gate's floor is 40 characters. A bank written to the floor
    // would pass it and teach nobody, so this asserts the bank's own
    // standard: a median well clear of the minimum.
    const lengths = rows.map((r) => r.question.explanation.trim().length).sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)]!;
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(APTITUDE_LIMITS.explanation.min);
    expect(median).toBeGreaterThan(150);
  });

  it("no two questions share a stem", () => {
    const seen = new Map<string, string>();
    const repeats: string[] = [];
    for (const row of rows) {
      const key = row.stem.replace(/\s+/g, " ").trim().toLowerCase();
      const first = seen.get(key);
      if (first) repeats.push(`${row.file}:${row.index} repeats ${first}`);
      else seen.set(key, `${row.file}:${row.index}`);
    }
    expect(repeats).toEqual([]);
  });

  it("every passage carries at least two questions", () => {
    const perPassage = new Map<string, number>();
    for (const row of rows) {
      if (row.passage === null) continue;
      perPassage.set(row.passage, (perPassage.get(row.passage) ?? 0) + 1);
    }
    const thin = [...perPassage.entries()]
      .filter(([, count]) => count < APTITUDE_LIMITS.passageQuestions.min)
      .map(([body, count]) => `${body.slice(0, 40)}... has ${count}`);
    expect(thin).toEqual([]);
  });

  /**
   * §1.2's own bar: "enough questions per AptitudeArea for the six patterns
   * to draw a fresh paper twice over". Read per TOPIC rather than per area,
   * which is stricter and is what a draw actually needs — a section asking
   * for 8 SERIES questions cannot be satisfied by 8 spare PROBABILITY ones.
   */
  it("covers twice the largest single-pattern draw, for every topic a pattern draws", () => {
    const need = new Map<string, number>();
    for (const pattern of MOCK_PATTERN_SEEDS) {
      const perPattern = new Map<string, number>();
      for (const section of pattern.sections) {
        for (const entry of section.topicMix) {
          perPattern.set(entry.topic, (perPattern.get(entry.topic) ?? 0) + entry.count);
        }
      }
      for (const [topic, count] of perPattern) {
        need.set(topic, Math.max(need.get(topic) ?? 0, count));
      }
    }

    const have = new Map<string, number>();
    for (const row of rows) have.set(row.topic, (have.get(row.topic) ?? 0) + 1);

    const short = [...need.entries()]
      .map(([topic, count]) => ({ topic, want: count * 2, got: have.get(topic) ?? 0 }))
      .filter((entry) => entry.got < entry.want)
      .map((entry) => `${entry.topic}: ${entry.got} of ${entry.want}`);
    expect(short, "author more questions for these topics").toEqual([]);
  });

  it("every topic it covers sits under the area its taxonomy gives it", () => {
    const wrong = rows
      .filter((row) => APTITUDE_TOPIC_AREA[row.topic] !== row.question.area)
      .map((row) => `${row.file}:${row.index} ${row.topic} filed under ${row.question.area}`);
    expect(wrong).toEqual([]);
  });

  it("every row names its own origin, so the bank is never recorded as faculty-written", () => {
    /**
     * `runAptitudeImport` defaults `origin` to FACULTY, and a row may
     * override it. These questions were written by an assistant, so every
     * row says so -- and this fence is why that cannot be lost by
     * deleting a column: without it, dropping `origin` from the files
     * would quietly record two hundred questions as a faculty member's
     * own work.
     */
    const missing: string[] = [];
    for (const file of files) {
      const parsed = parseCsvRecords(readFileSync(path.join(DIR, file), "utf8"), APTITUDE_CSV_SHAPE);
      if (!parsed.header.includes("origin")) {
        missing.push(`${file}: no origin column`);
        continue;
      }
      for (const { line, cells } of parsed.rows) {
        if ((cells.origin ?? "").trim().length === 0) missing.push(`${file}:${line} origin is blank`);
      }
    }
    expect(missing).toEqual([]);
    // And it resolves to AI_ASSISTED rather than to anything else.
    expect(new Set(rows.map((row) => row.question.origin))).toEqual(new Set(["AI_ASSISTED"]));
  });

  it("names every area, so no section of any pattern is left without a pool", () => {
    const areas = new Set(rows.map((row) => APTITUDE_TOPIC_AREA[row.topic]));
    expect([...areas].sort()).toEqual(["LOGICAL", "QUANTITATIVE", "VERBAL"]);
  });
});

/**
 * The draw itself, from these files and nothing else.
 *
 * This is §1.2's actual claim — "enough questions for the six patterns to
 * draw a fresh paper twice over" — and it is proved rather than counted,
 * because counting gets it wrong. A passage-grouped topic is drawn in WHOLE
 * GROUPS and never split, so 16 reading-comprehension questions in two
 * groups of 8 cannot fill a section of 6 however generous 16 looks. That is
 * exactly what happened: the count said yes and `buildMockLayout` said no,
 * naming the section and the reason.
 *
 * `buildMockLayout` is a pure function, so the pool is built straight from
 * the CSVs with synthetic ids. No database: an import is a separate claim,
 * tested in `aptitude-bank.db.test.ts`, and a long-lived test database
 * cannot be made to re-import the same content anyway — a published or
 * retired question is never deleted, by design.
 */
describe("every seeded pattern draws from this bank, twice over", () => {
  /** The pool as the sitting would see it: one entry per question, passages shared. */
  const pool = rows.map((row, index) => ({
    id: `q${index}`,
    topic: row.topic,
    optionCount: row.question.options.length,
    // The importer creates one passage per distinct body, which is what
    // keeps a group together in the draw.
    passageId: row.passage === null ? null : `p${[...new Set(rows.map((r) => r.passage))].indexOf(row.passage)}`,
  }));

  const sectionsOf = (pattern: (typeof MOCK_PATTERN_SEEDS)[number]) =>
    pattern.sections.map((section, index) => ({
      sectionId: `${pattern.slug}-${section.key}`,
      key: section.key,
      position: section.position ?? index + 1,
      topicMix: section.topicMix,
      questionCount: section.questionCount,
      shuffleQuestions: section.shuffleQuestions,
      shuffleOptions: section.shuffleOptions,
    }));

  it.each(MOCK_PATTERN_SEEDS.map((p) => [p.slug, p] as const))("%s fills on two different seeds", (slug, pattern) => {
    const sections = sectionsOf(pattern);
    const wanted = sections.reduce((sum, s) => sum + s.questionCount, 0);
    for (const seed of [1, 2]) {
      const layout = buildMockLayout({ seed, sections, pool });
      const drawn = layout.sections.reduce((sum, s) => sum + s.questions.length, 0);
      expect(drawn, `${slug} seed ${seed}`).toBe(wanted);
    }
  });

  it("two draws of the same pattern are not the same paper", () => {
    // Otherwise "twice over" would be satisfied by a pool holding exactly
    // one paper's worth and handing it back each time.
    const pattern = MOCK_PATTERN_SEEDS[0]!;
    const sections = sectionsOf(pattern);
    const idsOf = (seed: number) =>
      buildMockLayout({ seed, sections, pool })
        .sections.flatMap((s) => s.questions.map((q) => q.questionId))
        .sort()
        .join(",");
    expect(idsOf(11)).not.toBe(idsOf(22));
  });
});
