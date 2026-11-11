# Phase 7 design: aptitude, verbal and logical reasoning

Coordinator working notes. Delete `docs/handoff/phase7/` once Phase 7 is gated.

Source of truth: `docs/handoff/SPEC.md` §5 "Phase 7 — Aptitude, verbal,
logical reasoning", which opens "This is MVP-tier, not a later phase." The
spec gives its own reasons and they decide the shape of this phase: the
majority of REC's 5,000 students are screened by an aptitude round *before*
anyone reads their code, so a platform that is all DSA optimises for the top
decile and ignores the cohort the placement cell is actually worried about;
aptitude content is cheap to author relative to coding problems and already
exists on paper in faculty banks; and the per-section timer and
negative-marking machinery is reused directly by the assessment product.

Phase 7 is therefore a **scoring** phase, not a judging phase. No student code
runs anywhere in it.

## 0. What is already built

Phase 7 is not greenfield. Everything below exists and must **not** be
redesigned or rebuilt.

| Already built | Location |
|---|---|
| `XpEventKind.APTITUDE` and `XpEventKind.MOCK` | `packages/db/prisma/schema.prisma` (enum `XpEventKind`) |
| The aptitude and mock XP constants — `aptitude: { perCorrect: 10, dailyCap: 200 }`, `mock: { base: 100, perPercentileAboveMedian: 1 }` | `packages/shared/src/xp.ts` (`XP_RULES`) — present since Phase 3, **unused**: Phase 7 is what wires them |
| The append-only XP ledger, `XpBucket`, the daily-cap arithmetic and `XP_RULES_VERSION` | `packages/shared/src/xp.ts`, `XpEvent` / `XpBucket` in the schema, and the finalise transaction's advisory-lock pattern |
| `Difficulty`, `ProblemStatus { DRAFT IN_REVIEW PUBLISHED RETIRED }`, `ContentOrigin { FACULTY SENIOR_STUDENT AI_ASSISTED }` | schema; mirrored in `@recx/shared` and held identical by `packages/db/test/enum-parity.test.ts` |
| `ProblemImportStatus { PROCESSING DONE FAILED }`, `ProblemImportRowStatus { CREATED NEW_REVISION UNCHANGED FAILED }` and the whole **per-row import result** pattern | `ProblemImport` / `ProblemImportRow` in the schema; `/admin/problems/import`; `RosterImport.results` |
| An RFC 4180 CSV reader (quoted fields, doubled quotes, embedded newlines, CRLF, BOM) with per-line issues | `apps/web/src/lib/admin/roster-csv.ts` (the record splitter is private; `parseRosterCsv` is roster-specific) and `apps/web/src/lib/admin/roster-plan.ts`; CSV *writing* is `apps/web/src/lib/privileged/csv.ts` (`csvCell`, `csvRow`) |
| `Accommodation` in full — its state machine, SUPER_ADMIN approval, expiry and audit — and the pure helpers `accommodatedDurationSec()`, `accommodationTermsSummary()`, `suggestedExemptSignals()`, `reviewerAccommodationView()` | Phase 4: `Accommodation` in the schema, `packages/shared/src/accommodation.ts`, `/admin/accommodations/**`. Phase 7 only **reads** it |
| `AccommodationKind` (all six kinds) and `ProctorEventKind` (all 25 kinds) | schema; `packages/shared/src/proctor.ts` |
| The server-authoritative clock pattern: `computeExpiresAt()` reporting its own cap, `msRemaining()`, `hasExpired()`, the presence bitmap | Phase 6b: `packages/shared/src/attempt-clock.ts` |
| `Assessment`, `AssessmentProblem`, `ExamSession`, `AssessmentAttempt`, `AttemptSnapshot`, `ProctorEvent` (partitioned monthly), and THE HARD RULE `affectsPlacementEligibility` ⇒ `LAB_SUPERVISED` as CHECK + zod | Phase 6a/6b: schema, `packages/shared/src/assessment.ts`, migrations `20261019140000` and `20261019160000` |
| The database guard fence — static coverage over migration SQL plus a live check | `packages/db/test/support/guard-catalog.ts`, `packages/db/test/frozen-coverage.test.ts`, `packages/db/test/guard-state.db.test.ts` |
| The role × capability matrix, its static and runtime tests, and the generated table in `docs/SECURITY.md` | `apps/web/src/lib/auth/capabilities.ts`, `apps/web/test/capabilities.test.ts`, `apps/web/test/capability-matrix.test.ts` |
| The student-exposure fence (static closure walk + live DB canaries) and the `admin-` / `super-` filename convention that carries it | `tests/repo/student-exposure.test.ts`, `apps/web/test/student-exposure.db.test.ts`, `docs/CONVENTIONS.md` §"Sensitive paths" |
| The forbidden-words fence over every repository text file **and** every commit message | `tests/repo/forbidden-words.test.ts` |
| The shell nav model with an **empty `assess` group already reserved** for Phases 6–7, and `shell-nav.test.ts` failing on any dead link | `apps/web/src/components/shell/nav.ts` |
| Front-end size budgets and the axe gate | `apps/web/size-budgets.json`, `apps/web/scripts/size-budget.mjs`, `apps/web/e2e/a11y.spec.ts`, `docs/ACCESSIBILITY.md` §6 |
| The content-purity fence: `apps/web/scripts/content/**` may import only `@recx/shared` | `tests/repo/content-purity.test.ts` |
| The recorded content target — "~2,000 aptitude questions, with named owners", nothing scraped | `docs/OPEN-QUESTIONS.md` §"Content is the binding constraint" |

Missing: every model and enum in §3 below, every pure module in §4, and every
route in §5.

**Files other phases are working in right now.** `packages/db/prisma/schema.prisma`,
`packages/shared/src/index.ts`, `apps/web/src/lib/auth/capabilities.ts`,
`apps/web/src/components/shell/nav.ts` and `packages/db/test/support/guard-catalog.ts`
are all touched by Phase 6c–6e (`packages/shared/src/exam-protocol.ts` appeared
while this design was being written). Every Phase 7 slice edits some of them.
Rebase before each slice and add lines rather than reflowing neighbours.

## 1. Key decisions

1. **Its own schema, not a `Problem` kind.** The spec's reason, carried
   across: *section timers, cutoffs and negative marking do not fit the
   judging schema*. Concretely — `ProblemVersion` freezes because test bytes
   and limits must be immutable for a judge; an aptitude question has no test
   data, no language limits and no verdict, and its scoring is a signed
   rational number rather than a comparator outcome. Forcing it into
   `Problem` would mean a frozen-version clone per typo fix, a `liveVersionId`
   nobody needs, and `IoMode` / `CompareMode` / `ScoringMode` columns that are
   meaningless on every row. The two schemas touch at exactly two points: the
   `Difficulty`, `ProblemStatus` and `ContentOrigin` enums are reused, and XP
   lands in the one existing ledger.
2. **Reuse an enum only when every one of its values is meaningful.** This is
   Phase 6a's rule (it refused `ContestStatus` for assessments because "a test
   is never RATED"), applied both ways. `ProblemStatus`,
   `ProblemImportStatus`, `ProblemImportRowStatus`, `Difficulty` and
   `ContentOrigin` are reused verbatim. `AttemptStatus` is **not**: it carries
   `TERMINATED` and `VOIDED`, which are invigilator outcomes. A practice mock
   has no invigilator, so `MockAttemptStatus` has no such value — and that is
   the point: with no `VOIDED` value in the enum, no future code path and no
   future UI can void a mock automatically. It is the same technique Phase 6a
   used to keep a `void` option out of `FocusLimitAction`.
3. **No signal ever auto-penalises a student, and Phase 7 has no signals at
   all.** A practice mock is not proctored: it writes no `ProctorEvent`, reads
   no `IntegrityFlag`, and touches nothing in `apps/web/src/lib/flags.ts`. The
   only automatic actions in the phase are *closing a section at its own
   deadline* and *finalising an attempt at `expiresAt`* — both deadlines, not
   penalties. The maximum automatic consequence anywhere in the system stays
   flag for review and withhold from the public leaderboard, and nothing here
   reaches even that. A static test proves the aptitude action closure never
   reaches the flagging modules (§6.13).
4. **Mandatory worked explanations, enforced at publish in the data.** The
   spec says "Worked explanations are mandatory, enforced at publish". A zod
   refinement in the publish action is the obvious place, and it is not
   enough: `CHECK AptitudeQuestion_explanation_published` requires a
   PUBLISHED row to carry at least 40 trimmed characters of `explanation`, so
   the rule holds against a back-fill script, a raw SQL fix and a future
   second publish path. 40 characters is the floor that stops "use the
   formula" shipping as a worked explanation. The explanation is the product
   here: a student who got a percentage question wrong needs the working, not
   a tick.
5. **The negative mark is a *fraction* of `marksPerCorrect`, never an
   absolute mark.** `CHECK AptitudeSection_negative_check` holds it in
   `[0, 1]`. The authoring mistake this prevents is a 2-mark penalty on a
   1-mark question, which makes a mock strictly harsher than the funnel it
   claims to model — and a mock that is harsher than the real test teaches the
   student the wrong thing about their own readiness.
