import type { Metadata } from "next";
import Link from "next/link";
import { Card, VerdictBadge } from "@recx/design";
import { HINT_POLICY, LIMITS, VERDICTS, XP_RULES, type VerdictDisplay } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { JUDGE_PAGE_PATH } from "@/lib/judge/judge-links";
import { buildJudgeFacts } from "@/lib/judge/transparency";
import { getPublicLanguageRows } from "@/server/queries/judge-languages";

export const metadata: Metadata = { title: "How judging works" };

/** Plain-words meaning and a next step for every verdict (exhaustive by type). */
const VERDICT_HELP: Readonly<Record<VerdictDisplay, { means: string; tryThis: string }>> = {
  AC: { means: "Every test passed within the limits.", tryThis: "Done. Compare your approach with the editorial when it opens." },
  WA: {
    means: "Your program ran but printed a different answer on at least one test.",
    tryThis: "Check edge cases: empty input, one element, duplicates, the largest values, negative numbers.",
  },
  TLE: {
    means: "Your program used more CPU time than the limit on a test.",
    tryThis: "Look at the constraints and aim for a faster algorithm; an extra loop over n is often the cause.",
  },
  MLE: {
    means: "Your program used more memory than the limit.",
    tryThis: "Avoid storing what you can compute on the fly, and watch the size of 2D arrays and recursion.",
  },
  OLE: {
    means: "Your program printed far more output than the answer needs.",
    tryThis: "Remove debugging prints and make sure loops that print terminate.",
  },
  RE: {
    means: "Your program crashed or exited with an error (for example an out-of-range index or division by zero).",
    tryThis: "Check array bounds, null values and recursion depth. The result names the signal or exit code when it can.",
  },
  CE: {
    means: "Your code did not compile (or, for Python and JavaScript, failed the syntax check). Nothing ran.",
    tryThis: "Read the compiler output shown with the verdict and fix the first error first.",
  },
  PARTIAL: {
    means: "Some tests or subtasks passed and earned points, but not all.",
    tryThis: "The result lists which subtasks failed; the smallest failing one is usually the clue.",
  },
  SKIPPED: {
    means: "This test did not run because an earlier one already failed.",
    tryThis: "Fix the first failing test; skipped tests run again on your next submission.",
  },
  IE: {
    means: "Something went wrong on our side, not in your code. It is not counted against you.",
    tryThis: "Submit again. If it keeps happening, tell your faculty coordinator.",
  },
  QUEUED: { means: "Your submission is waiting for a free judge.", tryThis: "Nothing to do: it starts on its own, usually within seconds." },
  RUNNING: { means: "Your code is being compiled and run against the tests.", tryThis: "Watch the tests finish one by one." },
};

const DISPLAY_ORDER: readonly VerdictDisplay[] = [...VERDICTS, "QUEUED", "RUNNING"];

const SECTIONS = [
  { id: "submitting", label: "What happens when you submit" },
  { id: "verdicts", label: "Verdicts" },
  { id: "comparing", label: "How output is compared" },
  { id: "limits", label: "Time and memory limits" },
  { id: "hidden-tests", label: "Hidden tests" },
  { id: "fair-use", label: "Daily limits" },
  { id: "hints", label: "Hints and editorials" },
  { id: "xp", label: "XP, streaks and the daily challenge" },
] as const;

const seconds = (ms: number) => `${ms / 1000} s`;
const mb = (kb: number) => `${Math.round(kb / 1024)} MB`;

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
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

/**
 * How judging works, in plain words. Every number on this page is read from
 * the single sources in @recx/shared (LIMITS, HINT_POLICY, XP_RULES) and the
 * enabled LanguageConfig rows' runtime JSON (the same rows and derivations as
 * the public /judge page, which has the exact versions, flags and limits), so
 * it cannot drift from what the judge actually does.
 */
