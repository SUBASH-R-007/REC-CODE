# Phase 12p — the kinds an exam cannot sit, and the rows that said otherwise

Written before any of it, like the other designs in this directory.

Phase 12 built every item on SPEC §11's deferred list except core-CS MCQ,
which `docs/OPEN-QUESTIONS.md` parks on a human's decision about one guarded
constraint drop. What is left is not building: it is the `NOT RUN` rows in
`docs/RUNBOOK.md` §3 — and, found while reading them, one hole that is real.

## The hole: a SQL problem can be pinned into an assessment

Three kinds of problem are already refused at the pin, each for the same
reason and each in the same three places (a trigger, a catalogued guard, and
the sentence an admin reads first):

| Kind | Trigger | Phase |
|---|---|---|
| interactive | `AssessmentProblem_no_interactive` | 12l |
| debugging (an edit budget) | `AssessmentProblem_no_debug_budget` | 12m |
| output-only | `AssessmentProblem_no_output_only` | 12n |

A **SQL** problem is not. `ioMode = 'SQL'` passes the pin today, and what a
candidate then gets is a C or C++ editor: `loadExamQuestions` chooses ONE
language for the whole paper — the first enabled toolchain language, falling
back to `cpp20` — and `/api/exam/[attemptId]/submit` validates every answer's
language against `Object.keys(LANGUAGE_CATALOG)`, which has never contained
`sql17`. So the question cannot be answered at all: the editor offers a
language the problem refuses, and the submit route would refuse the language
the problem wants. The candidate finds that out during a proctored sitting.

**Slice 1 is the fourth rule of that shape**, and deliberately not more than
that. The alternative — teaching the attempt engine a language per question —
is the right eventual answer for all four kinds at once, and it is an exam
engine change (the layout, the two API routes, the snapshot, the submit, the
marking) that should not be smuggled in behind a SQL bug.

## What the rows got wrong

Two `NOT RUN` rows describe the contest arena as a surface of its own:

- 12k.4, *"A SQL question in a contest or an exam"* — "the arena and the
  attempt surface build their own language list".
- 12l.3, *"An interactive problem in a CONTEST"* — "the contest arena builds
  its own language list and its own result console".

The arena does neither. `contests/[slug]/arena/page.tsx` renders the problem
list, the clock and the score, and its one control is a link to
`/problems/<slug>`: *"The workspace is the same editor you practise in."* So a
contest participant gets the practice surface — the SQL dialect notice, the
interactive conversation, the debug counter, the answer box — because it is
the same React. The 12n migration says exactly this in its own comment, which
is where the correction comes from; the rows were written before it and were
never revisited.

That matters because a wrong `NOT RUN` row costs twice: somebody builds a
surface that already exists, or somebody trusts a lane nobody checked. Slice 2
replaces both rows with what is actually true and what is actually unchecked.

## Slices

**Slice 1 — a SQL problem is not sat in an assessment.** The trigger
`AssessmentProblem_no_sql` and `recx_refuse_sql_assessment_problem`, both
catalogued; the sentence in `admin-assessments.ts` beside the other three; a
database test that the pin is refused on INSERT and on UPDATE; and an action
test for the sentence. No contest rule, for the reason above.

**Slice 2 — read the kinds in a browser, as a student.** The three surfaces
whose only gap is that nobody watched them:

- the debugging counter changing between keystrokes in a real editor (12m.3);
- the SQL grammar under 768 px, which is CodeMirror rather than Monaco
  (12k.4);
- a SQL problem opened from a running contest's arena, which is the lane both
  stale rows are about.

Findings get fixed in the slice that found them, as every live stage in this
phase has done.

## What this phase does not do

- It does not teach the exam attempt engine a language per question. That is
  the one change that would lift all four pin refusals, and it deserves its
  own phase and its own design.
- It does not touch core-CS MCQ. The fence stands and the decision is not
  ours.
- It does not start anything in `deploy/`. Those `NOT RUN` rows need hosts,
  and say so.
