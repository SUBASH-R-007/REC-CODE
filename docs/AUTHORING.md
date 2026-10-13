# REC Code — Problem authoring

This is the guide for faculty and admins who write problems. It covers what
a problem may be, the review flow from draft to published, and the bulk
import package format with its limits.

**Content, not code, is the binding constraint on launch.** The launch
target is **450 originally authored problems: 180 Easy, 200 Medium and
70 Hard**. Owners per difficulty and topic: *TBD by the placement cell*
(recorded as an open question in `docs/OPEN-QUESTIONS.md`).

## 1. What a problem may be

- **Original work only.** Every statement, test, reference solution, hint
  and editorial is written for REC Code. That means faculty, reviewed
  senior-student contributions, or faculty-reviewed AI-assisted drafts.
  Never copy, paste or paraphrase from LeetCode, GeeksforGeeks,
  InterviewBit or anywhere else. Submitting a revision for review requires
  an explicit attestation of this, and it is recorded with the review.
- **What the judge does not accept:**
  - No GPU or machine-learning problems.
  - No multi-process or distributed problems.
  - Nothing that needs more than **15 s** of CPU time or more than
    **1 GB** of memory per test. The time limit runs from 200 ms to 15 s
    and memory from 16 MB to 1,024 MB; the forms, the import and the
    publish gate all refuse anything outside that range.
  - No third-party libraries beyond the vendored toolchains (Python has
    numpy only).
  - No interactive problems yet.
- **Origin.** Each revision records where its content came from: Faculty,
  Senior student (reviewed by faculty), or AI-assisted draft (reviewed by
  faculty).

## 2. The review flow

A problem's content lives in **revisions**. Students only ever see a
published, frozen revision.

| Stage | Meaning | Who moves it on |
|---|---|---|
| Draft | Editable, section by section | The author submits it for review |
| In review | Read-only, waiting for a reviewer | A second admin approves or returns it; anyone can withdraw it |
| Approved | Reviewed; validation passed when it was approved | Any admin publishes it (validation page) |
| Published | The live revision. Frozen, so it can never change | "Create new revision" starts the next draft |
| Superseded | An older published revision; submissions still point at it | — |
| Retired | The problem left the catalogue (super-admin only) | — |

Rules the server enforces (the buttons only help):

- **Only a draft is editable.** To change something in review, withdraw it
  first; that clears any approval.
- **Concurrent edits are caught.** Every form carries the revision's edit
  number. If someone else saved in between, you get a conflict instead of
  silently overwriting their edit.
- **Edits that change judging invalidate validation.** That covers tests,
  subtasks, reference solutions, limits, the input / compare / scoring
  mode, the signature and the checker; run validation again after them.
  Statement, hints, editorial and starter-code edits do not.
- **The approver must be someone else.** They cannot be the revision's
  creator, its last editor or the person who submitted it. Validation must
  be complete and the content free of errors at approval time.