export default async function HelpPage() {
  await requireUser();
  const languages = buildJudgeFacts(await getPublicLanguageRows()).languages.flatMap((l) =>
    l.fallback ? [{ key: l.key, label: l.label, fallback: l.fallback }] : [],
  );
  const caps = LIMITS.userCaps;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-2xl font-bold tracking-tight">How judging works</h1>
      <p className="mt-1 text-sm text-text-secondary">
        What happens to your code after you press Submit, what each verdict means, and the rules every submission is
        judged by.
      </p>

      <nav aria-label="On this page" className="mt-5 rounded-2xl border border-border bg-surface p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">On this page</p>
        <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="inline-flex min-h-8 items-center font-medium text-text underline-offset-2 hover:text-primary hover:underline">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-8 space-y-10">
        <Section id="submitting" title="What happens when you submit">
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>Your code is saved and placed in a queue. It is never run on the website&apos;s own servers.</li>
            <li>
              A separate judge server compiles it inside an isolated sandbox with no network access, then runs it on
              every test: the samples you can see and the hidden tests.
            </li>
            <li>Each test&apos;s result appears as it finishes. The final verdict is announced once.</li>
          </ol>
          <p>
            <strong>Run</strong> is for feedback: it runs your code on the samples (or your own input) and is never
            scored. <strong>Submit</strong> runs every test and counts towards your progress. On most problems judging
            stops at the first failing test and the rest are skipped.
          </p>
        </Section>

        <Section id="verdicts" title="Verdicts">
          <p>
            Every verdict is shown with an icon, its full name and a short code, so it never depends on colour.
          </p>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Verdicts table (scrolls sideways)">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Verdicts, what they mean and what to try next</caption>
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-text-secondary">
                    <th scope="col" className="px-4 py-3 font-medium">
                      Verdict
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      What it means
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      What to try
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {DISPLAY_ORDER.map((v) => (
                    <tr key={v} className="border-t border-border align-top first:border-t-0">
                      <th scope="row" className="px-4 py-3 font-normal">
                        <VerdictBadge verdict={v} size="sm" />
                      </th>
                      <td className="px-4 py-3 text-text">{VERDICT_HELP[v].means}</td>
                      <td className="px-4 py-3">{VERDICT_HELP[v].tryThis}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </Section>

        <Section id="comparing" title="How output is compared">
          <p>Each problem uses one of these rules. The problem statement says when it is not the default.</p>
          <dl className="space-y-2.5">
            <div>
              <dt className="font-semibold text-text">Token match (the default)</dt>
              <dd>
                Your output and the answer are split on spaces, tabs and newlines and the pieces must match in order.
                Extra spaces, blank lines and a missing final newline do not matter.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-text">Exact match</dt>
              <dd>Byte for byte, including every space and newline. Used when the layout itself is the answer.</dd>
            </div>
            <div>
              <dt className="font-semibold text-text">Decimal numbers</dt>
              <dd>
                Numbers count as equal when they are within a small tolerance (by default 10<sup>-6</sup>, absolute
                or relative); words must still match exactly.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-text">Special checker</dt>
              <dd>
                When many answers are correct (any valid order, any shortest path), a checker program written for the
                problem verifies yours.
              </dd>
            </div>
          </dl>
          <p>
            There is no separate &quot;presentation error&quot;: a formatting difference that the rule does not allow
            is a Wrong Answer.
          </p>
        </Section>

        <Section id="limits" title="Time and memory limits">
          <p>
            Time limits measure <strong>CPU time</strong>, not wall-clock time, so a busy judge does not make your
            program slower. A problem shows its C++ limit; every other language gets its own limit, measured from
            model solutions in that language. Where a language has no model solution, its limit is the C++ limit
            scaled:
          </p>
          {languages.length > 0 && (
            <Card className="overflow-hidden">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Time limit scaling by language</caption>
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-text-secondary">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Language
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Limit without a measured solution
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {languages.map(({ key, label, fallback }) => (
                    <tr key={key} className="border-t border-border first:border-t-0">
                      <td className="px-4 py-2.5 text-text">{label}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {fallback.multiplier === 1 && fallback.extraMs === 0
                          ? "same as C++"
                          : `C++ limit × ${fallback.multiplier}${fallback.extraMs > 0 ? ` + ${fallback.extraMs} ms` : ""}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              Every limit stays between {seconds(LIMITS.cpuTime.floorMs)} and {seconds(LIMITS.cpuTime.ceilingMs)}.
              The start-up time of Java, Kotlin, Python and JavaScript runtimes is measured on each judge and not
              charged to you.
            </li>
            <li>
              Memory is {mb(LIMITS.memory.defaultKb)} unless the problem says otherwise, and the stack may use all of
              it, so deep recursion is fine.
            </li>
            <li>
              Source code can be up to {LIMITS.source.defaultBytes / 1024} KB. Run uses at most{" "}
              {seconds(LIMITS.customRun.cpuMaxMs)} of CPU and {LIMITS.customRun.stdinBytes / 1024} KB of input.
            </li>
          </ul>
          <p>
            Exact versions, flags and every limit:{" "}
            <Link href={JUDGE_PAGE_PATH} className="font-medium text-text underline underline-offset-2 hover:text-primary">
              Judge specifications
            </Link>
            .
          </p>
        </Section>

        <Section id="hidden-tests" title="Hidden tests">
          <p>
            For a hidden test you see its verdict, time and memory — never its input, the expected answer or your
            output. For samples and your own Run input you also see the output and a short difference. Problems scored
            by subtasks award points per subtask and show a Partially Accepted verdict until every subtask passes.
          </p>
        </Section>

        <Section id="fair-use" title="Daily limits">
          <p>So the judges stay fast for everyone during lab hours, each student can have:</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              {caps.inFlightSubmissions} submissions and {caps.inFlightRuns} run being judged at the same time;
            </li>
            <li>{caps.practicePerDay} practice submissions per day and {caps.runsPerHour} runs per hour;</li>
            <li>{caps.cpuMinutesPerDay} minutes of judge CPU time per day.</li>
          </ul>
          <p>Days follow Indian Standard Time. Internal errors never count against you.</p>
        </Section>

        <Section id="hints" title="Hints and editorials">
          <p>Practice problems have up to three hints and an editorial, unlocked as you work:</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Hint 1 is available straight away.</li>
            <li>
              Hint 2 after {HINT_POLICY.tier2.failedAttempts} failed submission or {HINT_POLICY.tier2.activeMinutes}{" "}
              minutes of work on the problem.
            </li>
            <li>
              Hint 3 after {HINT_POLICY.tier3.failedAttempts} failed submissions or {HINT_POLICY.tier3.activeMinutes}{" "}
              minutes of work.
            </li>
            <li>
              The editorial once you solve the problem, or after {HINT_POLICY.editorial.attempts} attempts and{" "}
              {HINT_POLICY.editorial.activeMinutes} minutes of work.
            </li>
          </ul>
          <p>
            Solving after opening hint 3 or the editorial still counts as solved, but earns{" "}
            {Math.round(XP_RULES.assistedMultiplier * 100)}% of the XP. Contests and assessments have no hints or
            editorials at all.
          </p>
        </Section>

        <Section id="xp" title="XP, streaks and the daily challenge">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              A first solve earns {XP_RULES.firstSolve.EASY} XP (Easy), {XP_RULES.firstSolve.MEDIUM} XP (Medium) or{" "}
              {XP_RULES.firstSolve.HARD} XP (Hard). Solving the same problem again earns nothing extra.
            </li>
            <li>
              The daily challenge pays {XP_RULES.dailyChallengeMultiplier}× XP for a first solve on its day.
            </li>
            <li>
              At most {XP_RULES.caps.totalPerDay.toLocaleString("en-IN")} XP a day counts, of which at most{" "}
              {XP_RULES.caps.easyPerDay} from Easy problems.
            </li>
            <li>
              A streak day needs a judged submission, not just signing in. Streaks of{" "}
              {Object.keys(XP_RULES.streakMilestones).join(", ")} days earn a bonus.
            </li>
          </ul>
        </Section>
      </div>

      <p className="mt-10 border-t border-border pt-6 text-sm text-text-secondary">
        Found something hard to use with a keyboard, a screen reader or zoom? Read our{" "}
        <Link href="/accessibility" className="font-medium text-text underline underline-offset-2 hover:text-primary">
          accessibility statement
        </Link>{" "}
        to see how to report it.
      </p>
    </div>
  );
}