6. **An unanswered question is never negative.** This is the single line in
   the phase most likely to be written wrongly, so it is a pure function with
   a table-driven test over all six seeded patterns: `gradeAnswer()` returns
   `+marksPerCorrect` for a correct response, `−negativeMarkFraction ×
   marksPerCorrect` for an *answered* wrong response, and exactly `0` for an
   unanswered one. Every published funnel this phase models works that way,
   and the opposite would punish a student for the honesty of leaving a guess
   out.
7. **A recruiter funnel is a conjunction of gates, not an average.**
   `scoreMock()` passes a candidate only when *every* section clears its own
   `cutoffPercent` and, if the pattern sets one, the overall percent clears
   `overallCutoffPercent`. A candidate at 90% quant and 10% verbal is screened
   out by the real funnel; a mock that averaged them to 50% and said "pass"
   would tell them the exact opposite of the truth, which is the whole reason
   the placement cell wants this round simulated.
8. **`allowBackNavigation: false` is enforced on the server and in the data,
   and the gate test never touches the UI.** The spec asks for exactly this.
   Three fences: `canAnswer()` in `@recx/shared` (pure, called by the answer
   action); `MockSectionState.highWaterIndex`, a server-written column the
   client cannot move backwards; and the trigger
   `recx_refuse_closed_section_write`, which refuses any answer insert or
   update for a section whose `submittedAt` is set. The gating test calls the
   server action directly with an index below the high-water mark, and a
   second test attempts the same write as raw SQL.
9. **The section clock is server-authoritative, like Phase 6's attempt
   clock.** `MockSectionState.endsAt` is computed server-side on section entry
   and written once; the client renders `msRemainingInSection` from
   `GET /api/aptitude/attempts/[id]/clock` and never consults `Date.now()`.
   A section deadline is like an assessment deadline and unlike a contest
   deadline: the attempt *ends*, so an advisory clock is not an option.
   `sectionEndsAt()` is capped by the attempt's own `expiresAt` and **reports**
   the cap rather than silently applying it, the same honesty
   `computeExpiresAt()` already practises for accommodations.
10. **Extra time flows through the accommodation helper that already
    exists.** `mockExpiresAt()` calls `accommodatedDurationSec()` from
    `packages/shared/src/accommodation.ts`. Extra time is applied to the
    *whole paper* and distributed to sections in proportion to their own
    limits, so a candidate granted 25% extra time gets 25% more in every
    section rather than all of it in the last one.
11. **The per-candidate paper is a seeded, reproducible layout.**
    `MockAttempt.seed` plus `buildMockLayout()` reproduce the exact paper —
    question order and option permutation — that a candidate saw. Phase 6b
    stored a seed for the same reason: a disputed paper has to be
    reconstructable. Passage-grouped questions move as a block and never cross
    a section boundary.
12. **Selections are stored in the question's own option order.** The server
    maps the shown index back through the permutation before writing
    `MockAttemptAnswer.selectedIndexes`, so re-grading a question after a
    shuffle change is still correct and an answer row is readable without the
    layout.
13. **One row per answered question is the right shape here.** SPEC §7 forbids
    one row per *test case* because those rows are "almost-never-read" and run
    to 150–400M a year. These rows are the opposite: 5,000 students × ~120
    questions × ~6 mocks is ≈3.6M rows a year, and every one is read — by the
    explanation view, by the per-question pacing display, and by the
    `AptitudeUserTopicStat` roll-up the Phase 8 weakness heatmap depends on.
14. **Analytics read maintained rows, never aggregates.** SPEC §4(d)'s rule
    ("no page may aggregate `XpEvent`") generalises. `AptitudeQuestionStat`
    (per question) and `AptitudeUserTopicStat` (per user × topic) are upserted
    inside the finalise transaction with `{ increment: n }`, so the student's
    topic view and Phase 8's `aptitudePercentile` / `verbalPercentile` /
    "aptitude section-level gaps" are an index scan, not a scan over
    `MockAttemptAnswer`.
15. **The percentile term in mock XP waits for data.** `XP_RULES.mock` is
    `base: 100 + 1 per percentile above median`, which needs a cohort.
    `MockPattern.finalizedAttemptCount` and `medianPercent` are maintained by
    the nightly job; below `MOCK_PERCENTILE_MIN_ATTEMPTS = 30` only the base is
    awarded and the UI says the percentile is not meaningful yet. This carries
    SPEC §7's reasoning about contest ratings ("not meaningful before ~8–12
    contests") to a ledger row that is permanent once written.
16. **XP is keyed so a re-sit cannot farm it.** `XP_KEYS.aptitude(userId,
    questionId)` = `aptitude:{userId}:{questionId}` pays once per question,
    ever, on the first correct answer in topic practice;
    `XP_KEYS.mock(mockAttemptId)` = `mock:{mockAttemptId}` pays once per
    finalise and is idempotent under a retried finalise. `XpEvent.idempotencyKey`
    is unique, so the ledger itself is the enforcement. The 200/day aptitude
    cap is read-then-write, so finalise takes
    `pg_advisory_xact_lock(hashtext('user:' || userId))` first, exactly as the
    judge finalise does.
17. **A published question's key is frozen; its explanation is not.** Trigger
    `recx_refuse_published_question_change` holds `stem`, `options`,
    `correctOptionIndexes`, `numericAnswer`, `numericTolerance`, `kind`, `area`
    and `topic` immutable once `status = PUBLISHED`; `explanation`, `status →
    RETIRED` and the review fields stay writable. This is the frozen-version
    reasoning from SPEC §4(a) applied to a much cheaper object: students have
    already been scored on that question, so rewriting its key silently
    rescores the past, while improving the wording of the worked solution
    harms nobody. A RETIRED question is never deleted — answer rows reference
    it, and past percentiles must stay honest.
18. **A pattern that has been sat is frozen.** Trigger
    `recx_refuse_used_pattern_change` refuses any change to a `MockPattern`'s
    sections — and any section insert or delete — once a finalised
    `MockAttempt` exists for it. Phase 6a froze a published assessment's
    window for the same reason: a score must mean what it meant when the
    candidate sat it, and a cohort percentile is only honest if everyone sat
    the same blueprint.
19. **The "modelled on" label is one shared constant, not per-row copy.** The
    spec requires every seeded pattern to be labelled in the UI "modelled on
    the publicly described pattern — not an official test." `MODELLED_ON_NOTICE`
    lives in `packages/shared/src/mock-pattern.ts` and is rendered by one
    component wherever a pattern name appears — the card, the cover page and
    the result page. An editable per-row disclaimer column would be a per-row
    opportunity to delete the disclaimer. The free-text column `sourceNote`
    holds the provenance instead ("the publicly described TCS NQT funnel"),
    and a CHECK requires it non-empty. Nothing here is scraped: the patterns
    are shapes (section order, counts, minutes, cutoffs), and every question
    is authored at REC from faculty banks that already exist on paper.
20. **The answer key is a new class of student-unreachable data, and it gets
    its own fence.** `correctOptionIndexes`, `numericAnswer`,
    `numericTolerance` and `explanation` must not reach a student before they
    have answered. The Phase 4 student-exposure fence knows nothing about
    these columns, so Phase 7 adds `APTITUDE_PUBLIC_SELECT` /
    `APTITUDE_ANSWER_SELECT` in `apps/web/src/server/queries/aptitude-select.ts`
    and a **new** static test `tests/repo/aptitude-answer-exposure.test.ts`
    (a new file, so no collision with the existing fence) requiring every
    `aptitudeQuestion` read in a student entry's closure to use the public
    select, plus a live canary. Hiding the key only in the component is not a
    fence.
21. **Reuse the import pipeline's *shape*, per-row results included.** The
    spec: "so one bad row cannot discard a 300-question file."
    `AptitudeImport` / `AptitudeImportRow` mirror `ProblemImport` /
    `ProblemImportRow` field for field, including the reused status enums and
    the per-row `errors` / `warnings` jsonb that reports *every* problem in a
    row rather than the first. The RFC 4180 reader already in
    `roster-csv.ts` is lifted into `packages/shared/src/csv.ts` unchanged, with
    the existing `roster-csv` unit tests left untouched as the proof the move
    was behaviour-preserving.
22. **A practice mock works at 375px; a proctored one does not.** SPEC §7
    forbids the contest arena and a proctored attempt below 768px, because a
    phone-based proctored exam has no meaningful focus or fullscreen
    guarantees. A practice mock is neither: reading a passage and tapping an
    option is the one thing a phone is genuinely good at, and the students who
    most need the aptitude round are the likeliest to be on a phone. So
    `/aptitude`, `/aptitude/[topic]` and the practice sitting are fully
    supported at 375px, and the 768px floor applies only if a pattern is ever
    attached to an `Assessment` (§7.5).

## 2. Sequencing

