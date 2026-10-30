import Link from "next/link";
import {
  FUNCTION_COMPARATOR_DESCRIPTIONS,
  SQL_LIMITS,
  SQL_NOTICES,
  readResultSet,
  type FunctionSignature,
} from "@recx/shared";
import { ResultSetTable } from "@/components/workspace/result-set";
import type { ProblemWorkspace } from "@/server/queries/problems";

/** How a FUNCTION problem's samples are read, by comparator. */
function functionSampleNote(signature: FunctionSignature) {
  const method = <code className="font-mono">{signature.methodName}</code>;
  if (signature.comparator === "IN_PLACE_MUTATION") {
    return (
      <>
        Your {method} function is called with these arguments and returns nothing; the output is{" "}
        <code className="font-mono">{signature.mutatedParam}</code> after your function returns — change it in place.
      </>
    );
  }
  const rule = signature.comparator === "EXACT" ? null : FUNCTION_COMPARATOR_DESCRIPTIONS[signature.comparator].student;
  return (
    <>
      Your {method} function is called with these arguments; its return value is the output.
      {signature.comparator === "CUSTOM_CHECKER" ? " Any correct answer is accepted — the sample shows one of them." : null}
      {rule && signature.comparator !== "CUSTOM_CHECKER" ? ` ${rule}` : null}
    </>
  );
}

/**
 * The Description tab: limits, the statement, constraints and samples.
 * Server-rendered; the title, difficulty and solve status live in the
 * workspace header (always visible), so this starts below them.
 *
 * Typography for the statement HTML (src/lib/markdown.ts emits only p,
 * h3–h6, lists, code, pre, blockquote, a, tables and inline marks).
 */
const STATEMENT_CLASSES = [
  "text-sm leading-relaxed text-text",
  "[&_p]:my-3 [&_strong]:font-semibold [&_em]:italic",
  "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:font-display [&_h3]:text-base [&_h3]:font-semibold",
  "[&_h4]:mt-5 [&_h4]:mb-2 [&_h4]:font-semibold [&_h5]:mt-4 [&_h5]:font-semibold [&_h6]:mt-4 [&_h6]:font-semibold",
  "[&_code]:rounded-md [&_code]:bg-primary-subtle [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-border [&_pre]:bg-background [&_pre]:p-3 [&_pre]:text-xs",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[1em]",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
  "[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary",
  "[&_hr]:my-6 [&_hr]:border-border",
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-background [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
].join(" ");

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

function formatMb(kb: number): string {
  return `${Math.round(kb / 1024)} MB`;
}

/** FUNCTION-mode inputs are one value per line, in parameter order. */
function labelledLines(input: string, signature: FunctionSignature | null): string {
  if (!signature) return input;
  const lines = input.replace(/\n$/, "").split("\n");
  if (lines.length !== signature.params.length) return input;
  return lines.map((line, k) => `${signature.params[k]?.name ?? `arg${k + 1}`} = ${line}`).join("\n");
}

function SampleBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{title}</p>
      {/* Wrapped, never a nested scroll region: the statement pane scrolls. */}
      <pre
        className="rounded-xl border border-border bg-background p-3 font-mono text-xs whitespace-pre-wrap break-words"
      >
        {text}
      </pre>
    </div>
  );
}

/**
 * How a SQL question is judged (Phase 12k), in full sentences.
 *
 * Everything here is a rule a student can be wrong about without their
 * query being wrong: the dialect, one statement, the read-only role,
 * whether the row order counts, and that column names are not compared.
 * The editor carries the first three as chips; this is where they are
 * explained, because this pane has room and the editor does not.
 */
function SqlJudgingNotes({ ordered }: { ordered: boolean }) {
  const notes = [
    SQL_NOTICES.dialect,
    SQL_NOTICES.oneStatement,
    SQL_NOTICES.readOnly,
    ordered ? SQL_NOTICES.ordered : SQL_NOTICES.unordered,
    SQL_NOTICES.columnNames,
    SQL_NOTICES.timeout,
  ];
  return (
    <section aria-labelledby="problem-sql-rules">
      <h2 id="problem-sql-rules" className="font-display text-base font-semibold">
        How your query is judged
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

/** A SQL sample's expected side: the rows as a table, or the text as it came. */
function SqlSampleOutput({ text }: { text: string }) {
  const resultSet = readResultSet(text);
  if (!resultSet) return <SampleBlock title="Expected rows" text={text} />;
  return <ResultSetTable title="Expected rows" resultSet={resultSet} />;
}

export function ProblemDescription({ problem, statementHtml }: { problem: ProblemWorkspace; statementHtml: string }) {
  const sql = problem.ioMode === "SQL";
  return (
    <article aria-label="Problem description" className="space-y-6">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        {sql ? (
          // A query's limit is the database's statement timeout, and its
          // memory is the server's business (work_mem spills to disk), so
          // neither the C++ time limit nor a memory figure describes it.
          <span>
            Query limit{" "}
            <span className="font-medium text-text">{formatSeconds(SQL_LIMITS.statementTimeoutMs)}</span>
          </span>
        ) : (
          <>
            <span>
              Time limit <span className="font-medium text-text">{formatSeconds(problem.timeLimitMs)}</span> (C++;{" "}
              <Link href="/judge#time-limits" className="text-primary underline underline-offset-2">
                scaled for other languages
              </Link>
              )
            </span>
            <span>
              Memory <span className="font-medium text-text">{formatMb(problem.memoryLimitKb)}</span>
            </span>
          </>
        )}
      </p>
      {problem.functionUnavailable.length > 0 && (
        <p className="text-xs text-text-secondary">
          Function problems are available in C++, Python and Java.{" "}
          {problem.functionUnavailable.map((l) => l.label).join(", ")} can be used for standard-input problems.
        </p>
      )}

      {/* Sanitised on the server by renderMarkdown() — allow-listed tags only. */}
      <div className={STATEMENT_CLASSES} dangerouslySetInnerHTML={{ __html: statementHtml }} />

      {sql && <SqlJudgingNotes ordered={problem.sqlOrdered === true} />}

      {problem.constraints.length > 0 && (
        <section aria-labelledby="problem-constraints">
          <h2 id="problem-constraints" className="font-display text-base font-semibold">
            Constraints
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs text-text">
            {problem.constraints.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      )}

      {problem.samples.length > 0 && (
        <section aria-labelledby="problem-samples" className="space-y-4">
          <h2 id="problem-samples" className="font-display text-base font-semibold">
            Sample tests
          </h2>
          {problem.signature && <p className="text-xs text-text-secondary">{functionSampleNote(problem.signature)}</p>}
          {problem.samples.map((sample, k) => (
            <div key={sample.index} className="space-y-2">
              <h3 className="text-sm font-semibold">Sample {k + 1}</h3>
              <div className="grid gap-2 xl:grid-cols-2">
                {sql ? (
                  <>
                    {/* The dataset the query runs against: the tables, and
                        the rows in them, exactly as the sandbox builds them. */}
                    <SampleBlock title="Dataset" text={sample.input} />
                    <SqlSampleOutput text={sample.output} />
                  </>
                ) : (
                  <>
                    <SampleBlock title="Input" text={labelledLines(sample.input, problem.signature)} />
                    <SampleBlock title="Output" text={sample.output} />
                  </>
                )}
              </div>
            </div>
          ))}
        </section>
      )}
    </article>
  );
}