- **Publish needs all of these:**
  - the revision is approved;
  - validation is complete;
  - the content has no errors, including a declared comparator;
  - the problem is not retired;
  - nobody published in the meantime (optimistic concurrency on the
    problem's version number).

  Of two simultaneous publishes, exactly one succeeds and the other is told
  to reload.
- **One open draft per problem.** "Create new revision" returns the
  existing draft if there is one.
- **Old submissions keep their revision.** A submission is pinned to the
  revision it was judged against. Its page shows "Judged against revision N"
  and the statement as it was then.
- **Retiring and deleting** are super-admin operations. Only never-published
  content can be deleted, and only with two-person approval.

## 3. Validation

Validation runs every reference solution on the real judge fleet, on the
REJUDGE lane (at most 20 % of judge slots, so big batches take a while):

1. **Model solutions** (expected AC) run at the 15 s ceiling and must all
   pass. A C++ model (cpp17 or cpp20) is mandatory.
2. **Per-language limits** are derived: 2.5 × the slowest model in each
   language, or the language's fallback multiplier.
3. **Deliberately-wrong solutions** (expected WA, TLE, MLE or RE) run at
   those limits and must fail the way you said. This proves the tests and
   limits separate right from wrong.

A reference in a language that is not enabled is reported, not run. For a
FUNCTION problem, so is one in a language without a function harness (C,
JavaScript, Go, Kotlin).

## 4. Bulk import (package format 1)

Upload a `.zip` on **Problems → Import**, or run the CLI on a directory or a
zip (`docs/RUNBOOK.md` §2.10). Each top-level directory is one problem; one
wrapping folder (`batch/<slug>/…`) is unwrapped.

```
<slug>/
  meta.json            required — see below
  statement.md         required — Markdown, UTF-8, ≤ 64 KB
  editorial.md         optional — ≤ 64 KB
  hints/1.md 2.md 3.md optional — in order, ≤ 8 KB each
  checker.cpp          CHECKER / CUSTOM_CHECKER only — testlib, ≤ 256 KB
  testcases/000.in     paired with 000.out; contiguous from 000; ≤ 1,000 tests
  testcases/000.out
  solutions/…          the files meta.solutions names (≤ 256 KB each)
  starters/…           the files meta.starters names (optional)
```

`meta.json` (strict: unknown keys are errors):

```json
{
  "format": 1,
  "slug": "loud-echo",
  "displayCode": "REC-0101",
  "title": "Loud Echo",
  "difficulty": "EASY",
  "topics": ["STRINGS"],
  "origin": "FACULTY",
  "constraints": ["1 ≤ |w| ≤ 100"],
  "ioMode": "STDIN",
  "functionSignature": null,
  "compareMode": "TOKEN",
  "floatEpsilon": null,
  "scoringMode": "ICPC",
  "stopOnFirstFailure": true,
  "timeLimitMs": 1000,
  "memoryLimitKb": 262144,
  "samples": [0],
  "subtasks": [],
  "solutions": [
    { "file": "solutions/model.cpp", "language": "cpp20", "expected": "AC", "label": "Model" },
    { "file": "solutions/echo.py", "language": "py312", "expected": "WA", "label": "Echo" }
  ],
  "starters": { "py312": "starters/main.py" },
  "checker": null
}
```

- `compareMode` is **required** (TOKEN, EXACT, FLOAT or CHECKER): every
  problem declares its comparator. A FUNCTION problem declares it in
  `functionSignature.comparator` (EXACT, FLOAT_TOLERANCE, SET_EQUAL,
  ROWS_ANY_ORDER, IN_PLACE_MUTATION, CUSTOM_CHECKER). FUNCTION tests must be
  in the canonical form the harness reads (`docs/JUDGE.md`).
- `slug` uses lower-case letters, digits and hyphens. `displayCode` is
  `REC-` plus four digits. Neither can change after creation.
- `topics`: one to four of the fourteen topics, the primary topic first.
- Samples are shown to students, so each sample file must be UTF-8 text of
  at most 64 KB. Hidden tests may be binary and up to 64 MB a file.
- SUBTASK scoring lists `subtasks` with `index`, `points`, optional
  `aggregation` (MIN or SUM_FRACTION) and `dependsOn` (earlier subtasks
  only), plus `tests`. Every test belongs to exactly one subtask.
- PER_TEST scoring may give `points` per test index (`{"3": 10}`); a test
  without points weighs 1.

**Limits per upload:**

| Limit | Value |
|---|---|
| Archive | 256 MB |
| Problems | 500 |
| Files | 50,000 |
| Files per problem | 2,100 |
| One file, inflated | 64 MB |
| One problem, inflated | 512 MB |
| Whole archive, inflated | 4 GB |
| Path length | 200 characters |

Absolute paths, `..`, backslashes, NUL bytes, names that differ only in
case, symbolic links and encrypted entries are refused. Each file's CRC is
checked.

**Results, one row per problem directory:**

| Result | When |
|---|---|
| CREATED | A new problem with draft revision 1 and its topics |
| NEW_REVISION | The live revision differs; a new draft revision is added (topics untouched) |
| UNCHANGED | The same package was imported before (the open draft or the live revision matches) |
| FAILED | Every problem found, each with its file. Also when the problem is retired, its display code is taken or differs, or it has an open draft with other content |

One bad entry never discards the rest. Fix the failed directories and
upload the same archive again: everything already imported comes back
UNCHANGED.

Imported problems arrive as **drafts**. Nothing is validated or published
automatically. Use **Validate imported drafts** on the import page, then
review and publish each one.

A missing C++ model is only a warning at import; publishing still needs one.