Five slices. Each one is green on all four gates — `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, each run on its own with its exit code and test
counts read (`docs/CONVENTIONS.md`: a pnpm version-switch failure exits 0 while
running nothing) — before the next begins. Only 7e closes the phase.

| Slice | Contents |
|---|---|
| **7a The question bank** | the enums `AptitudeArea`, `AptitudeTopic` (29 members), `AptitudeQuestionKind`, `MockPatternStatus`, `MockAttemptStatus`; models `AptitudePassage`, `AptitudeQuestion`, `AptitudeQuestionStat`; every CHECK in §3.1–3.3 including the explanation-at-publish CHECK, the area↔topic CHECK and the per-kind answer-shape CHECKs; the triggers `recx_refuse_published_question_change` and the two `_no_truncate` statement triggers; `guard-catalog.ts` entries; `aptitude-taxonomy.ts` and `aptitude-question.ts` in `@recx/shared`; enum parity. No UI, no routes. |
| **7b Patterns and the arithmetic** | models `MockPattern`, `AptitudeSection`; the totals trigger `recx_sync_pattern_totals` and the immutability trigger `recx_refuse_used_pattern_change`; `aptitude-grading.ts` and `mock-pattern.ts` with `MODELLED_ON_NOTICE`; the six seed patterns as pure data under `apps/web/scripts/content/aptitude/patterns.ts` (the content-purity fence applies: `@recx/shared` only); **the §6.1 gate test** over all six patterns. Still no UI. |
| **7c The sitting engine** | models `MockAttempt`, `MockSectionState`, `MockAttemptAnswer`, `AptitudeUserTopicStat`; the trigger `recx_refuse_closed_section_write`; `mock-clock.ts`, `mock-navigation.ts`, `mock-layout.ts`; `src/server/actions/aptitude.ts` (start, answer, advance section, finalise) and `GET /api/aptitude/attempts/[id]/clock`; the finalise transaction with the advisory lock, the stat upserts and the XP ledger rows; `XP_KEYS.aptitude` / `XP_KEYS.mock` and `aptitudeXp()` / `mockXp()` added to `xp.ts`; the `aptitude.sit` self-service capability. **The §6.2 gate test** — the action and the raw-SQL trigger, never the UI. No pages yet. |
| **7d Authoring and the CSV pipeline** | `packages/shared/src/csv.ts` (the reader lifted out of `roster-csv.ts`) and `aptitude-csv.ts`; models `AptitudeImport`, `AptitudeImportRow`; `/admin/aptitude/**` and `/admin/aptitude/patterns/**` with `admin-aptitude*.ts` queries and actions; import with per-row results and export; the `aptitude.authoring` staff capability and the lifecycle binding; `aptitude-select.ts` and the new answer-exposure fence; `docs/AUTHORING.md` gains an aptitude section. |
| **7e The student surface** | `/aptitude`, `/aptitude/[topic]`, `/aptitude/mock/[slug]`, `/aptitude/mock/attempt/[id]`, `/aptitude/mock/attempt/[id]/review`; the section timer, the question palette, the option groups and the explanation view to §6's accessibility requirements; the `assess` nav group's first entries and the `aptitude` `NavIconKey`; topic-practice XP; two new `size-budgets.json` routes; the new axe rows; the manual sitting. |

Content authoring runs alongside and does not gate a slice: the spec's ~2,000
questions are a content programme with named owners (`docs/OPEN-QUESTIONS.md`),
not a code deliverable. 7d ships the pipeline that makes them cheap to load.

## 3. New Prisma models and enums

Column names are the names to use. Every CHECK and trigger below is a
hand-written migration statement and gets a line in
`packages/db/test/support/guard-catalog.ts`, a static row in
`frozen-coverage.test.ts` and a live row in `guard-state.db.test.ts`.
Migrations: `20261019220000_phase7a_question_bank`,
`20261019220100_phase7b_patterns`, `20261019220200_phase7c_sitting`,
`20261019220300_phase7d_import`. (Phase 6 has taken everything up to
`20261019180000_phase6b_heartbeat` and is still adding; check
`packages/db/prisma/migrations/` and move the prefix forward rather than
reusing a timestamp a sibling phase has claimed.)

### 3.1 Enums

```prisma
enum AptitudeArea { QUANTITATIVE LOGICAL VERBAL }

enum AptitudeTopic {
  // QUANTITATIVE (14)
  PERCENTAGES
  PROFIT_LOSS
  TIME_SPEED_DISTANCE
  TIME_AND_WORK
  RATIO_PROPORTION
  AVERAGES_MIXTURES
  PERMUTATIONS_COMBINATIONS
  PROBABILITY
  NUMBER_SYSTEMS
  INTEREST
  AGES
  CALENDARS_CLOCKS
  MENSURATION
  DATA_INTERPRETATION
  // LOGICAL (9)
  SERIES
  BLOOD_RELATIONS
  SYLLOGISMS
  SEATING_ARRANGEMENT
  PUZZLES
  CODING_DECODING
  DATA_SUFFICIENCY
  DIRECTIONS
  STATEMENT_CONCLUSION
  // VERBAL (6)
  READING_COMPREHENSION
  SENTENCE_CORRECTION
  PARA_JUMBLES
  SYNONYMS_ANTONYMS
  CLOZE
  ERROR_SPOTTING
}

enum AptitudeQuestionKind { SINGLE_CHOICE MULTI_CHOICE NUMERIC_ENTRY PASSAGE_GROUPED }

enum MockPatternStatus { DRAFT PUBLISHED ARCHIVED }

/// No TERMINATED, no VOIDED: a practice mock has no invigilator, and an enum
/// with no voiding value is an enum no future code path can void from.
enum MockAttemptStatus { IN_PROGRESS SUBMITTED AUTO_SUBMITTED ABANDONED }
```

The 29 topics are the spec's own prose list, one enum member each, mirrored in
`packages/shared/src/aptitude-taxonomy.ts` and held identical by
`enum-parity.test.ts`. Spellings are this phase's choice and go to the
placement cell (§7.7), exactly as the 14 problem topics did.

### 3.2 `AptitudePassage`

`id`, `area`, `topic`, `title`, `body String @db.Text` (markdown, sanitised
server-side through the existing `sanitize.ts`), `wordCount Int`,
`sourceNote String`, `origin ContentOrigin`, `authorId`,
`status ProblemStatus @default(DRAFT)`, `createdAt`, `updatedAt`,
`questions AptitudeQuestion[]`.

- `CHECK AptitudePassage_body_check`: `char_length(body)` between 80 and 20000
  — a passage shorter than 80 characters is a stem, not a passage.
- `CHECK AptitudePassage_word_count_check`: `wordCount >= 0`.
- `trigger AptitudePassage_no_truncate`.

### 3.3 `AptitudeQuestion`

`id`, `displayCode String @unique` (`APT-00042`, the `Problem.displayCode`
convention), `area AptitudeArea`, `topic AptitudeTopic`,
`kind AptitudeQuestionKind`, `difficulty Difficulty`,
`status ProblemStatus @default(DRAFT)`, `passageId String?`,
`stem String @db.Text`, `options String[] @default([])`,
`correctOptionIndexes Int[] @default([])`,
`numericAnswer Decimal? @db.Decimal(20, 6)`,
`numericTolerance Decimal? @db.Decimal(20, 6)`, `numericUnit String?`,
`explanation String @db.Text @default("")`, `expectedSeconds Int`,
`origin ContentOrigin`, `sourceBatch String?`, `authorId`, `reviewedById String?`,
`publishedAt DateTime?`, `retiredAt DateTime?`,
`contentHash String` (sha256 of the normalised stem + options + key, the
import's duplicate detector), `createdAt`, `updatedAt`.

Indexes: `[status, area, topic]` (the only authoring/pool query shape),
`[topic, difficulty, status]` (the blueprint draw), `[contentHash]`,
`[passageId]`.

Database-enforced invariants:

- `CHECK AptitudeQuestion_explanation_published`:
  `status <> 'PUBLISHED' OR char_length(btrim(explanation)) >= 40` —
  decision 4. The spec's "enforced at publish", enforced where a back-fill
  script cannot step around it.
- `CHECK AptitudeQuestion_area_topic_check`: an explicit per-area `topic IN
  (…)` disjunction over the three areas. A VERBAL question tagged
  `MENSURATION` would silently corrupt every section blueprint and every
  weakness heatmap, and the mapping is immutable, so it belongs in a CHECK and
  not in a trigger.
- `CHECK AptitudeQuestion_passage_kind`:
  `(passageId IS NOT NULL) = (kind = 'PASSAGE_GROUPED')` — the kinds and the
  passage link are one fact stated twice, so they are held consistent
  (narrower reading, §7.1).
- `CHECK AptitudeQuestion_choice_shape`: for `SINGLE_CHOICE`, `MULTI_CHOICE`
  and `PASSAGE_GROUPED` — `array_length(options, 1) BETWEEN 2 AND 8` and
  `numericAnswer IS NULL` and `numericTolerance IS NULL`.
- `CHECK AptitudeQuestion_single_answer`: `kind IN ('SINGLE_CHOICE',
  'PASSAGE_GROUPED')` ⇒ `array_length(correctOptionIndexes, 1) = 1`.
- `CHECK AptitudeQuestion_multi_answer`: `kind = 'MULTI_CHOICE'` ⇒
  `array_length(correctOptionIndexes, 1) BETWEEN 2 AND array_length(options, 1)`.
  A multi-choice with one correct option is a mis-authored single-choice, and
  it makes the all-or-nothing rule indistinguishable from single-choice
  scoring.
- `CHECK AptitudeQuestion_numeric_shape`: `kind = 'NUMERIC_ENTRY'` ⇒
  `numericAnswer IS NOT NULL AND numericTolerance IS NOT NULL AND
  numericTolerance >= 0 AND options = '{}' AND correctOptionIndexes = '{}'`.
- `CHECK AptitudeQuestion_option_index_check`:
  `recx_aptitude_option_indexes_valid(correctOptionIndexes, options)` — an
  `IMMUTABLE` SQL function (a CHECK may call one; it may not contain a
  subquery) asserting every index is in `[0, array_length(options,1) - 1]` and
  that the indexes are distinct. An out-of-range key is a question nobody can
  answer correctly.
- `CHECK AptitudeQuestion_expected_seconds_check`: `expectedSeconds` between
  5 and 1800 — it is the authoring aid that tells a section author whether
  25 questions fit in 25 minutes.
- `trigger AptitudeQuestion_published_immutable`
  (`recx_refuse_published_question_change`): decision 17.
- `trigger AptitudeQuestion_no_truncate`.

### 3.4 `AptitudeQuestionStat`

`questionId String @id`, `timesServed Int @default(0)`,
`timesCorrect Int @default(0)`, `timesAnswered Int @default(0)`,
`totalSeconds Int @default(0)`, `lastServedAt DateTime?`, `updatedAt`.

- `CHECK AptitudeQuestionStat_counts_check`: all four counters `>= 0`,
  `timesAnswered <= timesServed`, `timesCorrect <= timesAnswered`.
- Maintained with `{ increment: n }` inside finalise; never computed on read
  (decision 14). It is how a dud question — 99% correct, or 3% correct — gets
  found and retired.

### 3.5 `MockPattern`

`id`, `slug String @unique`, `name`, `funnelLabel String`,
`sourceNote String`, `status MockPatternStatus @default(DRAFT)`,
`overallCutoffPercent Float?`, `totalQuestions Int @default(0)`,
`totalTimeSec Int @default(0)`, `finalizedAttemptCount Int @default(0)`,
`medianPercent Float?`, `createdById`, `createdAt`, `updatedAt`,
`sections AptitudeSection[]`, `attempts MockAttempt[]`.

Six seeded patterns: the publicly described TCS NQT, Infosys, Wipro,
Cognizant and Accenture funnels, plus `campus-generic`.

- `CHECK MockPattern_source_note_check`: `char_length(btrim(sourceNote)) >= 10`.
  A pattern with no stated provenance is a pattern nobody can check.
- `CHECK MockPattern_cutoff_check`: `overallCutoffPercent` null or in
  `[0, 100]`.
- `CHECK MockPattern_totals_check`: `totalQuestions >= 0`,
  `totalTimeSec >= 0`, `finalizedAttemptCount >= 0`, `medianPercent` null or
  in `[0, 100]`.
- `trigger MockPattern_totals_sync` (`recx_sync_pattern_totals`), AFTER
  INSERT/UPDATE/DELETE on `AptitudeSection`: recomputes `totalQuestions` and
  `totalTimeSec` as the sums over the pattern's sections. The listing page
  must not aggregate to render (decision 14), and a denormalised total nobody
  maintains drifts.
- `trigger MockPattern_no_truncate`.

### 3.6 `AptitudeSection`

`id`, `patternId`, `position Int` (1-based), `label String`,
`area AptitudeArea?` (null = mixed), `topicMix Json` (`[{ topic, count }]`,
the blueprint), `questionCount Int`, `timeLimitSec Int`,
`cutoffPercent Float @default(0)`, `marksPerCorrect Float @default(1)`,
`negativeMarkFraction Float @default(0)`,
`allowBackNavigation Boolean @default(true)`,
`shuffleQuestions Boolean @default(true)`,
`shuffleOptions Boolean @default(true)`, `createdAt`.

- `@@unique([patternId, position])`, `@@unique([patternId, label])`.
- `CHECK AptitudeSection_count_check`: `questionCount` between 1 and 100.
- `CHECK AptitudeSection_time_check`: `timeLimitSec` between 60 and 7200.
- `CHECK AptitudeSection_cutoff_check`: `cutoffPercent` in `[0, 100]`.
- `CHECK AptitudeSection_marks_check`: `marksPerCorrect > 0`.
- `CHECK AptitudeSection_negative_check`: `negativeMarkFraction` in `[0, 1]`
  — decision 5.
- `trigger AptitudeSection_pattern_frozen` (`recx_refuse_used_pattern_change`):
  decision 18. The trigger is on `AptitudeSection` for INSERT, UPDATE and
  DELETE, and on the scoring columns of `MockPattern`.
- `trigger AptitudeSection_no_truncate`.
- `topicMix` is validated by `mockSectionSchema` at the server boundary: its
  counts sum to `questionCount` and every topic belongs to `area` when `area`
  is set. The jsonb shape is zod's job; the scalar ranges above are the
  database's.

### 3.7 `MockAttempt`

`id`, `patternId`, `userId`, `attemptNumber Int @default(1)`,
`status MockAttemptStatus @default(IN_PROGRESS)`, `seed Int`,
`startedAt DateTime @default(now())`, `expiresAt DateTime`,
`currentSectionPosition Int @default(1)`, `layout Json`,
`accommodationFlags String[] @default([])`, `totalRaw Float @default(0)`,
`totalMax Float @default(0)`, `percent Float @default(0)`,
`sectionsPassed Int @default(0)`, `passedOverall Boolean?`,
`percentileAtFinalise Float?`, `finalizedAt DateTime?`,
`version Int @default(0)`, `createdAt`, `updatedAt`,
`sectionStates MockSectionState[]`, `answers MockAttemptAnswer[]`.

- `@@unique([patternId, userId, attemptNumber])`.
- `@@index([userId, startedAt(sort: Desc)])`, `@@index([status, expiresAt])`
  (the auto-finalise sweeper), `@@index([patternId, percent(sort: Desc)])`
  (the percentile job).
- `CHECK MockAttempt_window_check`: `expiresAt > startedAt`.
- `CHECK MockAttempt_number_check`: `attemptNumber >= 1`.
- `CHECK MockAttempt_score_check`: `totalMax >= 0`, `percent` in `[0, 100]`,
  `sectionsPassed >= 0`. `totalRaw` is deliberately **not** floored at 0: the
  honest total of a negatively marked paper can be negative, and it is
  `percent` that is clamped (§7.2).
- `CHECK MockAttempt_finalised_check`: a `SUBMITTED` or `AUTO_SUBMITTED` row
  carries `finalizedAt` and `passedOverall`, and no other status does.
- `CHECK MockAttempt_section_position_check`: `currentSectionPosition >= 1`.
- `trigger MockAttempt_clock_written_once` (`recx_refuse_mock_attempt_change`):
  `startedAt`, `expiresAt`, `seed`, `layout`, `patternId` and `userId` never
  change after insert, and `status` follows `canTransitionMock()` — the same
  "the clock is written once" guard Phase 6b put on `AssessmentAttempt`.
- `trigger MockAttempt_no_truncate`.

### 3.8 `MockSectionState`

`id`, `attemptId`, `sectionId`, `position Int`, `startedAt DateTime?`,
`endsAt DateTime?`, `submittedAt DateTime?`, `highWaterIndex Int @default(0)`,
`correctCount Int @default(0)`, `wrongCount Int @default(0)`,
`unansweredCount Int @default(0)`, `rawScore Float @default(0)`,
`maxScore Float @default(0)`, `percent Float @default(0)`,
`passedCutoff Boolean?`, `createdAt`, `updatedAt`.

A row, not a jsonb blob on the attempt: it is the authoritative gate every
answer write reads, and a read-modify-write of a jsonb document is the wrong
concurrency shape for that.

- `@@unique([attemptId, sectionId])`, `@@unique([attemptId, position])`.
- `CHECK MockSectionState_window_check`: `endsAt` null or `> startedAt`.
- `CHECK MockSectionState_index_check`: `highWaterIndex >= 0`.
- `CHECK MockSectionState_counts_check`: the three counters `>= 0`,
  `maxScore >= 0`, `percent` in `[0, 100]`.
- `CHECK MockSectionState_started_check`: `submittedAt IS NULL OR startedAt IS
  NOT NULL` — a section cannot close before it opens.
- `trigger MockSectionState_clock_written_once`: `startedAt` and `endsAt` are
  each written once and never move afterwards. A section clock a later write
  can extend is not a section clock.

### 3.9 `MockAttemptAnswer`

`id`, `attemptId`, `sectionStateId`, `questionId`, `position Int` (index
within the section as served), `selectedIndexes Int[] @default([])` (in the
question's **own** option order — decision 12), `numericValue Decimal? @db.Decimal(20, 6)`,
`markedForReview Boolean @default(false)`, `isCorrect Boolean?`,
`awarded Float?`, `firstSeenAtMs Int`, `answeredAtMs Int?`,
`changeCount Int @default(0)`, `createdAt`, `updatedAt`.

- `@@unique([attemptId, questionId])`, `@@unique([attemptId, sectionStateId, position])`.
- `@@index([questionId])` (the stat roll-up).
- `CHECK MockAttemptAnswer_shape_check`: not both `selectedIndexes <> '{}'`
  and `numericValue IS NOT NULL` — one response shape per answer; both empty
  means unanswered, which is a legitimate and non-negative state.
- `CHECK MockAttemptAnswer_timing_check`: `firstSeenAtMs >= 0`,
  `answeredAtMs` null or `>= firstSeenAtMs`, `changeCount >= 0`.
- `CHECK MockAttemptAnswer_graded_check`: `isCorrect` and `awarded` are set
  together or both null — a half-graded answer row is how a total stops adding
  up.
- `trigger MockAttemptAnswer_closed_section`
  (`recx_refuse_closed_section_write`): refuses any INSERT or UPDATE for a
  `sectionStateId` whose `submittedAt` is set, and — when the section's
  `allowBackNavigation` is false — any INSERT or UPDATE at a `position` below
  that section's `highWaterIndex`. This is the data half of decision 8, and
  the §6.2 gate test exercises it by raw SQL.
- `trigger MockAttemptAnswer_no_truncate`.

### 3.10 `AptitudeUserTopicStat`

`userId`, `topic AptitudeTopic`, `attempted Int @default(0)`,
`correct Int @default(0)`, `totalSeconds Int @default(0)`,
`lastAttemptedAt DateTime?`, `updatedAt`; `@@id([userId, topic])`,
`@@index([topic, correct])`.

- `CHECK AptitudeUserTopicStat_counts_check`: all `>= 0` and
  `correct <= attempted`.
- Maintained in the finalise transaction and by the topic-practice action.
  It is what Phase 8's `aptitudePercentile`, `verbalPercentile` and
  "aptitude section-level gaps" read, and what makes the department-level
  weakness view an index scan rather than a scan over answers.

### 3.11 `AptitudeImport` / `AptitudeImportRow`

Field for field the `ProblemImport` / `ProblemImportRow` shape, with
`ProblemImportStatus` and `ProblemImportRowStatus` reused.

`AptitudeImport`: `id`, `uploadedById`, `fileName`, `sizeBytes BigInt`,
`fileSha256`, `via String` (`"upload" | "cli:<operator>"`),
`status ProblemImportStatus @default(PROCESSING)`, `total Int @default(0)`,
`created`, `updated`, `unchanged`, `failed`, `error String?`, `startedAt`,
`finishedAt DateTime?`, `rows AptitudeImportRow[]`;
`@@index([uploadedById, startedAt(sort: Desc)])`.

- `CHECK AptitudeImport_counts_check`: every counter `>= 0` and
  `created + updated + unchanged + failed <= total`.

`AptitudeImportRow`: `id`, `importId`, `line Int`,
`status ProblemImportRowStatus`, `questionId String?`, `displayCode String?`,
`contentHash String?`, `errors Json @default("[]")`,
`warnings Json @default("[]")`, `createdAt`; `@@unique([importId, line])`.

- `CHECK AptitudeImportRow_line_check`: `line >= 1`.
- A row is written as soon as that line commits or fails, so a 300-question
  file with three bad rows imports 297 and reports three — the spec's
  requirement, and the reason the counters live on the parent while the
  reasons live on the rows.

## 4. The pure modules in `packages/shared`

Anything that is arithmetic, policy or ordering is a pure module with its own
unit test, not logic inside a component or a query. New files only; each is
re-exported from `packages/shared/src/index.ts` (contended — add a line, do
not reflow).

| Module | Exports | Why it is pure |
|---|---|---|
| `aptitude-taxonomy.ts` | `APTITUDE_AREAS`, `APTITUDE_TOPICS` (29), `APTITUDE_TOPIC_AREA`, `APTITUDE_TOPIC_LABEL`, `APTITUDE_AREA_LABEL`, `topicsOfArea()`, `areaOfTopic()`, `isAptitudeTopic()` | The single definition of the taxonomy, mirrored by the Prisma enums and held identical by `enum-parity.test.ts`. The area↔topic CHECK is generated from `APTITUDE_TOPIC_AREA`, so there is one list, not two. |
| `aptitude-question.ts` | `APTITUDE_QUESTION_KINDS`, `aptitudeQuestionSchema` (a zod discriminated union on `kind`), `EXPLANATION_MIN_CHARS = 40`, `APTITUDE_LIMITS` (option count 2–8, stem 4 KB, explanation 8 KB, `expectedSeconds` 5–1800), `normaliseQuestionForHash()`, `questionContentHash()` | One shape definition for the server boundary, the CSV importer and the authoring form. Its refinements mirror §3.3's CHECKs one for one, and a test asserts each refinement has a CHECK and each CHECK has a refinement. |
| `aptitude-grading.ts` | `gradeAnswer()`, `scoreSection()`, `scoreMock()`, `sectionPercent()`, `NUMERIC_COMPARE_SCALE` | The arithmetic the whole phase is gated on: negative marking, the never-negative unanswered rule (decision 6), all-or-nothing multi-choice, `|value − answer| <= tolerance` compared at a fixed decimal scale and never with float equality, per-section cutoffs, and the conjunction-of-gates overall rule (decision 7). |
| `mock-pattern.ts` | `mockPatternSchema`, `mockSectionSchema`, `MODELLED_ON_NOTICE`, `SEED_PATTERN_SLUGS`, `patternTotals()`, `patternBlueprintIssues()` | `patternTotals()` is the arithmetic the `recx_sync_pattern_totals` trigger mirrors; a test asserts the two agree on all six seed patterns. `MODELLED_ON_NOTICE` is the one place the required label is spelled (decision 19). |
| `mock-clock.ts` | `mockExpiresAt()`, `sectionEndsAt()`, `msRemainingInSection()`, `sectionAllowances()`, `announceAtSeconds()`, `MOCK_CLOCK_LIMITS` | The section clock, capped by the attempt's own `expiresAt` with the cap **reported** (decision 9); extra time distributed over sections in proportion to their limits (decision 10); and `announceAtSeconds(limitSec)` returning the subset of `[600, 300, 60, 10]` that is below the section's own limit, so the timer announces four times at most and never once a second (§6, accessibility). It imports `accommodatedDurationSec()` and does not re-derive it. |
| `mock-navigation.ts` | `canAnswer()`, `nextServableIndex()`, `canAdvanceSection()`, `canTransitionMock()` | `allowBackNavigation: false` as a pure predicate over `{ allowBackNavigation, index, highWaterIndex, sectionSubmittedAt }`, called by the answer action — decision 8. `canTransitionMock()` is the status machine the `MockAttempt` trigger mirrors. |
| `mock-layout.ts` | `buildMockLayout()`, `mapSelectionToOriginal()`, `mapOptionsToShown()`, `layoutSchema` | Deterministic seeded shuffling of questions and options, passages moved as a block and never split across a section boundary, and the inverse mapping that turns a shown index back into the question's own index (decisions 11, 12). Pure and seeded, so a disputed paper is reproducible from `MockAttempt.seed` alone. |
| `csv.ts` | `parseCsvRecords()`, `splitCsvText()`, `type CsvRecord`, `type CsvIssue` | The RFC 4180 reader lifted unchanged out of `apps/web/src/lib/admin/roster-csv.ts`, which then imports it. Its existing unit tests stay as-is and are the proof the move changed no behaviour. (If Phase 6 still has `apps/web/src/lib/admin/` open when 7d lands, add `csv.ts` and leave `roster-csv.ts` importing it in a follow-up commit rather than racing.) |
| `aptitude-csv.ts` | `APTITUDE_CSV_COLUMNS`, `aptitudeCsvRowSchema`, `APTITUDE_IMPORT_LIMITS` (`maxRows: 1000`, `maxBytes: 900 * 1024`), `rowToQuestion()`, `questionToRow()` | Import and export are one column list and one row schema, so a file exported from `/admin/aptitude/export` re-imports unchanged — a round-trip test. 900 KB keeps the upload under Next's default 1 MB server-action body, the same reason `ROSTER_IMPORT_LIMITS` picked it. |

Added to the **existing** `packages/shared/src/xp.ts` (contended):
`XP_KEYS.aptitude(userId, questionId)`, `XP_KEYS.mock(mockAttemptId)`,
`aptitudeXp()`, `mockXp()` and `MOCK_PERCENTILE_MIN_ATTEMPTS = 30`, all on top
of the `XP_RULES.aptitude` and `XP_RULES.mock` constants that are already
there. `XP_RULES_VERSION` does not change — no existing value moves.

## 5. Routes, pages and guards

The `(student)` layout calls `requireUser()`, and per `docs/CONVENTIONS.md`
golden rule 2 that is not RBAC on its own: every page and every action guards
again, and ownership is always a `where` clause on `userId`, never a trusted
param.

| Route | File | Guard |
|---|---|---|
| `/aptitude` | `src/app/(student)/aptitude/page.tsx` | `requireUser()`; reads `AptitudeUserTopicStat` for this user and the PUBLISHED patterns. Every pattern name renders with `MODELLED_ON_NOTICE`. |
| `/aptitude/[topic]` | `src/app/(student)/aptitude/[topic]/page.tsx` (`params: Promise<{ topic: string }>`) | `requireUser()`; topic practice, one question at a time, `APTITUDE_PUBLIC_SELECT` only. The explanation enters the DOM only after the answer is committed. |
| `/aptitude/mock/[slug]` | `.../aptitude/mock/[slug]/page.tsx` | `requireUser()`; the cover page. Sections, minutes, counts, cutoffs, **negative marking** and whether back navigation is allowed are all stated *before* the start — the same posture as the rule that proctoring terms are never hidden until after the start. |
| `/aptitude/mock/attempt/[id]` | `.../attempt/[id]/page.tsx` | `requireUser()` + `where: { id, userId: user.id }`. The sitting: section header, server clock, palette, option group. |
| `/aptitude/mock/attempt/[id]/review` | `.../attempt/[id]/review/page.tsx` | `requireUser()` + ownership + `finalizedAt IS NOT NULL`. The only student path that may select the answer key and the explanation (`APTITUDE_ANSWER_SELECT`). |
| `GET /api/aptitude/attempts/[id]/clock` | `src/app/api/aptitude/attempts/[id]/clock/route.ts` | `requireUser()` + ownership; zod on params; `lib/rate-limit.ts`. Returns `{ serverNow, msRemainingInSection, msRemainingOverall, sectionPosition, sectionEndsAt }`. The client renders this and never `Date.now()` (decision 9). Polling cadence 5 s, never 250 ms (SPEC §7). |
| `/admin/aptitude` · `/new` · `/[id]` · `/import` · `/export` | `src/app/admin/aptitude/**` | `requirePageRole("ADMIN", "SUPER_ADMIN")`, as `/admin/problems` does. Queries in `src/server/queries/admin-aptitude.ts`, actions in `src/server/actions/admin-aptitude.ts` — the `admin-` filename prefix is what carries the sensitive-path rule, so the names are not optional. |
| `/admin/aptitude/patterns` · `/[id]` | `src/app/admin/aptitude/patterns/**` | same; actions in `src/server/actions/admin-mock-patterns.ts`. |

Server actions, all in `src/server/actions/`, each returning `ActionResult<T>`
through `runAction()`:

- `aptitude.ts` — `startMock`, `saveAnswer`, `advanceSection`, `finaliseMock`,
  `answerPracticeQuestion`. Guard: `requireActionUser()` plus an ownership
  `where`. `saveAnswer` calls `canAnswer()` before it writes and audits
  nothing (a practice answer is not a sensitive mutation); `finaliseMock`
  calls `audit()` because it writes ledger rows.
- `admin-aptitude.ts` — question CRUD, review, publish, retire, import,
  export. Every export's `runAction` body opens with
  `requireActionRole("ADMIN", "SUPER_ADMIN")`. Publishing a question or a
  pattern — the act that makes a cohort scorable on it — is bound to the
  SUPER_ADMIN `problems.lifecycle` capability, which is where Phase 4 already
  put that class of act.
- `admin-mock-patterns.ts` — pattern and section CRUD, publish, archive.

`capabilities.ts` (contended) gains `aptitude.authoring` (STAFF) and
`aptitude.sit` (SELF_SERVICE), with every action, route and page above bound
to one of them; `docs/SECURITY.md`'s generated table regenerates.

`nav.ts` (contended) gains `NavIconKey` `"aptitude"` and the `assess` group's
first entry — `item("/aptitude", "Aptitude", "aptitude", "Quantitative,
logical and verbal practice and full mocks")`. The group is currently empty
with the comment "ASSESS (Phases 6-7): no implemented routes yet", and
`shell-nav.test.ts` fails on a nav href with no `page.tsx`, so the entry lands
in 7e with the page.

`size-budgets.json` gains `/aptitude` (`maxKb: 140`) and
`/aptitude/mock/attempt/[id]` (`maxKb: 150`). Neither may pull Monaco or
CodeMirror in — an aptitude sitting has no editor — so both go in the
`monacoFree.entries` list, which is the cheapest way to keep a stray import
from costing 1 MB on the route the whole college uses.

## 6. The tests the phase is gated on

From the spec's own "Done when" line — *four gates green; a test asserts
negative marking and per-section cutoffs compute correctly across all seeded
patterns; a test asserts `allowBackNavigation: false` is enforced server-side,
not just in the UI* — plus what the design above implies.

1. **Negative marking and per-section cutoffs, across all six seeded
   patterns** (`packages/shared/test/aptitude-grading.test.ts`), table-driven,
   including: a correct answer scores `marksPerCorrect`; an answered wrong
   answer scores `−negativeMarkFraction × marksPerCorrect`; an **unanswered**
   question scores exactly 0 and never negative; a multi-choice set that is a
   strict subset of the key scores as wrong, not partially right; a numeric
   answer at exactly the tolerance boundary is correct and one step beyond it
   is not; a section whose raw total is negative reports 0%; a candidate who
   clears every section cutoff but misses `overallCutoffPercent` is not
   passed; a candidate who misses one section cutoff is not passed however
   high the total.
2. **`allowBackNavigation: false` is enforced server-side, not in the UI** —
   two tests, neither of which renders anything. `apps/web/test/aptitude-navigation.test.ts`
   calls the `saveAnswer` server action directly with an index below
   `highWaterIndex` and with a `sectionStateId` whose `submittedAt` is set, and
   expects a refusal in both cases; `packages/db/test/aptitude-invariants.db.test.ts`
   attempts the same two writes as raw SQL and expects `check_violation` from
   `recx_refuse_closed_section_write`.
3. **The four gates**: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
   `pnpm build`, on Windows and on the Linux mirror, each run on its own with
   its exit code and test counts recorded in `docs/RUNBOOK.md` §3 with a date.
4. **Every CHECK and trigger in §3**, through Prisma and through raw SQL
   (`packages/db/test/aptitude-invariants.db.test.ts`): a PUBLISHED question
   with a blank or 20-character explanation is refused; a VERBAL question
   tagged `MENSURATION` is refused; a `MULTI_CHOICE` with one correct index is
   refused; a `NUMERIC_ENTRY` carrying options is refused; a correct index
   past the end of `options` is refused; a `PASSAGE_GROUPED` question with no
   `passageId` (and a `SINGLE_CHOICE` question with one) is refused; a
   published question's `stem` cannot be updated while its `explanation` can;
   a section of a pattern with a finalised attempt cannot be edited, inserted
   or deleted; a `MockAttempt`'s `expiresAt` cannot be moved; a
   `MockSectionState.endsAt` cannot be moved; `TRUNCATE` is refused on every
   new table.
5. **`patternTotals()` and `recx_sync_pattern_totals` agree** on all six seed
   patterns — one definition, two enforcements, so the denormalised totals
   cannot drift.
6. **`buildMockLayout()` is deterministic and structurally sound**: the same
   seed gives the same paper; a passage group is contiguous and never crosses
   a section boundary; every section's served questions satisfy its
   `topicMix`; and a blueprint that the PUBLISHED pool cannot fill raises an
   authoring error rather than building a short paper.
7. **The section clock**: `sectionEndsAt()` is capped by the attempt's
   `expiresAt` and reports the cap; `mockExpiresAt()` applied with each
   accommodation shape distributes extra time proportionally across sections;
   `announceAtSeconds()` returns only the thresholds below the section's own
   limit.
8. **The answer key never reaches a student before they answer**:
   `tests/repo/aptitude-answer-exposure.test.ts` (static — every
   `aptitudeQuestion` read in a student entry's import closure uses
   `APTITUDE_PUBLIC_SELECT`, and `correctOptionIndexes`, `numericAnswer`,
   `numericTolerance` and `explanation` appear in no other student-reachable
   select) plus a live canary in `apps/web/test/` asserting the practice and
   sitting queries return rows without those fields.
9. **Enum parity** for `AptitudeArea`, `AptitudeTopic`, `AptitudeQuestionKind`,
   `MockPatternStatus` and `MockAttemptStatus`
   (`packages/db/test/enum-parity.test.ts`), and the guard-catalog coverage
   test over the four new migrations.
10. **XP is idempotent and capped**: a re-finalise of the same attempt writes
    no second `mock:` row; a question answered correctly twice in topic
    practice pays once; the 200/day aptitude cap holds under concurrent
    finalises (advisory lock); no path ever `UPDATE`s or `DELETE`s a ledger
    row (the existing `tests/repo/xp-ledger.test.ts` and
    `xp-ledger.db.test.ts` stay green).
11. **CSV round trip and per-row results**: a 300-row file with three bad rows
    creates 297 questions and three `FAILED` `AptitudeImportRow`s carrying
    every reason for each bad row, not just the first; an export re-imports as
    `UNCHANGED`; a malformed-quoting file is refused whole with a line number;
    the roster CSV tests stay green after the reader moves to `@recx/shared`.
12. **The forbidden-words fence** (`tests/repo/forbidden-words.test.ts`) stays
    green over all new copy — the pattern names, the cover-page text, the
    `MODELLED_ON_NOTICE` label, this design document and every Phase 7 commit
    message.
13. **Nothing auto-penalises**: a static test asserting that no module reached
    from `src/server/actions/aptitude.ts` imports `@/lib/flags`,
    `IntegrityFlag`, `AccountRestriction` or any leaderboard-withholding
    helper, and that `MockAttemptStatus` has no `VOIDED` or `TERMINATED`
    member. The maximum automatic consequence in the system is flag for review
    and withhold from the public leaderboard; Phase 7 reaches neither.
14. **`pnpm size`** with the two new budgets green, and both new routes in
    `monacoFree.entries`.
15. **The axe gate** (`apps/web/e2e/a11y.spec.ts`): the five new routes added
    as **gating** rows — zero serious or critical WCAG 2.0/2.1/2.2 A and AA
    violations, in light and dark, at 1366×768 and at 375×812, with the
    sitting page scanned in three further states (a section in progress, the
    palette sheet open on narrow, the review view).

Manual, from the spec: **sit a full seeded TCS-NQT-pattern mock and verify
section timing, cutoffs and the explanation view.** Plus, while sitting it:
confirm the "modelled on the publicly described pattern — not an official
test" label is visible on the pattern card, the cover page and the result
page; confirm the negative marking is stated before the first question;
confirm a section closes itself at its own deadline and that the next section
starts with a full clock; confirm the review view shows the worked explanation
and the per-question time for every question, right and wrong; and import a
300-question CSV with three deliberately broken rows and confirm 297 land with
three named failures.

### Accessibility requirements, not polish

These are requirements, taken from `docs/ACCESSIBILITY.md` and the exam-UI
rules Phase 6 established. An aptitude round is the surface the largest number
of students will ever use, and a sizeable number of them use it on a phone.

- The section timer announces at **exactly** the `announceAtSeconds()`
  thresholds below the section's limit — 10:00, 5:00, 1:00, 0:10 — and at no
  other time. Never `role="timer"` with a per-second live region; that makes a
  screen reader unusable for the length of a 25-minute section.
- The question palette is a `role="group"` of buttons with a **roving
  tabindex** and Arrow-key navigation. Four states — answered, not answered,
  marked for review, answered and marked — each with a distinct **shape plus
  icon plus a full `aria-label`**, a text+icon legend and a counts row. Never
  colour alone (`docs/ACCESSIBILITY.md` §1).
- Options are native inputs inside a `<fieldset>` whose `<legend>` carries the
  question number and the stem, as a `radiogroup` for single-choice and a
  checkbox group for multi-choice, so a screen-reader user hears what they are
  answering rather than four unlabelled radios.
- Numeric entry is `<input type="text" inputMode="decimal">` with
  `aria-describedby` naming the unit and the accepted tolerance — never
  `type="number"`, whose spinner and locale-dependent parsing are a
  correctness bug in a graded field.
- A passage and its questions are one region: the passage in a scrollable
  `role="region"` with an accessible name, reachable by keyboard from every
  question in its group, and never duplicated once per question.
- When `allowBackNavigation` is false the Previous control is **absent and
  explained**, not present-and-disabled-in-silence, and the restriction is
  stated on the cover page before the start. A disabled control with no
  explanation is the version a screen-reader user cannot make sense of.
- The negative marking and the cutoff are rendered as text on the cover page
  and in each section header. A scoring rule a student cannot read is not a
  fair rule.
- The explanation is a disclosure (`<details>`-shaped, with an accessible
  name), not a tooltip, and it enters the DOM only after the answer is
  committed.
- `EXTRA_TIME` and `SCREEN_READER` accommodations flow through
  `accommodatedDurationSec()` into every section clock. A practice mock
  collects no focus or fullscreen signals at all, so there is nothing to
  exempt — which is the simplest possible way to honour the rule that a
  `SCREEN_READER` candidate is never penalised for assistive technology moving
  focus.
- At 375px the palette collapses into a sheet but keeps the same roles,
  states, labels and legend; the timer and the section header stay visible.

## 7. Open questions to record in `docs/OPEN-QUESTIONS.md`

Each with the narrower reading this phase implements (SPEC §0: "ask before
inventing — implement the narrower reading and note it").

1. **Is a passage-grouped item always single-choice?** The spec lists
   `passage-grouped` as a *kind* alongside single-choice and multi-choice,
   which leaves the answering shape unstated. **Narrower reading:**
   `PASSAGE_GROUPED` answers exactly as single-choice (one correct index) and
   is the only kind that may carry a `passageId`, held by
   `CHECK AptitudeQuestion_passage_kind`. A multi-choice reading-comprehension
   item would need the partial-credit convention this phase deliberately does
   not have. Revisit with the verbal authors; widening it later is one CHECK
   and one zod refinement.
2. **Does a negative section score carry into the total, or is it floored?**
   None of the published funnels states it. **Narrower reading:** `totalRaw`
   carries the true signed sum so the total is honest, the *reported* percent
   is floored at 0, and `passedCutoff` reads the floored percent — so a
   negative section can never *lower* another section's outcome, and a
   candidate is never shown a negative percentage.
3. **Multi-choice partial credit.** **Narrower reading:** all-or-nothing on an
   exact set match, with the negative mark applied once for any wrong set. The
   alternative conventions (per-option credit, per-option penalty) differ by
   recruiter and none is publicly documented.
4. **With `allowBackNavigation: true`, may a candidate return to a section
   they have already submitted?** **Narrower reading:** no. Back navigation is
   *within the current section only*; a submitted section is closed for good,
   enforced by `recx_refuse_closed_section_write`. A section timer that a
   candidate can re-enter is not a section timer, and the funnels this models
   do not allow it.
5. **May a `MockPattern` be attached to an `Assessment`, so a proctored
   aptitude round reuses Phase 6's attempt engine?** The spec says the
   per-section and negative-marking machinery "is reused directly by the
   assessment product", which could mean code reuse or a schema link.
   **Narrower reading:** code reuse only — the pure modules in §4 are the
   reuse surface, and Phase 7 adds no foreign key between `MockPattern` and
   `Assessment`. The 768px floor, `affectsPlacementEligibility` and the
   `LAB_SUPERVISED` rule all live on the assessment side, and bridging the two
   without bringing those with it is precisely how placement-eligibility drift
   starts. Revisit as a deliberate Phase 8+ design, not as a column.
6. **The mock XP percentile term before a pattern has a cohort.**
   `XP_RULES.mock` is `base: 100 + 1 per percentile above median`, and a
   percentile over four attempts is noise while an `XpEvent` is permanent.
   **Narrower reading:** `MOCK_PERCENTILE_MIN_ATTEMPTS = 30`; below it only
   the base is awarded and the result page says the percentile is not yet
   meaningful. Carried from the spec's own rule that a contest rating is not
   meaningful before 8–12 contests.
7. **The 29 topic members.** The spec lists them in prose; the enum spellings,
   the groupings (`INTEREST` for simple and compound,
   `AVERAGES_MIXTURES`, `SERIES` for both number and letter series) and the
   labels are this phase's choice. **Narrower reading:** implement the list
   exactly as written in `aptitude-taxonomy.ts` and take it to the placement
   cell for confirmation, as the 14 problem topics were.
8. **Does per-question aptitude XP apply inside a mock, or only in topic
   practice?** **Narrower reading:** topic practice only, keyed
   `aptitude:{userId}:{questionId}` on first correct answer; a mock pays
   `XP_RULES.mock` once per finalise. Otherwise a 120-question mock would pay
   up to 1,200 XP through the per-correct rule *and* the mock rule, and the
   200/day cap would silently become the real number — which is exactly the
   Easy-grinding failure the XP caps exist to prevent.
9. **May a question be retired while a published pattern's blueprint still
   needs it?** **Narrower reading:** retiring is allowed, serving is not.
   `buildMockLayout()` draws only PUBLISHED questions and refuses to build a
   section whose `topicMix` the pool cannot fill, so the consequence surfaces
   as an authoring error on the pattern page rather than as a short paper for
   a candidate.
10. **Does the CSV export carry the answer key and the explanations?**
    **Narrower reading:** yes, but only through the staff-only
    `/admin/aptitude/export` path, with `audit()` on every download; there is
    no student-facing export at all. A question bank with the keys stripped is
    not a bank a faculty member can review, but an answer-bearing file is the
    one artefact that must never reach a student mailbox.
11. **Does `/aptitude` show a cohort percentile to the student?** The spec
    asks for percentiles for XP and for Phase 8's readiness score, not for the
    student's own page. **Narrower reading:** the student sees their own
    percent, their per-section outcomes and their topic accuracy; the cohort
    percentile is shown only once the pattern has 30 finalised attempts, and
    never as a rank against named peers. It must not be allowed to read as a
    placement prediction (SPEC §7).


---

## Review findings — fix before implementing
An independent pass over this document against `docs/handoff/SPEC.md` and the
actual repository returned **needs-revision**. Nothing below has been applied yet: this
design is a DRAFT, and these are the items to settle first, when Phase 7 starts
and the codebase is whatever it is by then. Each one was checkable against a
file or a spec line when it was written (2026-10-19).

### Contradicts the spec or the codebase (5)

1. §2 slice 7b and §6.1 together are not implementable as written. The spec's gate test is "negative marking and per-section cutoffs compute correctly across all seeded patterns"; §6.1 puts it at packages/shared/test/aptitude-grading.test.ts, while 7b puts the six seeded patterns at apps/web/scripts/content/aptitude/patterns.ts. packages/shared/package.json declares exactly one dependency (zod) and no workspace dependency on @recx/web, and packages/shared/vitest.config.ts includes only ["test/**/*.test.ts"] as "Pure unit tests: no I/O". A packages/shared test cannot import apps/web. The same breakage hits §6.5 ("patternTotals() and recx_sync_pattern_totals agree on all six seed patterns"). The seed patterns have to live in @recx/shared, or the gate test has to live in apps/web — the design picks neither.

