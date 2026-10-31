# Phase 12l — interactive problems

SPEC §11, the last engine item: *"interactive problems (two boxes, FIFOs,
interactor CPU excluded, 2s mutual-idle deadlock detection — the most
fragile part of the engine; admin-authored interactors only, and keep them
out of high-stakes assessments until they have run cleanly through two
practice contests)."*

`CompareMode.INTERACTIVE` has existed in the enum since the init migration
and has been refused in four places ever since (`plan.ts`,
`harness/declaration.ts`, `authoring/content.ts`, the draft form). This
phase removes those refusals by making the thing they refuse.

---

## 1. What an interactive problem is here

A problem whose answer is a **conversation**: the student's program and an
author-written **interactor** exchange lines until one of them stops. There
is no expected output to compare — the interactor decides, as it goes, and
its exit code is the verdict.

Everything else about the problem is unchanged: a `ProblemVersion` with
`TestCase` rows, time and memory limits, lanes, XP, rejudges. A case's
input blob is the interactor's input file (the hidden data: the secret
number, the array, the graph). A case's **output blob is unused** and the
authoring surface stops asking for one.

## 2. The decisions, and why

### 2.1 The interactor is the judge. There is no second checker pass.

testlib's own interactor convention allows an interactor that writes the
contestant's answers to a file for a checker to grade afterwards. This
platform does not: the interactor exits with the verdict, exactly as a
checker does, because a two-program protocol where either program may fail
is already the most fragile thing in the engine and a third would double
the states nobody can reason about.

Exit codes are the checker's, unchanged (`src/judge/checker.ts`):

| Code | Meaning | Verdict |
|---|---|---|
| 0 | ok | AC |
| 1 | wrong answer | WA |
| 2 | presentation error | WA (there is no PE verdict) |
| 3 | FAIL — the INTERACTOR found a bug | permanent release, never the student's WA |
| 16 + n | partially correct, n points | PARTIAL (n = 100 → AC, n = 0 → WA) |
| anything else, a crash, its own limits | — | treated as FAIL |

Reusing `CHECKER_PARTIAL_BASE`, the compile flags, the compile cache and the
release path means an interactor is a checker that happens to run at the
same time as the solution, and nothing about how an author writes one is
new.

### 2.2 Two boxes, and they share nothing but the conversation

The solution runs in the slot's RUN box; the interactor runs in the slot's
CHECKER box — a different uid, a different cgroup, a different mount
namespace, which is exactly the separation the CHECKER box already exists
to provide. No new box role.

**The pipes are the worker's, not FIFOs in a shared directory.** SPEC says
"FIFOs", and a FIFO pair in a directory bound into both boxes is the
classic implementation; it is rejected here for one reason. A directory
both boxes can write to is a channel for more than the protocol: the
solution could write a file the interactor will later read, or read one it
left behind, and the property that makes this safe — *these two programs
share nothing but the conversation* — would depend on nobody making a
mistake in an author-written program.

Instead: isolate inherits fds 0/1/2 when `--stdin`/`--stdout` are not
given, so the worker spawns both isolate processes with piped stdio and
relays the bytes itself. `--inherit-fds` is **not** used and remains
banned — that flag keeps *every* fd open; this is isolate's ordinary
behaviour for the three standard streams, which it hands to the sandboxed
program and closes everything else.

Being in the middle is also what makes the next three sections possible at
all.

### 2.3 The interactor's CPU is excluded, by construction

Two isolate runs, two meta files, two cgroups. The student's `timeSec` is
the student's. Nothing has to be subtracted, and no accounting can drift.

What the student's **wall** clock does include is time spent waiting for
the interactor. That is unavoidable in any design, and it is bounded from
two sides: the interactor has its own CPU and wall limits
(`LIMITS.interactor`), and the idle deadline below fires long before a wall
limit would.

### 2.4 Mutual idle is a deadlock, and it is the student's

If neither program writes a byte for **2 s**, both are blocked reading.
That is a deadlock, and in practice it is a student who forgot to flush.

The verdict is **TLE**, because this platform has no IL verdict and
inventing one would mean a new value in an enum every surface renders. The
message says what happened in words, for a visible case:

> Neither your program nor the interactor wrote anything for 2 seconds.
> Both are waiting to read — this is usually a missing flush after
> printing a query.

The deadline is reset by a byte in **either** direction. A program that is
thinking hard is not idle; a program that is thinking hard for longer than
its CPU limit is TLE for the ordinary reason.

### 2.5 What the student may write is capped, as everywhere else

The bytes the solution sends to the interactor count against the same
output limit a non-interactive run has (`outputLimitBytes`), so a loop that
prints forever is OLE rather than a worker holding a growing buffer. The
interactor's own output to the solution is capped too — an interactor that
floods is the author's bug, so that one is a FAIL.

### 2.6 A case's expected output does not exist

`TestCase.outputSha256` is required by the schema and by every bundle, so
an interactive case gets the **empty blob**, and the authoring surface
stops asking for expected output. The alternative — making the column
nullable — would weaken a constraint that holds for every other kind of
problem, and the frozen-guard fence is right to refuse that.

### 2.7 Run, custom input, and the surfaces that do not get one

- **Run** executes the sample cases against the interactor, like any other
  problem.
- **Custom input** is refused: the input of an interactive case is the
  interactor's hidden data, and a student typing one would be typing the
  secret. The console's tab is absent, as it is for SQL (Phase 12k).
- **Assessments** refuse an interactive problem outright, for as long as
  SPEC says to: *"keep them out of high-stakes assessments until they have
  run cleanly through two practice contests"*. A contest may hold one.

### 2.8 Protocol 5

The job spec gains `interactor: interactorSpecSchema.nullable()` and
`compareMode: "INTERACTIVE"` becomes judgeable. A protocol-4 worker would
turn such a job into a permanent internal error, so `JUDGE_PROTOCOL_VERSION`
goes to 5 and the app refuses older workers with 426 — the mechanism
`docs/RUNBOOK.md` §2.9 already documents, and the reason it exists.

---

## 3. The slices

| Slice | What | Done when |
|---|---|---|
| 0 | this document | — |
| 1 | the engine: protocol 5, the interactive runner, verdicts | unit tests, and the real-isolate integration suite judging a guess-the-number problem AC / WA / TLE-by-deadlock / RE / OLE |
| 2 | the data model and authoring: an interactor on the version, validation, publish gates | a TA can author, validate and publish one through the real admin pages |
| 3 | the student surface, the contest/assessment rule, ops and docs | a student solves one through the production build; an assessment refuses one |

## 4. What this phase does NOT do

* **No interactor library beyond testlib.** C++ with testlib, like checkers.
* **No student-authored interactors**, ever.
* **No two-sided time limit tuning.** The interactor's limits are the
  checker's limits.
* **No partial-credit protocol** beyond testlib's `_pc(n)`, which the
  checker path already understands.
