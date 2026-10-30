import {
  JUDGE_PROTOCOL_VERSION,
  SQL_LIMITS,
  sqlJobSpecSchema,
  type JobKind,
  type JudgeLane,
  type SqlJobSpec,
} from "@recx/shared";
import { JobSpecError, type JobSpecTestRow } from "@/lib/judge/job-spec";

/**
 * The SQL engine's half of the claim response (Phase 12k).
 *
 * Pure, like `buildJudgeJobSpec`: database rows in, the spec the sandbox
 * service receives out. A `TestCase`'s input blob is the case's dataset and
 * its output blob is the expected result set, which is why a SQL problem
 * needed no new table — and why this file is forty lines rather than two
 * hundred.
 *
 * Three things are the SERVER's to decide and are literals in the spec, not
 * inputs: the dialect, the statement timeout and the row cap. A judge that
 * could choose its own timeout would be a judge whose verdicts depended on
 * which host claimed them.
 */

export interface SqlJobSpecInput {
  kind: JobKind;
  id: string;
  lane: JudgeLane;
  claimToken: string;
  attempt: number;
  /** The student's statement (or, for a validation run, the reference query). */
  source: string;
  version: {
    sqlDialect: "postgres17" | null;
    sqlOrdered: boolean | null;
    stopOnFirstFailure: boolean;
  };
  tests: JobSpecTestRow[];
}

export function buildSqlJobSpec(input: SqlJobSpecInput): SqlJobSpec {
  const { sqlDialect, sqlOrdered } = input.version;
  if (sqlDialect === null || sqlOrdered === null) {
    // The CHECK ProblemVersion_sql_fields_pair makes this unreachable
    // through the application; a hand-edited row would be caught here.
    throw new JobSpecError("A SQL version must carry its dialect and its ordering rule.");
  }

  /**
   * Two kinds of job are not a plain submission.
   *
   * A RUN shows a student what their query does on the cases they can
   * already see; there is no custom input to run against, because a SQL
   * problem's input is its dataset and the author's datasets are what the
   * question means.
   *
   * A VALIDATION run is a CAPTURE run: it executes the author's reference
   * query and reports the result sets, which is how the expected results
   * come to exist. There is nothing to compare against — the version's
   * output blobs are still the empty placeholder a draft starts with — so
   * none is sent.
   */
  const capture = input.kind === "validation";
  const cases = (input.kind === "run" ? input.tests.filter((t) => t.isSample) : input.tests).map((test) => ({
    index: test.index,
    visible: test.isSample,
    setup: test.input,
    expected: capture ? null : test.output,
    ordered: sqlOrdered,
  }));
  if (cases.length === 0) {
    throw new JobSpecError(
      input.kind === "run" ? "That problem has no sample case to run against." : "A SQL version must have a case.",
    );
  }

  return sqlJobSpecSchema.parse({
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    engine: "postgres",
    kind: input.kind,
    id: input.id,
    lane: input.lane,
    claimToken: input.claimToken,
    attempt: input.attempt,
    dialect: sqlDialect,
    source: input.source,
    cases,
    capture,
    stopOnFirstFailure: input.version.stopOnFirstFailure,
    statementTimeoutMs: SQL_LIMITS.statementTimeoutMs,
    maxRows: SQL_LIMITS.rows,
  });
}