2. §3.11: "Field for field the ProblemImport / ProblemImportRow shape, with ProblemImportStatus and ProblemImportRowStatus reused" — then lists counters `created`, `updated`, `unchanged`, `failed`. The actual model (packages/db/prisma/schema.prisma:1768) has `created`, `revised`, `unchanged`, `failed`; `revised` is the name because the reused row status is NEW_REVISION, not UPDATED. The row model is also mis-mirrored: ProblemImportRow keys on `entry` with @@unique([importId, entry]) and carries `packageSha256`/`problemVersionId`/`revision`, and ProblemImport uses `archiveSha256`. Switching to `line`/`fileSha256` for a CSV is fine; claiming it is field for field while silently renaming the one counter whose name encodes the reused enum is not, and an `updated` counter with no UPDATED row status cannot be reconciled.

3. §5: "size-budgets.json gains /aptitude (maxKb: 140) and /aptitude/mock/attempt/[id] (maxKb: 150) ... so both go in the monacoFree.entries list". Those are not the keys the file uses. apps/web/size-budgets.json routes are { "route": "/problems", "entry": "/(student)/problems/page", "maxKb": 170 } and monacoFree.entries holds entry paths — ["/(student)/problems/page", "/(student)/dashboard/page", "/(student)/leaderboard/page", "/(public)/judge/page"] — not route paths. The entries as written would silently match nothing in monacoFree, i.e. the fence the design calls "the cheapest way to keep a stray import from costing 1 MB" would be a no-op.

