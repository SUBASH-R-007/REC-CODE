# Phase 12m — debugging problems

SPEC §11: *"debugging and output-only problem kinds"*. This is the first of
the two.

---

## 1. What a debugging problem is here

A problem that hands the student a program which is nearly right, and asks
them to **fix it within an edit budget**.

The judging is unchanged: the fixed program runs against the version's
tests like any other STDIN or FUNCTION problem. What is new is the rule
that makes it a debugging problem rather than an ordinary one with a
head start:

> This program has a bug. You may change at most **N lines**.

Without that rule a debugging problem is a problem with a starter — the
student deletes it and writes their own, and the exercise (read somebody
else's code, find the mistake) never happens. The budget is what the
question is actually about.

## 2. The decisions, and why

### 2.1 The budget is a column on the version, and it IS the kind

`ProblemVersion.maxEditedLines` — null for every other problem, a positive
number for a debugging one. No `ProblemKind` enum: a kind that is one rule
is better expressed as that rule, because an enum value invites code to
ask "is this a debugging problem?" in places that should be asking "does
this problem have an edit budget?".

### 2.2 The broken program is the starter code, which already exists

`StarterCode` is per (version, language) and the workspace already opens
it. A debugging problem is therefore a problem whose starter is
deliberately wrong — and it is OFFERED in exactly the languages that have
one, in the picker and at the submit boundary alike, because a language
with no starter would be an empty editor with a two-line budget. (Written
as built: the gate asks for at least one starter rather than one per
enabled language, since the author's starters are what decide the list.)

### 2.3 The count is of CHANGED LINES, and the student sees the same number

One pure function in `@recx/shared`, used by three surfaces: the editor's
live counter, the submit action's refusal, and the publish gate's
sanity check on the author's own fix. A student who is told "you changed
4 lines; this question allows 2" must be able to act on it, so:

* a line is compared **trimmed**, because re-indenting is not a fix;
* **blank lines are ignored entirely**, so a student may space the program
  out while reading it;
* the count is `max(added, removed)` over a line-level diff — the number
  of lines the student had to type: changing one line is 1, deleting three
  is 3, replacing one line with two is 2, and moving a line is 1, because
  one line moved.

### 2.4 Refused before the submission exists

The budget is checked in the submit action, before the row: a submission
that could never be judged on its merits should not cost a student one of
their daily submissions. The run path is checked too, for the same reason
— a Run that silently judged an over-budget program would teach the
student the rule does not apply until it suddenly does.

The judge is NOT the place: it has no starter and no business having one.

### 2.5 What the student is told, and when

* over the editor, always: *"a debugging problem · at most N lines
  changed"*, with the live count beside it as they type;
* in the Description tab, the rule in full, including that blank lines and
  indentation do not count;
* on a refusal, the two numbers.

### 2.6 What this phase does NOT do

* **No per-line locking.** A region the student may not touch is a
  different feature (and a worse one: it needs a parser per language).
* **No diff display.** The editor shows the program; the counter shows the
  distance. A side-by-side against the broken original is a nicety for
  later.
* **No budget on a SQL or interactive problem.** Both are refused: a SQL
  problem's starter is a comment and an interactive one's conversation is
  not a program to repair. The database says so too.

## 3. The slices

| Slice | What | Done when |
|---|---|---|
| 1 | the rule: the shared count, the column and its CHECKs, the submit and run refusals, the authoring field and publish gate | unit tests over the count and the gates; a database test over the CHECKs |
| 2 | not sat in an assessment yet: a trigger on the pin, and the sentence an admin reads | the trigger refuses the pin in a database test |
| 3 | the surface: the chips, the live counter, the statement, the reset label | a student solves one through the running app, and is refused when they rewrite it |

### Why slice 2 exists

The budget is refused in `submitSolution` and `runCode`, before the row.
An assessment does not submit that way: `submitAttempt` writes one
Submission per answered question when the sitting ends, and refusing one
there would throw away a candidate's work at the only moment they can do
nothing about it. A contest needs no rule — its arena sends the student to
the ordinary workspace and its submissions go through `submitSolution`, so
the budget is shown and enforced already.

So the PIN is refused instead, exactly as Phase 12l did for interactive
problems and for the same reason: say it to the person choosing the
question, not to the candidate answering it.
