# Phase 12n — output-only problems

SPEC §11: *"debugging and output-only problem kinds"*. The second of the
two, and the one that changes what a submission IS.

---

## 1. What an output-only problem is here

A problem that hands the student a hard instance and asks for **the answer
itself**. There is no program: the submission is the output, and it is
judged by comparing it with the expected output, or by the author's checker
when the answer deserves partial credit.

The student downloads (or reads) the input, works it out however they like
— by hand, in a spreadsheet, with a program they never upload — and
submits the result.

## 2. The decisions, and why

### 2.1 A fourth `IoMode`, not a flag

`IoMode` already answers "how does the answer reach the judge?" — STDIN (a
program reading standard input), FUNCTION (a function), SQL (a query). An
answer file is a fourth way, so `OUTPUT_ONLY` is a fourth value rather
than a boolean beside them. That it is an enum value also means every
exhaustive switch in the codebase stops compiling until it has been
thought about, which is the behaviour we want from a new kind of problem.

Two migrations, because PostgreSQL will not let a new enum value be USED in
the transaction that adds it: one adds the value, the next adds the CHECKs
that mention it. (Phase 12k split its SQL migration the same way.)

### 2.2 `answer1`: a language that is not a toolchain

`Submission.languageConfigId` is required, and that is what kept SQL
submissions inside the existing pipeline (XP, the leaderboard, contests,
rejudges) without touching `Submission` at all. The same trick, for the
same reason: `answer1` is a `LanguageConfig` row whose runtime is not a
`LanguageRuntime` — no argv, no toolchain, nothing to compile.

An output-only problem offers `answer1` and nothing else, and no other
problem offers it: one line in the workspace query and the same line in
the submit action, exactly as SQL's pairing works.

### 2.3 The judge fleet still judges it — protocol 6

A text comparison needs no sandbox, so it would be easy to do in the web
process. We do not, for two reasons. A CHECKER answer-problem runs the
AUTHOR's program, which may never run in the web process (the rule the
whole platform rests on). And a verdict that came from somewhere other
than the fleet would be a verdict with no node, no lane, no rejudge and no
`/metrics` row — a second pipeline to keep honest.

So the job goes to an isolate node as every other program job does, and
the worker gets an **answer path**: no compile, no run box, the student's
submitted text IS the output of the single case, and then the ordinary
comparator — or the ordinary checker, in its own box.

`JudgeJobSpec.language` becomes nullable, null exactly for `OUTPUT_ONLY`:
a job with no program has no runtime, and inventing one (say, C++ that
never runs) would mislead the first person to read a job spec. That is a
wire change, so `JUDGE_PROTOCOL_VERSION` goes to 6 and older workers are
refused with 426, the mechanism §2.9 of the runbook documents.

### 2.4 One case, and it is a sample

A submission carries one answer, so an output-only problem has exactly one
test case — and that case is a sample, because its input is the question
and the student cannot answer what they cannot see.

Both rules are the publish gate's (they span tables and blobs, so no CHECK
could hold them), and the gate's usual "at least one hidden test" rule is
lifted for this kind: a hidden case would be a second question nobody can
read.

### 2.5 The model answer is the reference solution

Validation runs the author's own answer through the real judge: a
`ReferenceSolution` in language `answer1` whose source is the expected
answer, expected AC. Nothing new is needed for it, and it is a real check
— it proves the stored expected output and the comparator agree, which is
exactly the mistake an output-only problem is prone to (a trailing
newline, a different ordering, a rounded number).

The gate's "no C++ model solution" warning is lifted here, as it is for
SQL, for the same reason: the model is not a program.

### 2.6 What this phase does NOT do

* **No multi-part answers.** One case, one answer. A question with ten
  instances and a score out of ten is a CHECKER answer-problem whose
  single input holds all ten — not ten cases the student answers
  separately.
* **No file upload.** The answer is typed or pasted into the editor, under
  the existing 256 KB source cap. A file picker is a surface change, not a
  judging one, and can come later without touching anything below it.
* **No time or memory limit for the student.** There is no program to
  limit. The version's limits still bound the CHECKER's own box, which is
  what they mean here.
* **Not in an assessment, and not in a contest, yet.** The honest reason
  is the same as Phase 12m's: those surfaces build their own editors, and
  neither has been read with an answer box in mind. A trigger says so.

## 3. The slices

| Slice | What | Done when |
|---|---|---|
| 1 | the model and the engine: the io mode, its CHECKs, `answer1`, protocol 6, the worker's answer path, the submit boundary | unit tests; a real-isolate test of a checker judging an answer; a database test over the CHECKs |
| 2 | authoring and the gate: one visible case, the model answer, the import format | gate tests; a database test of the authoring edits |
| 3 | the student surface: the answer box, the question's data, the result console | a student answers one through the running app, right and wrong |