4. §3.4: AptitudeQuestionStat carries `timesServed` and `lastServedAt` with "Maintained with { increment: n } inside finalise; never computed on read". Served and answered are different events: incrementing timesServed at finalise makes lastServedAt a lie, makes CHECK `timesAnswered <= timesServed` vacuous rather than protective, and records nothing at all for an IN_PROGRESS or ABANDONED attempt — so the "dud question" detection the section is justified by ("99% correct, or 3% correct") is computed over a biased denominator. The increment belongs where buildMockLayout() serves the question.

5. Decision 22 reads SPEC §7 selectively. It quotes the arena/proctored clause and answers it, but §7 also says plainly "Do not build a serious phone-based solving experience", with no arena or proctoring qualifier. §6.15 then makes /aptitude/mock/attempt/[id] a *gating* axe row at 375x812 with three extra states — that is a serious phone sitting experience by any reading, built as a gate. Compounding it, the design's own open question 5 keeps the door open to attaching a MockPattern to an Assessment later, at which point a 375px-gated sitting page is a proctored attempt below 768px. At minimum this needs to be an OPEN-QUESTIONS entry with the narrower reading, not a decision stated as settled.


### Spec requirements the design does not cover (9)

1. SPEC: "Reuse the LMS question-bank CSV import/export pipeline with per-row results". The design never mentions the LMS once (grep for "LMS" in DESIGN.md returns nothing). The pipeline it is told to reuse exists and I read it: C:/Users/SUBASH/OneDrive/Documents/GitHub/REC-LMS/src/lib/quiz/question-csv.ts, with QUESTION_CSV_HEADER = [type,text,marks,difficulty,options,correct,tolerance,unit,hint,explanation,tags], pipe-separated options so a comma inside an option does not fight the CSV, a 1-based index or letter for the key, and a per-row RowResult { line, ok, error?, question? }. The design instead reuses REC-CODE's own roster reader plus the ProblemImport shape, names APTITUDE_CSV_COLUMNS without listing a single column, and never states that it is departing from the spec's named pipeline or why. A faculty CSV exported from the LMS question bank will not import.

