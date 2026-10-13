import type { Metadata } from "next";
import { Card, VerdictBadge } from "@recx/design";
import { LIMITS } from "@recx/shared";
import { Info, Scale } from "lucide-react";
import {
  EXAMPLE_BASE_MS,
  buildJudgeFacts,
  formatBytes,
  formatKib,
  formatMs,
  type JudgeFacts,
  type JudgeLanguageFact,
  type JudgeLimitBreach,
  type PublicLanguageRow,
} from "@/lib/judge/transparency";
import { getPublicLanguageRows } from "@/server/queries/judge-languages";

export const metadata: Metadata = {
  title: "Judge specifications",
  description:
    "Exact compiler and interpreter versions and flags, per-language time limits, memory limits, how TLE is measured, output limits and verdict precedence.",
};

// Never prerendered: the build must not touch the database.
export const dynamic = "force-dynamic";

const SECTIONS = [
  { id: "languages", label: "Languages, versions and flags" },
  { id: "time-limits", label: "Time limits per language" },
  { id: "tle", label: "How TLE is measured" },
  { id: "memory", label: "Memory" },
  { id: "output", label: "Output" },
  { id: "verdicts", label: "How a verdict is decided" },
  { id: "limits", label: "Every limit" },
  { id: "sandbox", label: "The sandbox" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const CODE_BASE = "max-w-full rounded-lg border border-border bg-background px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap text-text";
/** A short value (a path, one variable): sits in the text, wraps as a box. */
const CODE = `inline-block ${CODE_BASE}`;
/** A whole command line, on its own. */
const CODE_BLOCK = `block ${CODE_BASE}`;
const TABLE_HEAD = "border-b border-border text-xs uppercase tracking-wide text-text-secondary";

function Section({ id, title, children }: { id: SectionId; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} id={id} className="scroll-mt-20">
      <h2 id={`${id}-heading`} className="font-display text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-text-secondary [&_strong]:font-semibold [&_strong]:text-text">
        {children}
      </div>
    </section>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <dt className="font-medium text-text">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-border bg-surface p-3 text-sm text-text">
      <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-info" />
      <span>{children}</span>
    </p>
  );
}

function fallbackRule(fallback: NonNullable<JudgeLanguageFact["fallback"]>): string {
  if (fallback.multiplier === 1 && fallback.extraMs === 0) return "same as C++";
  return `C++ limit ×${fallback.multiplier}${fallback.extraMs > 0 ? ` + ${fallback.extraMs} ms` : ""}`;
}

function LanguageCard({ lang }: { lang: JudgeLanguageFact }) {
  return (
    <Card className="p-4 sm:p-5">
      <article aria-labelledby={lang.anchor}>
        <h3 id={lang.anchor} className="scroll-mt-20 font-display text-base font-semibold tracking-tight text-text">
          {lang.label}
        </h3>
        {lang.available ? (
          <dl className="mt-3 space-y-3 text-sm">
            <Fact term="Version">
              <span className="font-mono text-text">{lang.version}</span>
            </Fact>
            <Fact term="Toolchain">
              <ul className="space-y-1">
                {lang.toolchains.map((dir) => (
                  <li key={dir}>
                    <code className={CODE}>{dir}</code>
                  </li>
                ))}
              </ul>
              <span className="mt-1 block">Toolchain id {lang.toolchainId}, read-only inside the sandbox.</span>
            </Fact>
            <Fact term="Source file">
              <code className={CODE}>{lang.sourceFile}</code>
            </Fact>
            <Fact term="Compile">
              {lang.compile ? (
                <>
                  <code className={CODE_BLOCK}>{lang.compile.command}</code>
                  <span className="mt-1 block">
                    CPU {lang.compile.cpuSec} s, wall clock {lang.compile.wallSec} s
                    {lang.compile.slow ? " (the slow-compiler limits)" : ""}.
                  </span>
                </>
              ) : (
                "No compile step: the source file runs directly."
              )}
            </Fact>
            <Fact term="Run">
              <code className={CODE_BLOCK}>{lang.run}</code>
              {lang.jvmFlags ? (
                <span className="mt-1 block">
                  Plus, right after the java program, flags sized from the problem&apos;s memory limit:
                </span>
              ) : null}
              {lang.jvmFlags ? (
                <ul className="mt-1 space-y-1">
                  {lang.jvmFlags.map((example) => (
                    <li key={example.memoryKb}>
                      {`at ${formatKib(example.memoryKb)}: `}
                      <code className={CODE}>{example.flags}</code>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Fact>
            <Fact term="Environment">
              <ul className="space-y-1">
                {lang.env.map(([key, value]) => (
                  <li key={key}>
                    <code className={CODE}>{`${key}=${value}`}</code>
                  </li>
                ))}
              </ul>
            </Fact>
            <Fact term="Processes">{lang.processes}</Fact>
            <Fact term="Open files">{lang.openFiles}</Fact>
            {lang.fallback ? (
              <Fact term="Without a measured solution">
                {fallbackRule(lang.fallback)}: a {formatMs(EXAMPLE_BASE_MS)} C++ limit becomes{" "}
                {formatMs(lang.fallback.exampleMs)}.
              </Fact>
            ) : null}
          </dl>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">
            Version <span className="font-mono text-text">{lang.version}</span>. Its stored specification could not be
            read, so its flags are not shown here.
          </p>
        )}
      </article>
    </Card>
  );
}

function Breach({ breach }: { breach: JudgeLimitBreach }) {
  if (breach === "rejected") return <span className="text-text">Refused before judging</span>;
  if (breach === "truncated") return <span className="text-text">Cut off, not an error</span>;
  if (breach === null) return <span>No verdict</span>;
  return <VerdictBadge verdict={breach} size="sm" />;
}

function LanguagesSection({ facts, unavailable }: { facts: JudgeFacts; unavailable: boolean }) {
  return (
    <Section id="languages" title="Languages, versions and flags">
      <p>
        Every toolchain is pinned to an exact version. Compiler and run flags and the environment are fixed by the
        judge: a submission cannot add flags, environment variables or files. Compilation is offline, so the only
        libraries are each language&apos;s standard library and the packages its name lists (numpy for Python). For
        interpreted languages the compile step is a syntax check: a syntax error is a Compile Error.
      </p>
      {unavailable ? (
        <Notice>
          The language list is unavailable right now. Every limit and rule below still applies; reload the page to see
          the languages.
        </Notice>
      ) : facts.languages.length === 0 ? (
        <Notice>No language is enabled right now.</Notice>
      ) : (
        <div className="space-y-4">
          {facts.languages.map((lang) => (
            <LanguageCard key={lang.key} lang={lang} />
          ))}
        </div>
      )}
    </Section>
  );
}

function TimeLimitsSection({ facts }: { facts: JudgeFacts }) {
  const t = facts.timing;
  const scaled = facts.languages.filter((l) => l.fallback !== null);
  return (
    <Section id="time-limits" title="Time limits per language">
      <p>
        A problem states one time limit, for C++. Every enabled language gets its own limit when the problem is
        published:
      </p>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <strong>With a model solution in that language:</strong> {t.modelMultiplier} × its slowest test, and never
          below the C++ limit, rounded up to {formatMs(t.roundToMs)}.
        </li>
        <li>
          <strong>Without one:</strong> the C++ limit × the language&apos;s multiplier, plus its extra time, rounded up
          to {formatMs(t.roundToMs)}.
        </li>
        <li>
          Every limit stays between {formatMs(t.floorMs)} and {formatMs(t.ceilingMs)}. The Run button uses the same
          limit, capped at {formatMs(t.runCpuMaxMs)}.
        </li>
      </ul>
      {scaled.length > 0 ? (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Time limit multipliers by language (scrolls sideways)">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <caption className="sr-only">Time limit for a language without a measured model solution</caption>
              <thead>
                <tr className={TABLE_HEAD}>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Language
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Multiplier
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Extra
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    A {formatMs(EXAMPLE_BASE_MS)} C++ limit becomes
                  </th>
                </tr>
              </thead>
              <tbody>
                {scaled.map((lang) => (
                  <tr key={lang.key} className="border-t border-border first:border-t-0">
                    <th scope="row" className="px-4 py-2.5 font-normal text-text">
                      <a href={`#${lang.anchor}`} className="underline-offset-2 hover:text-primary hover:underline">
                        {lang.label}
                      </a>
                    </th>
                    <td className="px-4 py-2.5 font-mono text-xs">×{lang.fallback?.multiplier}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">+ {lang.fallback?.extraMs} ms</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{formatMs(lang.fallback?.exampleMs ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      <p>
        Memory is the problem&apos;s limit for every language: there is no per-language memory multiplier.
      </p>
      <p>
        <strong>Start-up credit.</strong> When a judge starts, it runs a hello-world program {t.startupRuns} times per
        language in its own sandbox and takes the median CPU time. That credit, at most {formatMs(t.startupMaxMs)}, is
        added to your limit when the judge takes your job, so the start-up of a runtime such as the JVM is not charged
        to you.
      </p>
    </Section>
  );
}

function TleSection({ facts }: { facts: JudgeFacts }) {
  const t = facts.timing;
  return (
    <Section id="tle" title="How TLE is measured">
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <strong>CPU time, not wall-clock time.</strong> The limit is the CPU time used inside the sandbox&apos;s
          control group, so a busy judge does not make your program slower on paper.
        </li>
        <li>
          <strong>Queue wait and compilation are never counted.</strong> The clock starts when your program starts, in
          a fresh sandbox, and the limit applies to each test on its own.
        </li>
        <li>
          <strong>Overruns are measured.</strong> A program may run {t.extraTimeSec} s past the limit so its CPU time
          is measured exactly; any CPU time over the limit is Time Limit Exceeded.
        </li>
        <li>
          <strong>A wall-clock safety net</strong> stops a program that waits instead of computing: ceil(
          {t.wallMultiplier} × CPU limit) + {t.wallAddSec} s, at most {t.wallCeilingSec} s (
          {t.wall.map((w) => `${formatMs(w.cpuMs)} → ${w.wallSec} s`).join(", ")}). That is still Time Limit Exceeded.
        </li>
      </ul>
      <p>
        <strong>Timing is not perfectly repeatable.</strong> Limits are at least {t.modelMultiplier}× the model
        solution, judges whose benchmark is more than {t.flipMarginPct}% off the fleet median are kept off contests and
        assessments, and every result records the judge that produced it. Even so, a solution within about{" "}
        {t.flipMarginPct}% of the limit can pass on one run and fail on another.
      </p>
    </Section>
  );
}

function MemorySection({ facts }: { facts: JudgeFacts }) {
  const jvm = facts.languages.filter((l) => l.available && l.jvmFlags).map((l) => l.label);
  // A collected runtime without a memory-derived heap ceiling (the JVM has one: jvmRunFlags).
  const managed = facts.languages.filter((l) => l.available && l.managed && !l.jvmFlags).map((l) => l.label);
  return (
    <Section id="memory" title="Memory">
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          The limit is {formatKib(LIMITS.memory.defaultKb)} unless the problem states another, and never more than{" "}
          {formatKib(LIMITS.memory.ceilingKb)}.
        </li>
        <li>
          It is the peak of the sandbox&apos;s memory control group (everything your program and its runtime use), not
          its virtual address space. Reaching it is Memory Limit Exceeded.
        </li>
        <li>The stack may use the whole memory limit, so deep recursion is fine.</li>
        {jvm.length > 0 ? (
          <li>
            {jvm.join(", ")}: the JVM&apos;s heap and thread-stack sizes are set from the problem&apos;s memory limit
            (the flags are listed with each language above), so a program that runs out of heap gets
            java.lang.OutOfMemoryError, judged Memory Limit Exceeded.
          </li>
        ) : null}
      </ul>
      {managed.length > 0 ? (
        <Notice>
          {managed.join(", ")}: these runtimes manage memory with a garbage collector, and the judge does not yet pass
          them a heap ceiling derived from your limit. A program that allocates quickly can reach the memory limit
          before the collector works hard.
        </Notice>
      ) : null}
    </Section>
  );
}

function OutputSection() {
  const L = LIMITS;
  return (
    <Section id="output" title="Output">
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          Each file your program writes may hold at most {formatKib(L.outputFile.defaultKb)}; a larger write is stopped
          (signal SIGXFSZ) and is Output Limit Exceeded.
        </li>
        <li>
          Standard output is checked every {formatMs(L.earlyOle.pollMs)}. Once it passes min(
          {formatBytes(L.earlyOle.capBytes)}, {L.earlyOle.perExpectedMultiplier} × the expected output +{" "}
          {formatBytes(L.earlyOle.slackBytes)}) the judge stops the program: Output Limit Exceeded.
        </li>
        <li>The judge keeps at most {formatBytes(L.stderrCapture.defaultBytes)} of your error output.</li>
        <li>
          For sample tests you see up to {formatBytes(L.detail.perTestBytes)} of input, expected and actual output per
          test ({formatBytes(L.detail.perSubmissionBytes)} per submission), kept for {L.detail.retentionDays} days. For
          a hidden test you see only its verdict, CPU time and memory.
        </li>
        <li>
          The Run button shows up to {formatBytes(L.customRun.stdoutBytes)} of output and{" "}
          {formatBytes(L.customRun.stderrBytes)} of errors, and takes up to {formatBytes(L.customRun.stdinBytes)} of
          your own input.
        </li>
      </ul>
    </Section>
  );
}

function VerdictsSection({ facts }: { facts: JudgeFacts }) {
  return (
    <Section id="verdicts" title="How a verdict is decided">
      <p>
        If compilation (or the syntax check) fails, the verdict is Compile Error and nothing runs. Otherwise each test
        runs in a fresh sandbox, and the <strong>first</strong> of these rules that matches decides that test:
      </p>
      <ol id="run-outcome-rules" className="space-y-2.5">
        {facts.outcomeRules.map((rule, index) => (
          <li key={rule.id} data-rule={rule.id} className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
            <span className="flex shrink-0 items-center gap-2 sm:w-64">
              <span aria-hidden className="w-5 text-right font-mono text-xs text-muted">
                {index + 1}.
              </span>
              {rule.verdict ? (
                <VerdictBadge verdict={rule.verdict} size="sm" />
              ) : (
                <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-1.5 text-xs font-medium text-text">
                  <Scale aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  Output compared
                </span>
              )}
            </span>
            <span>{rule.text}</span>
          </li>
        ))}
      </ol>
      <p>
        When one verdict sums up several tests, the worst wins, in this order (first is worst):
      </p>
      <ol id="verdict-precedence" className="flex flex-wrap gap-2">
        {facts.precedence.map((verdict) => (
          <li key={verdict}>
            <VerdictBadge verdict={verdict} size="sm" />
          </li>
        ))}
      </ol>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>
          <strong>ICPC-style problems:</strong> the verdict is that of the first failing test, in test order; when the
          problem stops at the first failure, the remaining tests are Skipped.
        </li>
        <li>
          <strong>Per-test and subtask scoring:</strong> Accepted when every point is earned, Partially Accepted when
          some are, otherwise the worst failing verdict in the order above.
        </li>
        <li>Internal errors are retried and never counted against you.</li>
      </ul>
    </Section>
  );
}

function LimitsSection({ facts }: { facts: JudgeFacts }) {
  return (
    <Section id="limits" title="Every limit">
      <Card className="overflow-hidden">
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Every judge limit (scrolls sideways)">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">Every limit the judge enforces, how, and what happens when it is reached</caption>
            <thead>
              <tr className={TABLE_HEAD}>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Resource
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Limit
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  How it is enforced
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  When reached
                </th>
              </tr>
            </thead>
            <tbody>
              {facts.limits.map((limit) => (
                <tr key={limit.id} data-limit={limit.id} className="border-t border-border align-top first:border-t-0">
                  <th scope="row" className="px-4 py-2.5 font-medium text-text">
                    {limit.resource}
                  </th>
                  <td className="px-4 py-2.5 text-text">{limit.value}</td>
                  <td className="px-4 py-2.5">{limit.mechanism}</td>
                  <td className="px-4 py-2.5">
                    <Breach breach={limit.breach} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Section>
  );
}

function SandboxSection() {
  return (
    <Section id="sandbox" title="The sandbox">
      <p>
        Your code never runs on the website&apos;s own servers. A separate judge machine runs each program in a fresh
        isolate sandbox with its own network namespace and no network access, its own process, mount and memory
        control groups, an unprivileged user, read-only toolchains and only this job&apos;s files. The judge machines
        hold no database credentials and no student records.
      </p>
      <p>
        This is layered containment: each layer limits what a program could reach if another one failed, and every
        judge checks its own sandbox when it starts and every {LIMITS.selfCheck.intervalMs / 3_600_000} hours.
      </p>
    </Section>
  );
}

async function loadRows(): Promise<PublicLanguageRow[] | null> {
  try {
    return await getPublicLanguageRows();
  } catch (error) {
    console.error("[judge] /judge could not read the language list:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The public judge transparency page (Phase 4). Reachable signed out, so it
 * calls no guard; it reads only the enabled, current LanguageConfig rows and
 * constants from @recx/shared — no user, node, problem or test data. Every
 * value is derived (lib/judge/transparency.ts), never copied, so the page
 * changes when the judge does. Server components only: no client JS of its
 * own (scripts/size-budget.mjs, "serverRendered").
 */
export default async function JudgePage() {
  const rows = await loadRows();
  const facts = buildJudgeFacts(rows ?? []);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-display text-2xl font-bold tracking-tight">Judge specifications</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Exactly how your code is compiled, run and judged: compiler and interpreter versions and flags, the time limit
        of every language, how time and memory are measured, output limits and how a verdict is chosen. Every value here
        is read from the judge&apos;s own configuration.
      </p>

      <nav aria-label="On this page" className="mt-5 rounded-2xl border border-border bg-surface p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">On this page</p>
        <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="inline-flex min-h-8 items-center font-medium text-text underline-offset-2 hover:text-primary hover:underline"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-8 space-y-10">
        <LanguagesSection facts={facts} unavailable={rows === null} />
        <TimeLimitsSection facts={facts} />
        <TleSection facts={facts} />
        <MemorySection facts={facts} />
        <OutputSection />
        <VerdictsSection facts={facts} />
        <LimitsSection facts={facts} />
        <SandboxSection />
      </div>
    </div>
  );
}