2. SPEC: "so one bad row cannot discard a 300-question file" and "Target ~2,000 questions". §4 sets APTITUDE_IMPORT_LIMITS (maxRows: 1000, maxBytes: 900 * 1024) alongside APTITUDE_LIMITS (stem 4 KB, explanation 8 KB) and mandatory worked explanations. 900 KB over 300 rows is a 3 KB average row budget while one legal row may be 12 KB+; a realistic 300-question file with worked explanations is refused *whole* on the byte cap, which is exactly the failure the clause forbids. maxRows: 1000 and maxBytes: 900*1024 are never reconciled, and there is no non-server-action upload path for the ~2,000-question target (ROSTER_IMPORT_LIMITS picked 900 KB for ~80-byte roster rows and maxRows: 5000 — the analogy does not carry).

3. SPEC: "each labelled in the UI \"modelled on the publicly described pattern — not an official test.\"" §6 has no gating test that MODELLED_ON_NOTICE actually renders on every surface a pattern name appears on. It is left entirely to the manual pass ("confirm the ... label is visible on the pattern card, the cover page and the result page"). Decision 19's whole argument is that the label must be unremovable; a one-constant-plus-manual-check is not that fence.

4. SPEC: "passage-grouped (one shared passage, N questions)". AptitudePassage (§3.2) has CHECKs on body length and wordCount but no invariant or test that a passage carries more than one question. A one-question AptitudePassage is a stem with extra steps, and §6.6 only tests that a passage group is contiguous, not that it is a group.

5. The design depends on two background jobs and specifies neither. Decision 15: "MockPattern.finalizedAttemptCount and medianPercent are maintained by the nightly job" — the definite article, with no such job defined. §3.7: "@@index([status, expiresAt]) (the auto-finalise sweeper)" — and MockAttemptStatus.AUTO_SUBMITTED exists only because of it. Those are the only two mentions in 890 lines. There is no apps/scheduler entry, no new member of SCHEDULER_JOB_NAMES in packages/shared/src/governance.ts (currently [reconciler, dailyChallenge, leaderboardFreeze, outbox, governance, contestRank, attemptSweep]), no SchedulerJobStatus row, no queue, no idempotency key, no slice in §2 and no test in §6. apps/scheduler/src/attempt-sweep.ts already exists and is the obvious host; the §0 "what is already built" table does not list apps/scheduler or SCHEDULER_JOB_NAMES at all, so the design does not appear to know it is there.

6. Nothing in the design writes ActivityDay, User.lastActiveAt or UserStats. Decision 14 reads ahead to Phase 8 ("Phase 8's aptitudePercentile / verbalPercentile / 'aptitude section-level gaps'"), so it is not Phase-8-unaware — yet SPEC Phase 8's nightly job takes its "Candidate set from User [status, lastActiveAt]" and counts "days with a qualifying ActivityDay", and its policy column is countsAsActivity Json @default("{\"submission\":true,\"solve\":true,\"login\":false,\"lesson\":true}") — with no aptitude key. As designed, a student who practises aptitude daily and nothing else accrues no activity, shows an empty heatmap and a zero streak on /dashboard and /profile (both of which read activityDay.findMany), and is swept toward SOFT_RESTRICTED by Phase 8. The design should either write ActivityDay on finalise/practice or state the omission as an open question; it does neither.

7. SPEC §7 DO NOT: "Do not render 5,000 DOM rows. Virtualise." /admin/aptitude is the browse surface for a bank the spec sizes at ~2,000 questions, and §5 says nothing about pagination or virtualisation. The sibling it claims to copy already solved this: apps/web/src/server/queries/admin-problems.ts has const PAGE_SIZE = 50 with skip/take and a pageCount. No page size, no virtualisation and no test.

8. The import's behaviour against decision 17 is unstated. recx_refuse_published_question_change freezes stem/options/correctOptionIndexes/kind/area/topic on a PUBLISHED row, and §6.11 only tests that "an export re-imports as UNCHANGED". What happens when an operator edits the stem of a published question in the export and re-imports — FAILED row with a readable reason, or a trigger error that kills the whole file — is never said, and that is the single most likely real use of the round trip.

9. MockPattern.overallCutoffPercent and decision 7's conjunction-of-gates rule are invented: the spec lists only "per-section cutoff". SPEC §0 requires "implement the narrower reading and note it in docs/OPEN-QUESTIONS.md", and §7's eleven open questions do not include this one. The narrower reading is arguably no overall cutoff at all.

