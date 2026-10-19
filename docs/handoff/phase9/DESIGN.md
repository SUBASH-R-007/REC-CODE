# Phase 9 design: readiness, placement analytics, roles

Coordinator working notes. Delete `docs/handoff/phase9/` once Phase 9 is
gated.

Source of truth: `docs/handoff/SPEC.md` §5 "Phase 9 — Readiness, placement
analytics, roles", bounded by §0 (ground rules), §4 (data model and
retention) and §7 (anti-requirements). Three sentences of the spec carry most
of the risk in this phase and are quoted here because the rest of the design
exists to serve them:

> `topicBreadth` is the MINIMUM across the 14 topics … never the mean.
> Averaging lets a student look ready with 200 array problems and zero graphs,
> which is precisely the profile that fails real interviews.

> Show missing components as missing, never silently as zero.

> Privacy boundary drawn in the schema and the guards, not in policy.

Readiness is a **preparation-coverage measure**. It is not a prediction of
being placed, it has zero validation data at launch, and §7 forbids both
implying otherwise and using it to gate drive eligibility without a recorded
human decision.

## 0. What is already built

Phase 9 is the least greenfield phase in the plan. Everything below exists and
must **not** be rebuilt or redesigned.

| Already built | Where | What Phase 9 does with it |
|---|---|---|
| **All five roles** | `Role` enum, `packages/db/prisma/schema.prisma:23` | Nothing. The enum is complete: `STUDENT TA_MENTOR ADMIN PLACEMENT_OFFICER SUPER_ADMIN`. No migration. |
| **The capability module and its matrix tests** | `apps/web/src/lib/auth/capabilities.ts`; `apps/web/test/capabilities.test.ts` (static, TS compiler API), `apps/web/test/capability-matrix.test.ts` (runtime, real guards) | The spec's "capabilities in one module and a test over the matrix" is this file. Phase 9 **adds two tiers to it**, it does not write a new module. |
| **The 14 topics** | `packages/shared/src/topics.ts` (`TOPICS`, `TOPIC_LABEL`, `isTopic`) and the `Topic` enum at `schema.prisma:129` | `topicBreadth` and the weakness heatmap iterate `TOPICS`. The comment in that file already names both uses. Never a second topic list. |
| **Unassisted-solve accounting** | `UserProblemStatus.assisted` (`schema.prisma:876`, "excluded from unassisted readiness inputs"), `UserStats.topicSolved` (unassisted first solves per topic) / `topicAssisted`, `UserStats.solvedEasy/Medium/Hard`, `assistedSolves` | Every coverage component reads these. **No new counter, no new denormalisation, no aggregation over `Submission`.** |
| **Activity days** | `ActivityDay` (`schema.prisma:903`), `@@index([userId, date DESC])` | `consistency` = qualifying days in the last 30 ÷ 30. |
| **Contest rating** | `UserRating` (`schema.prisma:2065`), `packages/shared/src/rating.ts` (`PROVISIONAL_CONTESTS = 5`, `RATING_SEED`) | `ratingPercentile` reads `UserRating.rating`; see decision 6 for the readiness-specific contest floor. |
| **The AdminScope fence** | `tests/repo/admin-scope.test.ts` (R1–R10, `FORBIDDEN_DELEGATES = note, codeDraft, submissionSource, auditLog`), `apps/web/src/lib/auth/scope.ts`, `scope-where.ts` | The **pattern** Phase 9 copies for the placement/mentor fence. The existing file covers admin-reachable code only and is **not edited**. |
| **The student-exposure fence** | `tests/repo/student-exposure.test.ts`, `apps/web/test/student-exposure.db.test.ts` | Already treats every `src/app/**` entry outside `admin/`, `super/`, `api/judge/`, `api/admin/` as a student entry. New placement pages inherit that for free — see sharp edge 5. |
| **Hash-chained audit** | `AuditLog` (`schema.prisma:441`, `@@index([targetUserId, createdAt])`, `@@index([sensitivity, createdAt])`), `audit()` / `auditMany()` in `apps/web/src/lib/audit.ts`, `AuditSensitivity` | Every drill-down and every eligibility decision writes through `audit()`. No new audit table. |
| **The scheduler** | `apps/scheduler/src/main.ts` (tick loop, `--once`, `--dry-run`), `job-status.ts`, `SchedulerJobStatus`, `SCHEDULER_JOB_NAMES` in `packages/shared/src/governance.ts`, `LeaderboardFreezeJob` as the batch-job pattern | The nightly readiness job is one more job in that loop. No new process, no new cron mechanism. |
| **Cohort columns and the percentile-by-counting pattern** | `User.batchYear/departmentCode/section` + `@@index([batchYear, departmentCode, section])`; `XpBucket` with denormalised `batchYear/departmentCode/section` and its four composite indexes; `apps/web/src/server/queries/leaderboard.ts` ("my rank" as an index-only count) | `ReadinessSnapshot` copies the same denormalisation (decision 9). The percentile is a count, not a window function over the table. |
| **Retention and legal hold** | `PlatformSetting` key `retention`, the purge in the scheduler tick, the SUPER_ADMIN `legalHold` flag, `tests/repo/platform-setting-writes.test.ts` | `ReadinessSnapshot` retention is one more key in that setting; the purge job gains one batch loop. |
| **`Company`** | `schema.prisma:515` | `PlacementDrive.companyId` points at it optionally; the drive still carries its own `companyName` because a drive may be run by a company with no tagged problems. |
| **Accommodation, `ProctorEventKind` (all 25 kinds), the assessment and attempt engine** | Phase 4 and Phase 6 | Read-only. Phase 9 reads released assessment scores and **never** an integrity band, flag count or `ProctorEvent` row — §7 forbids showing a band to a recruiter, and a placement officer is one. |
| **Profile surfaces** | `apps/web/src/app/(student)/profile/page.tsx`, `app/u/[handle]/page.tsx`, `components/profile/skill-radar.tsx`, `server/queries/profile.ts`, `ProfileVisibility` | `/placement` links to the radar; it does not duplicate it. The public `/u/[handle]` carries "never email, roll number, department or scores" — a readiness score **is** a score, so it never appears there (test 12). |
| **The forbidden-words fence** | `tests/repo/forbidden-words.test.ts` | Scans every new doc, comment and UI string in this phase, including this file. |

Depended on but built by **earlier, already-gated phases of this run** — if
either is missing, Phase 9 stops rather than inventing a source:

- **Phase 7** (`AptitudeQuestion`, `AptitudeSection`, `MockPattern`,
  `MockAttempt`) is the only source of `aptitudePercentile`,
  `verbalPercentile` and the officer dashboard's "aptitude section-level
  gaps". Phase 9 reads it through exactly one adapter
  (`apps/web/src/server/queries/placement-inputs.ts`), so a shape change is
  one compile error rather than a scatter.
- **Phase 8** (`AccountRestriction`, `CalendarDay`, `LeaveException`,
  `ActivityDay` semantics) supplies the inactivity facts the at-risk list
  reuses instead of recomputing them.

Genuinely missing, and therefore this phase's work: every readiness model,
the placement and mentor surfaces, the two new capability tiers, the
mentor-of-record relation, the placement privacy fence, and the HMAC-signed
profile/resume export with its public `/verify` page.

## 1. Key decisions

1. **`topicBreadth` is a MIN, and the arithmetic is pure, versioned and
   tested before any schema exists.** The spec gives the reason verbatim:
   averaging lets a student look ready with 200 array problems and zero
   graphs, "which is precisely the profile that fails real interviews". So
   `topicBreadth(counts, target)` in `packages/shared/src/readiness.ts`
   returns `{ value, limitingTopic, perTopic }` where `value = min over the
   14 topics of min(1, unassisted[t] / target)` — and it returns the
   **argmin** as well, because the limiting topic is exactly what the
   student's next action must name. There is no mean anywhere in the module,
   and slice 9a ships it with the 200-array/0-graph fixture before a single
   migration is written.
2. **A missing component is missing, and the score is reported out of the
   weight that was actually available.** Three ways a component can be
   absent: no source model yet (`mockInterviewScore`, decision 5), too little
   data to be meaningful (`ratingPercentile` under the contest floor, a
   cohort under 30), or no attempt on record (no aptitude mock sat). In all
   three the resolver returns `{ state: "MISSING", reason }` and the score is
   `Σ(weight × value)` over **present** components only, reported together
   with `availableWeight = Σ(weight)` over those same components. Two
   readings were rejected: substituting 0 (the spec forbids it, and it
   punishes a student for the platform's own gap) and silently renormalising
   to 100 (which reads as a full score and hides the gap — the same lie with
   better arithmetic). The UI renders "68 / 100 · 85 % of this tier is
   measurable" plus a chip per missing component. A **database CHECK**
   (`score ≤ availableWeight`, and `score IS NULL` exactly when
   `availableWeight = 0`) makes a zero-filled or renormalised row
   unstorable — the rule lives in the data, not in the renderer.
3. **The weights are a versioned constant in code, not an editable setting.**
   `READINESS_RULES_V1` and `READINESS_RULES_VERSION` in
   `packages/shared/src/readiness.ts`; every row records
   `ReadinessSnapshot.rulesVersion`. The spec says plainly to "recalibrate the
   weights after the first full placement cycle against real outcome data",
   which is a deliberate reviewed act with a migration note, not a text field
   an officer edits on a Tuesday. A weight slider would silently rescore 5,000
   students with no code review, no version and no way to explain a disputed
   number months later. (The XP rules are a super-admin setting, and
   `XpEvent.rulesVersion` is how that one stays explainable; readiness takes
   the narrower half of the same pattern. Recorded as open question 7.)
4. **Percentiles are frozen per run, and computed by counting.** The job
   builds each cohort's distribution once, stores it in
   `ReadinessRun.cohortStats`, and scores every student against that frozen
   distribution. Without this, two students with identical inputs can get
   different scores inside one run as the distribution shifts under the job —
   an unexplainable difference in a number a student may dispute.
   `percentileRank` is `countStrictlyBelow / cohortSize`: ties share a value,
   nobody reaches 1.0, and it is an index-only count like the leaderboard's
   "my rank" rather than a window function over the whole table.
5. **`mockInterviewScore` has no source at launch and says so.** The
   mock-interview scheduler is explicitly deferred (§6, Phase 11+). It is
   10 % of SERVICE, 10 % of PRODUCT and 15 % of TOP, so every TOP score at
   launch has `availableWeight = 85`. The resolver returns
   `MISSING / NO_SOURCE_YET` and the card reads "Mock interview — not
   measurable yet (15 points of this tier)". There is deliberately no
   fallback value and no code path that can produce one.
6. **A contest rating below 8 rated contests is a missing component, not a
   low one.** §7: "Do not treat a contest rating as meaningful before ~8–12
   contests." `PROVISIONAL_CONTESTS = 5` stays what it is — a display rule
   for the "?" suffix — and readiness gets its own, stricter floor
   `READINESS_RATING_MIN_CONTESTS = 8`, the earliest the spec permits.
   `ratingPercentile` is 35 % of TOP, so treating a two-contest rating as
   real would be the single largest unearned swing in the system.
7. **No signal auto-penalises, and nothing here is a consequence at all.**
   The whole phase is read-only over student data except for `ReadinessRun`,
   `ReadinessSnapshot`, `MentorAssignment`, `PlacementDrive`,
   `DriveEligibilityDecision`, `PlacementExport`, `ProfileExport` and audit
   rows. The nightly job changes no account status, writes no notification
   that threatens anything, and sends no email. The at-risk list **routes to
   a named mentor for a conversation** — a form submit that creates a mentor
   task, never an automated message to the student.
8. **The privacy boundary is three fences, none of them a policy
   document.** (a) In the **schema**: every model holding private student
   content carries the doc tag `/// PRIVATE: never readable from a placement
   surface`, and `tests/repo/placement-fence.test.ts` requires every model
   with a `userId` or `User` relation to be either in
   `PLACEMENT_FORBIDDEN_DELEGATES` or in an explicit `PLACEMENT_READABLE`
   allowlist with a reason — so when Phase 11 adds discussion drafts or
   assistant chat, the build fails until that model is classified. (b) In the
   **guards**: `requirePlacementPage()` / `requirePlacementAction()` and
   `requireMentorPage()` / `requireMentorAction()`, bound through
   `capabilities.ts` so the existing runtime matrix test calls them for every
   role. (c) In the **column allowlist**:
   `PLACEMENT_EXPORT_COLUMNS` in `packages/shared/src/placement-export.ts` is
   the only way a field reaches a CSV. Officers may see solved counts,
   rating, readiness, assessment scores and activity dates; `Note`,
   `CodeDraft`, `SubmissionSource` and `SubmissionTestDetail` are
   unreachable from any placement module, by the test rather than by trust.
9. **The snapshot carries its own cohort columns.** `batchYear`,
   `departmentCode` and `section` are copied onto `ReadinessSnapshot` at write
   time, exactly as `XpBucket` does, so every officer aggregate is one index
   scan with no join to `User` — and a student who changes section later does
   not retroactively move a historical snapshot into a cohort it was never
   scored against.
10. **No ranking of students by readiness exists anywhere.** The spec: "the
    dashboard never produces a shareable public ranking of students by
    readiness." The officer dashboard renders **distributions** (fixed
    buckets), the 14 × section heatmap (counts), the per-drive **count**
    above a threshold, and an at-risk list ordered by `lastActiveAt ASC`
    (longest silent first) — never by score. The fence test asserts that no
    placement query orders by `serviceScore`, `productScore` or `topScore`,
    so there is no query shape that could produce a league table even if a
    future page wanted one.
11. **Every individual drill-down writes its audit row before it reads.** One
    exported loader, `loadPlacementStudentDrilldown()`, calls `audit()`
    (action `placement.student.view`, `sensitivity: SENSITIVE`,
    `targetUserId`) and only then queries. The fence asserts the drill-down
    page has no other data source and that the `audit(` call precedes any
    `db.` access in that function. The page also calls `noStore()`: a cached
    render would serve the data with no audit row, which is the one way this
    requirement fails silently (sharp edge 4).
12. **Drive eligibility has no representable automatic path.**
    `DriveEligibilityDecision.decidedById` is `NOT NULL` with a foreign key
    to `User`, and `reason` has a `length(btrim(reason)) >= 10` CHECK. There
    is no nullable actor and no system sentinel, so no job can write an
    eligibility row; and the action that writes one also writes the audit
    row. `PlacementDrive` stores a `thresholdScore` for the count view and
    **never** an eligibility list.
13. **The signed export is crypto-free in `packages/shared`.** The payload
    canonicalisation is pure and lives in
    `packages/shared/src/export-payload.ts`; the HMAC itself lives in
    `apps/web/src/lib/export/signature.ts` with `EXPORT_SIGNING_SECRET` from
    the env schema — a secret of its own, never `AUTH_SECRET`. `packages/shared`
    is imported by the judge worker and by client components and has no
    `node:crypto` import today; it keeps none.
14. **The framing copy is a constant, not prose in a component.**
    `READINESS_FRAMING` in `packages/shared/src/readiness.ts` holds the exact
    sentences ("a measure of how far your preparation covers what each tier
    of recruiter screens for", "it is not a prediction of being placed", "the
    weights have no validation data yet and will be recalibrated after the
    first full placement cycle"). Every surface that renders a readiness
    number imports it, and a test asserts each such surface does — copy
    duplicated into three components is copy that drifts out of three
    components one at a time.

## 2. Sequencing

Six slices. Each is green on lint, typecheck, test and build on its own
before the next starts; only 9f closes the phase.

| Slice | Contents |
|---|---|
| **9a The arithmetic, alone** | `packages/shared/src/readiness.ts` (`READINESS_RULES_V1`, `READINESS_RULES_VERSION`, `READINESS_RATING_MIN_CONTESTS`, `topicBreadth` with its argmin, `readinessScore` returning `{ score, availableWeight, missing[] }`, `componentGaps`, `nextAction`, `consistency`, `READINESS_FRAMING`) and `packages/shared/src/percentile.ts` (`percentileRank`, `MIN_PERCENTILE_COHORT = 30`). Unit tests only: the MIN property over all 14 topics, the 200-array/0-graph fixture scoring low in PRODUCT and TOP, missing-never-zero, gap ordering, the exact next-action string. **No schema, no UI.** |
| **9b The nightly snapshot** | `ReadinessTier`, `ReadinessComponent`, `ComponentState` enums; `ReadinessRun`, `ReadinessSnapshot` with every CHECK and trigger in §3; the input adapter `server/queries/placement-inputs.ts`; `apps/scheduler/src/readiness.ts` (`readinessSnapshot` added to `SCHEDULER_JOB_NAMES`), 02:30 Asia/Kolkata after the Phase 8 sweep, batches of 500, `--dry-run`, idempotent per `(userId, computedOn)`, frozen `cohortStats`; the retention key. DB invariant tests in `packages/db/test/readiness-invariants.db.test.ts`. |
| **9c `/placement` for the student** | `app/(student)/placement/page.tsx` and `components/placement/*`: the three tier cards, the measurable-weight denominator, missing chips, the three largest gaps, the one next action, `READINESS_FRAMING`, the link to the existing skill radar. Accessibility rows from §6. `pnpm size` budget for the route. |
| **9d Roles, the mentor of record, the fence** | `PLACEMENT_CAPABILITIES` and `MENTOR_CAPABILITIES` added to `capabilities.ts` (+ `Capability.arrives` widened to allow `11`); the four new guards; `MentorAssignment` with its invariants; `lib/auth/mentor-scope.ts` with a branded `ScopedMenteeId`; `app/mentor/**` (my mentees, one mentee's coverage); `tests/repo/placement-fence.test.ts`; the exact-set matrix tests; `docs/SECURITY.md` regenerated with `RECX_UPDATE_DOCS=1`. |
| **9e The cohort dashboard** | `app/placement-cell/**`: readiness distribution per tier by department/batch/section, the 14-topic × section weakness heatmap, the at-risk list with mentor routing, aptitude section-level gaps (via the Phase 7 adapter), the audited drill-down, and the CSV export of `PLACEMENT_EXPORT_COLUMNS` with its `PlacementExport` row. |
| **9f Drives and the signed export** | `PlacementDrive`, `DriveEligibilityDecision` and the per-drive count view; `ProfileExport` + `packages/shared/src/export-payload.ts` + `lib/export/signature.ts`; `app/(public)/verify/[code]/page.tsx`; the manual three-seeded-students review; `docs/OPEN-QUESTIONS.md` entries; the RUNBOOK gate rows. |

## 3. New Prisma models and enums

Enums (five):

```prisma
enum ReadinessTier { SERVICE PRODUCT TOP }

enum ReadinessComponent {
  APTITUDE_PERCENTILE
  VERBAL_PERCENTILE
  EASY_MEDIUM_COVERAGE
  MEDIUM_UNASSISTED_COVERAGE
  MEDIUM_HARD_UNASSISTED_COVERAGE
  TOPIC_BREADTH
  RATING_PERCENTILE
  MOCK_INTERVIEW_SCORE
  CONSISTENCY
}

enum ComponentState { PRESENT MISSING }
enum DriveEligibility { ELIGIBLE NOT_ELIGIBLE }
enum ProfileExportKind { PROFILE RESUME }
```

### `ReadinessRun` — one row per nightly run

`computedOn DateTime @id @db.Date`, `rulesVersion Int`, `startedAt`,
`finishedAt DateTime?`, `studentsEvaluated Int`, `cohortStats Json`,
`ok Boolean @default(false)`, `dryRun Boolean @default(false)`,
`notes String?`.

`cohortStats` is the frozen distribution per cohort key
(`{"2027":{"n":1184,"aptitude":[…buckets…],"rating":[…]}}`). The dashboard
reads "the newest run with `ok = true` and `dryRun = false`" and then index-scans
that day's snapshots — no hot "current" row to increment (§4d's rule applied
to a different table).

Invariants: CHECK `finishedAt IS NULL OR finishedAt >= startedAt`; CHECK
`NOT ok OR finishedAt IS NOT NULL`; CHECK `rulesVersion > 0`; CHECK
`studentsEvaluated >= 0`; trigger `ReadinessRun_no_truncate`.

### `ReadinessSnapshot` — one row per student per run

```
userId String                     (relation to User, no onDelete cascade: a
                                   student is never hard-deleted, §7)
computedOn DateTime @db.Date
rulesVersion Int
cohortKey String                  // the batch the percentiles were taken in
cohortSize Int
batchYear Int?  departmentCode String?  section String?   // copied, like XpBucket
serviceScore Int?  productScore Int?  topScore Int?        // 0..100, null only when nothing is measurable
serviceAvailableWeight Int  productAvailableWeight Int  topAvailableWeight Int   // 0..100
topicBreadthProduct Int?  topicBreadthTop Int?            // 0..100
limitingTopicProduct Topic?  limitingTopicTop Topic?      // the argmin
components Json                   // the full breakdown, zod-validated
topicUnassisted Json              // the 14 counts the MIN was taken over
lastActiveOn DateTime? @db.Date
createdAt DateTime @default(now())

@@unique([userId, computedOn])
@@index([computedOn, departmentCode, batchYear, section])
@@index([computedOn, serviceScore])
@@index([computedOn, productScore])
@@index([computedOn, topScore])
@@index([userId, computedOn(sort: Desc)])
```

`components` shape (one entry per `ReadinessComponent`, so a breakdown is
always complete and a missing component is a present fact rather than an
absent key):

```json
{"RATING_PERCENTILE":{"state":"MISSING","reason":"TOO_FEW_RATED_CONTESTS","have":3,"need":8},
 "TOPIC_BREADTH":{"state":"PRESENT","value":0.17,"limitingTopic":"GRAPHS"}}
```

Database-enforced invariants:

- `ReadinessSnapshot_score_range` — each score `IS NULL OR BETWEEN 0 AND 100`;
- `ReadinessSnapshot_weight_range` — each available weight `BETWEEN 0 AND 100`;
- **`ReadinessSnapshot_score_le_available`** — for each tier,
  `score IS NULL OR score <= availableWeight`. This is decision 2 in the
  data: a renormalised or zero-filled score is not storable;
- **`ReadinessSnapshot_null_when_unmeasurable`** — for each tier,
  `(availableWeight = 0) = (score IS NULL)`;
- `ReadinessSnapshot_breadth_range` — breadth columns `IS NULL OR BETWEEN 0 AND 100`;
- `ReadinessSnapshot_breadth_pairs` — `topicBreadthProduct IS NULL` exactly when
  `limitingTopicProduct IS NULL` (same for TOP): a breadth value always names
  the topic that limited it;
- `ReadinessSnapshot_cohort_size` — `cohortSize >= 0`, and `cohortKey <> ''`;
- `ReadinessSnapshot_components_object` — `jsonb_typeof(components) = 'object'`
  and `jsonb_typeof(topicUnassisted) = 'object'`;
- trigger **`ReadinessSnapshot_recompute_only`** — `userId` and `computedOn`
  never change, `rulesVersion` never decreases, and `createdAt` is immutable.
  A rerun of the same campus day upserts the computed columns (the job is
  idempotent per `(userId, computedOn)`); nothing else may edit a row;
- trigger `ReadinessSnapshot_no_truncate`;
- a foreign key to `ReadinessRun(computedOn)` so a snapshot cannot exist for a
  run that was never recorded.

### `MentorAssignment` — the named mentor of record

`id`, `menteeId` (→ `User`), `mentorId` (→ `User`), `assignedById`,
`assignedAt`, `reason String`, `endedAt DateTime?`, `endedById String?`.

- partial unique index `MentorAssignment_one_active_per_mentee`
  (`menteeId` WHERE `endedAt IS NULL`) — the at-risk list must route to
  exactly one named human, so two live mentors is not a representable state;
- `@@index([mentorId, endedAt])` — "my mentees" is one index scan;
- CHECK `MentorAssignment_not_self` (`menteeId <> mentorId`);
- CHECK `MentorAssignment_end_pair` (`endedAt` and `endedById` set together);
- trigger `MentorAssignment_immutable` — `menteeId`, `mentorId`,
  `assignedById`, `assignedAt` and `reason` never change; `endedAt` is set
  once; a row is never deleted (re-assigning is an end plus a new row);
- trigger **`MentorAssignment_mentor_is_not_student_or_officer`** — reads the
  mentor's `User` row `FOR SHARE` (the concurrency pattern migration
  `20261010100200` established for `Accommodation`) and refuses a `mentorId`
  whose role is `STUDENT` or `PLACEMENT_OFFICER`. A placement officer must
  never be the mentor of record: the at-risk list exists to route a student
  *away* from analytics and towards a conversation;
- trigger `MentorAssignment_no_truncate`.

### `PlacementDrive` and `DriveEligibilityDecision`

`PlacementDrive`: `id`, `companyId String?` (→ existing `Company`),
`companyName String`, `tier ReadinessTier`, `driveOn DateTime @db.Date`,
`thresholdScore Int?`, `eligibleBatchYear Int?`,
`eligibleDepartmentCodes String[]`, `notes String?`, `createdById`,
`createdAt`, `archivedAt DateTime?`. CHECKs: `thresholdScore IS NULL OR
BETWEEN 0 AND 100`; `length(btrim(companyName)) >= 2`. Index
`[driveOn, tier]`.

`DriveEligibilityDecision`: `id`, `driveId`, `userId`,
`decision DriveEligibility`, `reason String`, `decidedById String` **NOT
NULL** (→ `User`), `decidedAt`, `readinessSnapshotId String?`.

- `@@unique([driveId, userId])` — one decision per student per drive;
- CHECK `DriveEligibilityDecision_reason_present`
  (`length(btrim(reason)) >= 10`);
- trigger `DriveEligibilityDecision_append_only` — UPDATE and DELETE are
  refused outright; changing a decision is a new drive-level decision with
  its own reason, so the record of what was decided and why survives;
- trigger `DriveEligibilityDecision_no_truncate`.

Together with the NOT NULL actor, these are why no job and no raw-SQL
shortcut can produce an automatic eligibility row.

### `PlacementExport` and `ProfileExport`

`PlacementExport`: `id`, `requestedById`, `requestedAt`, `filters Json`,
`columns String[]`, `rowCount Int`, `sha256 String`. The CSV's first line
names the requester, the run date and this id, so a leaked file is
attributable to a person rather than to "the dashboard". CHECK
`array_length(columns, 1) >= 1`; trigger `PlacementExport_append_only`.

`ProfileExport`: `code String @id` (24 url-safe chars, the public verification
code), `userId`, `kind ProfileExportKind`, `payload Json` (the frozen attested
facts), `rulesVersion Int`, `signature String`, `algorithm String @default("HMAC-SHA256")`,
`issuedAt`, `expiresAt DateTime?`, `revokedAt DateTime?`, `revokedById String?`.

- CHECK `ProfileExport_revoke_pair` (`revokedAt` and `revokedById` together);
- CHECK `ProfileExport_expiry_after_issue` (`expiresAt IS NULL OR expiresAt > issuedAt`);
- CHECK `ProfileExport_payload_object` (`jsonb_typeof(payload) = 'object'`);
- trigger `ProfileExport_payload_frozen` — `payload`, `signature`,
  `rulesVersion`, `issuedAt` and `userId` never change; only `revokedAt` /
  `revokedById` may be set, once. A signature over a mutable payload verifies
  nothing;
- trigger `ProfileExport_no_truncate`.

Volume and retention: 5,000 students × 365 runs ≈ 1.8 M snapshot rows/year at
roughly 1 KB of jsonb — unremarkable next to the 7 M submissions/year the
schema is designed against, and far cheaper than a change-detection scheme
that would break the single-index-scan dashboard. Retention is **400 days**
(one full placement cycle plus the recalibration window) under the existing
`PlatformSetting` key `retention`, purged by the existing job in batches of
10,000 and suspended by `legalHold` like everything else.

## 4. Pure modules in `packages/shared`

Everything arithmetic, policy or ordering is pure and unit-tested. Nothing in
this list touches the clock, the database or `node:crypto`.

| Module | Exports | Why pure |
|---|---|---|
| `readiness.ts` | `READINESS_RULES_V1`, `READINESS_RULES_VERSION`, `READINESS_RATING_MIN_CONTESTS = 8`, `READINESS_FRAMING`, `TIER_WEIGHTS`, `topicBreadth()`, `coverage()`, `consistency()`, `readinessScore()`, `componentGaps()`, `nextAction()` | The disputed number must be recomputable years later from the stored component values and `rulesVersion`, exactly as `rating.ts` makes a disputed rating recomputable. |
| `percentile.ts` | `percentileRank()`, `bucketise()`, `MIN_PERCENTILE_COHORT = 30` | The frozen-distribution rule (decision 4) only holds if the percentile is a function of a distribution object, not of a live query. |
| `readiness-copy.ts` | `TIER_LABEL`, `TIER_BLURB`, `COMPONENT_LABEL`, `MISSING_REASON_LABEL` | One place for every string a test asserts on; also keeps the forbidden-words surface small. |
| `placement-export.ts` | `PLACEMENT_EXPORT_COLUMNS` (the declared column set, as data), `placementCsvHeader()`, `placementCsvRow()`, `assertExportColumns()` | The column allowlist *is* the privacy boundary for exports; as data it can be asserted against the schema in a test instead of reviewed by eye. |
| `at-risk.ts` | `AT_RISK_NO_ACTIVITY_DAYS = 7`, `AT_RISK_SERVICE_SCORE = 40`, `AT_RISK_DRIVE_WINDOW_DAYS = 183`, `atRiskReasons()`, `orderAtRisk()` | The ordering is policy ("longest silent first", never by score) and belongs where a test can pin it, not in a `ORDER BY` inside a page. |
| `readiness-distribution.ts` | `DISTRIBUTION_BUCKETS` (0–19, 20–39, 40–59, 60–79, 80–100), `distribution()`, `heatmapCells()` | Returns buckets and counts only — there is no function here that can return a ranked list of students. |
| `export-payload.ts` | `canonicalisePayload()`, `profileExportPayloadSchema`, `EXPORT_PAYLOAD_VERSION` | Deterministic key ordering is what makes an HMAC verifiable across versions; the HMAC itself stays in `apps/web/src/lib/export/signature.ts` so `packages/shared` keeps no `node:crypto` import. |

`READINESS_RULES_V1` holds the spec's weights verbatim, plus the targets the
spec does not give (open question 1):

```
SERVICE  0.35 aptitudePercentile · 0.20 verbalPercentile · 0.25 easyMediumCoverage
         · 0.10 mockInterviewScore · 0.10 consistency
PRODUCT  0.30 mediumUnassistedCoverage · 0.20 topicBreadth · 0.20 aptitudePercentile
         · 0.15 ratingPercentile · 0.10 mockInterviewScore · 0.05 consistency
TOP      0.35 ratingPercentile · 0.30 mediumHardUnassistedCoverage · 0.20 topicBreadth
         · 0.15 mockInterviewScore
targets  SERVICE easyMedium 120 · PRODUCT mediumUnassisted 80, perTopic 4
         · TOP mediumHardUnassisted 120, perTopic 8
```

A unit test asserts each tier's weights sum to exactly 1 (in integer
basis points, so no float drift) — a mistyped weight is otherwise invisible.

## 5. Routes, pages and guards

| Route | File | Guard | Notes |
|---|---|---|---|
| `/placement` | `app/(student)/placement/page.tsx` | the `(student)` layout's `requireUser()` | Own readiness only. Three tier cards, measurable-weight denominator, missing chips, three gaps, one next action, `READINESS_FRAMING`. |
| `/placement/export` (POST action) | `server/actions/placement-export.ts#createProfileExport` | `requireActionUser()` | A student signs their own export. Writes `ProfileExport`; returns the `/verify/<code>` link. |
| `/verify/[code]` | `app/(public)/verify/[code]/page.tsx` | **none, by design** | Public verification, rate-limited through the existing Redis sliding window. Renders the attested facts, the signature status and the issue date. Never email, roll number, section, an integrity band or a flag count. Readable at 320 px with no JavaScript. |
| `/placement-cell` | `app/placement-cell/page.tsx` | `requirePlacementPage()` | Officer dashboard: distributions per tier by department / batch / section. Named `placement-cell` because `app/placement-cell/**` and `app/(student)/placement/**` would otherwise resolve to the same URL — the student route keeps the spec's `/placement`. |
| `/placement-cell/heatmap` | `…/heatmap/page.tsx` | `requirePlacementPage()` | 14 topics × section, counts in every cell. |
| `/placement-cell/at-risk` | `…/at-risk/page.tsx` | `requirePlacementPage()` | Ordered by `lastActiveAt ASC`; each row shows the named mentor and a "ask the mentor to follow up" form submit. Virtualised. |
| `/placement-cell/aptitude` | `…/aptitude/page.tsx` | `requirePlacementPage()` | Section-level gaps, through the Phase 7 adapter. |
| `/placement-cell/students/[id]` | `…/students/[id]/page.tsx` | `requirePlacementPage()` + `loadPlacementStudentDrilldown()` | The audited individual view. `noStore()`. Allowlisted columns only. |
| `/placement-cell/drives`, `/drives/new`, `/drives/[id]` | `…/drives/**` | `requirePlacementPage()` | Per-drive count ("214 students at PRODUCT ≥ 70") and the recorded human eligibility decisions. |
| `/placement-cell/export` (POST route) | `app/api/placement/export/route.ts#POST` | `requirePlacementAction()` first, before the body is read | CSV of `PLACEMENT_EXPORT_COLUMNS`; writes `PlacementExport` + an audit row. |
| `/mentor` | `app/mentor/page.tsx` | `requireMentorPage()` | My mentees (one index scan on `[mentorId, endedAt]`). Fails closed: no active assignment, no students. |
| `/mentor/[menteeId]` | `app/mentor/[menteeId]/page.tsx` | `requireMentorPage()` + `requireScopedMentee()` | One mentee's coverage and activity — the same allowlisted columns as the officer view, plus nothing. |

New guards in `apps/web/src/lib/auth/guards.ts` /
`lib/auth/mentor-scope.ts`: `requirePlacementPage`, `requirePlacementAction`
(`PLACEMENT_OFFICER`, `SUPER_ADMIN`), `requireMentorPage`,
`requireMentorAction` (`TA_MENTOR`, `ADMIN`, `SUPER_ADMIN`), and
`requireScopedMentee()` returning a branded `ScopedMenteeId` — the mentor
mirror of `ScopedStudentId`.

Capabilities added to `capabilities.ts`: `placement.analytics`,
`placement.drilldown`, `placement.export`, `placement.drives`,
`placement.eligibility.decide` (all `PLACEMENT_OFFICER` + `SUPER_ADMIN`);
`mentor.mentees.view` (`TA_MENTOR` + `ADMIN` + `SUPER_ADMIN`); and
`mentor.discussion.moderate`, `mentor.solution.editorial`,
`mentor.doubts.answer` declared with
`arrives: { phase: 11, models: ["DiscussionPost", "DoubtThread"] }` because
discussion is deferred (§6) and the spec requires the moderation role to ship
with it rather than after it. `Capability.arrives.phase` is currently typed
`5 | 6 | 8` and must be widened to include `11` — a one-line change, listed
here so it is not discovered as a type error mid-slice.

`PLACEMENT_OFFICER` gains **no** authoring, moderation, role-change or
account-status capability, and `TA_MENTOR` gains no problem authoring, no
assessments and no role changes. The spec's reasoning is carried across
verbatim: the three roles the college asked for would hand every placement
officer problem-deletion and role-change power, and five roles with clean
boundaries is barely more work and far safer. Test 5 states this as an
exact-set equality rather than a spot check.

## 6. Tests the phase is gated on

From the spec's "Done when", plus what this design implies.

1. **`topicBreadth` uses MIN** — unit: a property test over the 14 topics
   (the result equals the minimum ratio for every random vector), the
   explicit **200-array / 0-graph** fixture scoring low in PRODUCT and TOP,
   and an assertion that the module exports no mean/average of per-topic
   values.
2. **Missing components render as missing** — three layers: the resolver
   returns `MISSING` with a reason and never a substituted `0`; the DB CHECK
   `ReadinessSnapshot_score_le_available` refuses a renormalised row through
   Prisma **and** through raw SQL; the card renders a chip per missing
   component plus the measurable-weight denominator.
3. **`PLACEMENT_OFFICER` cannot reach notes, drafts or chat content by any
   route** — runtime: every bound placement page, route and action called as
   each role, asserting the officer never receives `Note`, `CodeDraft`,
   `SubmissionSource` or `SubmissionTestDetail` content; static:
   `tests/repo/placement-fence.test.ts` with its model-classification rule,
   so an unclassified private model added later fails the build.
4. **Every drill-down writes an audit row** — DB: one
   `loadPlacementStudentDrilldown()` call produces exactly one `AuditLog` row
   with action `placement.student.view`, `sensitivity: SENSITIVE` and the
   student as `targetUserId`; static: the `audit(` call precedes any `db.`
   access in that function, and the drill-down page calls `noStore()`.
5. **The role matrix, as an exact set** —
   `capabilityMatrix().PLACEMENT_OFFICER` equals exactly the five placement
   keys plus the self-service keys, and `.TA_MENTOR` exactly the mentor keys
   plus self-service. A new capability silently granted to either role fails.
6. **No ranking by readiness** — the fence asserts no placement or mentor
   query orders by `serviceScore` / `productScore` / `topScore`, and that
   `readiness-distribution.ts` exports no function returning per-student
   rows.
7. **Percentile determinism** — two students with identical inputs in one run
   receive identical scores (the frozen `cohortStats`), and a rerun of the
   same `computedOn` with the same inputs is byte-identical in the computed
   columns.
8. **The rating floor** — `contestsRated < 8` yields
   `MISSING / TOO_FEW_RATED_CONTESTS`, and TOP's `availableWeight` drops by
   exactly 35.
9. **Weights sum to 1** per tier, in integer basis points.
10. **The eligibility decision needs a human** — a decision row without
    `decidedById`, or with a reason under 10 characters, is refused by the
    database; UPDATE and DELETE on a decision are refused; the action writes
    the audit row.
11. **The signed export** — a valid signature verifies, a tampered payload
    fails, a revoked code renders as revoked, the payload holds no email,
    roll number, integrity band or flag count, and the `payload_frozen`
    trigger refuses an edit.
12. **Readiness never reaches the public profile** — `/u/[handle]` renders no
    readiness score for any visibility setting (the model's own rule: "never
    email, roll number, department or scores").
13. **The mentor fence** — a mentor with no active assignment sees nobody; a
    mentor cannot read a non-mentee by id; `MentorAssignment` refuses a
    second active row per mentee, a self-assignment, and a `PLACEMENT_OFFICER`
    or `STUDENT` as mentor.
14. **The forbidden-words fence stays green** over every new string, comment
    and doc in the phase, including this file.

Accessibility requirements — requirements, not polish:

- the **weakness heatmap is a real `<table>`** with a `<caption>`,
  `scope="col"` / `scope="row"` headers and the **count printed in every
  cell**; colour is a redundant encoding only, and no `*.tsx` carries a
  hardcoded hex (existing lint rule);
- a readiness score is **never a bare coloured ring**: score, tier label and
  the measurable-weight denominator are all text, with the missing-component
  chips tied to the meter by `aria-describedby`;
- the distribution chart ships an **accessible table of the same bucket
  counts**, not an `aria-label` summary;
- any list over ~200 rows is **virtualised** (§7: do not render 5,000 DOM
  rows) — the at-risk list and the cohort lists;
- "ask the mentor to follow up" is a **form submit with a visible focus ring**
  and a confirmation toast, never a `mailto:` and never an automated message
  to the student;
- the CSV control names the row count and the column set **before** the
  download starts;
- `/verify/[code]` is readable at 320 px and renders fully without
  JavaScript;
- `--muted` stays within the §7 floor, and no status is conveyed by colour
  alone anywhere on these pages.

Manual (spec's own line): review the readiness card for **three seeded
students with deliberately lopsided profiles** — 200 arrays / 0 graphs, a
strong aptitude profile with almost no coding, and a strong rating with no
aptitude attempt — and confirm the three gaps, the next action and the
framing copy are each correct. Then run the nightly job `--dry-run`, read its
report, run it live, and read one student's `components` breakdown end to
end. Record both in `docs/RUNBOOK.md` §3 with a date.

## 7. Open questions to record in `docs/OPEN-QUESTIONS.md`

Each with the narrower reading this design implements (§0: "ask before
inventing — implement the narrower reading and note it").

1. **The coverage and per-topic targets are not in the spec.** Narrower
   reading: placeholder targets in `READINESS_RULES_V1` (SERVICE easy+medium
   120; PRODUCT medium 80 and 4 unassisted per topic; TOP medium+hard 120 and
   8 per topic), in one versioned constant so changing them is one reviewed
   edit and one new `rulesVersion`. Flagged for the placement cell before the
   first drive.
2. **Which cohort the percentiles are taken in.** Narrower reading: the
   student's own `batchYear`, college-wide across departments — the batch
   being placed is the comparison that matters — with
   `MIN_PERCENTILE_COHORT = 30` below which the component is MISSING rather
   than noisy (the same floor as `MIN_RATED_PARTICIPANTS`). Revisit if the
   cell wants department-relative numbers.
3. **The contest floor for readiness.** §7 says "~8–12". Narrower reading:
   `READINESS_RATING_MIN_CONTESTS = 8`, the earliest the range permits;
   `PROVISIONAL_CONTESTS = 5` stays a display rule and is not reused here.
4. **Which aptitude attempt feeds the percentile.** Narrower reading: the
   most recent completed attempt per section family within 180 days. "Best
   ever" overstates current preparation and rewards retries; a mean of the
   last three is a modelling choice the cell has not asked for.
5. **`mockInterviewScore` has no source until Phase 11.** Narrower reading:
   permanently `MISSING / NO_SOURCE_YET`; the weight is reported as not
   measurable and never redistributed. Revisit when the mock-interview
   scheduler ships.
6. **Whether a partial score is renormalised to 100.** Narrower reading: no.
   The score is reported out of `availableWeight`, and the database CHECK
   makes the alternative unstorable.
7. **Whether the weights should become a super-admin setting.** Narrower
   reading: no — a versioned code constant, because the spec frames
   recalibration as a deliberate act against real outcome data. The XP rules
   are an editable setting with `rulesVersion` on every row; if the cell
   later wants the same for readiness, the snapshot already records the
   version it was scored under.
8. **Whether `PLACEMENT_OFFICER` should be `AdminScope`-scoped.** Narrower
   reading: college-wide over the allowlisted columns only. `AdminScope` is
   modelled for `ADMIN`; reusing it would be inventing a scope the spec does
   not describe, and the column allowlist is the boundary the spec actually
   names.
9. **Which assessment scores an officer sees.** Narrower reading: released
   scores only, each labelled with whether it may feed shortlisting (true
   only for `affectsPlacementEligibility`, hence `LAB_SUPERVISED` only) —
   and never an integrity band, flag count or `ProctorEvent` row.
10. **Whether `GRADUATED` / `ARCHIVED` students are snapshotted nightly.**
    Narrower reading: no — the candidate set is `ACTIVE` and
    `SOFT_RESTRICTED`. Existing snapshots are retained so a past cohort stays
    explainable.
11. **Whether a `SOFT_RESTRICTED` student still appears to an officer and a
    mentor.** Narrower reading: yes, and still snapshotted — a restriction
    withholds a result from the public leaderboard, it does not hide a
    student from the person whose job is to intervene.
12. **`ReadinessSnapshot` retention.** The spec's retention table is silent.
    Narrower reading: 400 days under the existing `retention`
    `PlatformSetting` key, `legalHold` honoured.
13. **The declared CSV column set.** Narrower reading:
    `PLACEMENT_EXPORT_COLUMNS` = roll number, name, batch, department,
    section, solved easy/medium/hard, unassisted total, rating (with the
    provisional marker), the three tier scores with their measurable weights,
    the limiting topic, last active date, released assessment score count. No
    email, no phone, no bio, no notes.
14. **"Within 6 months of a drive" for the at-risk list.** Narrower reading:
    the nearest non-archived `PlacementDrive` whose `eligibleBatchYear` /
    `eligibleDepartmentCodes` include the student, within
    `AT_RISK_DRIVE_WINDOW_DAYS = 183`. With no such drive, only the
    7-days-inactive rule applies.
15. **The export signing secret.** Narrower reading: a dedicated
    `EXPORT_SIGNING_SECRET` in the env schema, not `AUTH_SECRET` — a
    verification code is handed to outsiders and must not be derived from the
    session secret. Rotation invalidates old codes, which the `/verify` page
    must state rather than render as "forged".

## Sharp edges — the five things most likely to be built wrongly

1. **A mean sneaking into `topicBreadth`.** It will look reasonable in review
   ("the min is harsh"). It is the one piece of arithmetic the spec explains
   its own reasoning for. The MIN, its argmin and the 200-array/0-graph
   fixture ship in slice 9a, before anything can depend on a softer version.
2. **A missing component silently becoming 0.** `0` is the default of every
   `Int` column, the natural `??` fallback and the natural zod default. The
   defences are deliberately redundant: the resolver returns a tagged union
   with no numeric fallback, the DB CHECK `score <= availableWeight` refuses
   the row, and the card renders the denominator as text.
3. **`/placement` and `/placement-cell` colliding.** `app/(student)/placement/`
   and `app/placement/` resolve to the same URL and Next.js fails the build.
   The officer surface is `placement-cell`; the spec's student route keeps
   `/placement`.
4. **A cached drill-down with no audit row.** React and Next will happily
   serve the second view of a student from cache, and "every drill-down writes
   an audit row" then fails silently and only for repeat views. `noStore()`
   on the page, the audit call inside the single loader, and a fence rule
   asserting both.
5. **Adding `app/placement-cell/**` or `app/mentor/**` to a fence exemption
   list.** `tests/repo/student-exposure.test.ts` treats every `src/app`
   entry outside `admin/`, `super/`, `api/judge/` and `api/admin/` as a
   student entry, so the new pages are fenced against reference solutions and
   hidden tests by default. That is correct and intended — a placement page
   has no business reading a reference solution. Do **not** add these paths
   to `ENTRY_EXCLUDED` or `SENSITIVE_PREFIXES`; and do not name the new query
   files `admin-*.ts`, which would pull them into the AdminScope fence's
   staff-only semantics instead of the new placement fence's.

Two further files are shared with other phases and must be edited
surgically, in slice 9d and 9b respectively: `apps/web/src/lib/auth/capabilities.ts`
(two new tiers, `arrives.phase` widened) with `docs/SECURITY.md` regenerated
by `RECX_UPDATE_DOCS=1`, and `packages/shared/src/governance.ts`
(`SCHEDULER_JOB_NAMES` gains `readinessSnapshot`).


---

## Resolutions (settled 2026-10-20, before any Phase 9 code)

An independent pass over this document returned **needs-revision**: seven
contradictions and ten uncovered spec requirements, listed verbatim below.
**All seventeen are settled here.** Where a resolution differs from the body
above, the resolution wins.

### R1 — the dependency claim is now true

The review was right when it was written and is out of date now: Phases 7 and
8 are built and **gated on both platforms**. `AptitudeUserTopicStat`,
`MockAttempt`, `MockPattern`, `AccountRestriction`, `CalendarDay` and
`LeaveException` are all in `packages/db/prisma/schema.prisma`, and the Phase
7 and Phase 8 gate rows are in `docs/RUNBOOK.md` §3 with dates. So the 55 %
of SERVICE and 20 % of PRODUCT that rest on aptitude have a real source. §0's
claim stands as written; nothing was repaired by hedging, it was repaired by
building them.

### R2 — a dry run writes no snapshots at all

`ReadinessRun.computedOn` stays the primary key, and the `dryRun` column is
**deleted**. A dry run computes, reports and writes NOTHING — the same shape
Phase 8c shipped and gated, and for the same reason: a dry run that wrote
rows indistinguishable from live ones would be a dry run whose output nobody
could trust, and a `dryRun` column plus a filter is an invitation to forget
the filter in one query.

So: `--dry-run` returns the report and the `SchedulerJobStatus` row, and the
manual gate ("read its report, then run it live") reads that report. One
primary key, one row per campus day, no filter to forget.

### R3 — one component entry per TIER, not one per component

The `components` JSON is keyed by tier and then by component:

```json
{"PRODUCT":{"TOPIC_BREADTH":{"state":"PRESENT","value":0.17,"limitingTopic":"GRAPHS","perTopicTarget":4}}}
```

`topicBreadth` is tier-specific — PRODUCT targets 4 unassisted per topic and
TOP targets 8 — so a single `TOPIC_BREADTH` entry genuinely cannot hold both,
and §4's whole purpose ("the disputed number must be recomputable years later
from the stored component values and `rulesVersion`") fails without the tier
key. The scalar columns `topicBreadthProduct` / `topicBreadthTop` and
`limitingTopicProduct` / `limitingTopicTop` stay for indexing the heatmap;
the JSON is the record of how each score was reached, and a test asserts the
two agree.

### R4 — the at-risk list orders by the snapshot's own column

`ORDER BY lastActiveOn ASC` — the snapshot's `@db.Date` column, not
`User.lastActiveAt`. The no-join claim was the right design and the ORDER BY
was the mistake: an officer list that joined `User` for a sort column would
join it for 5,000 rows on every page load, and `lastActiveOn` is copied into
the snapshot precisely so the cohort pages never touch `User`.

Snapshot-day granularity is also the honest unit here: an at-risk list is
about days of silence, and a list that re-ordered itself between two page
loads because somebody submitted at 11:58 would be a list nobody could work
through.

### R5 — every officer surface discloses `availableWeight`

The review found the real hole: the design engineers "missing, never silently
as zero" into the student card and the database, then drops it on the cohort
dashboard, the drive count and the at-risk rule — where a 70 on a tier whose
`mockInterviewScore` is permanently missing is a 70 **out of 85**.

So, three changes:

- `DISTRIBUTION_BUCKETS` are buckets of **`score / availableWeight`**, a
  percentage of what was measurable, and every chart says so in its caption
  and its `aria-label`;
- the per-drive count takes a threshold on the same normalised figure, and
  the page states the denominator next to the number ("214 students at
  PRODUCT ≥ 70 % of measurable; `mockInterviewScore` unmeasured for all");
- `AT_RISK_SERVICE_SCORE` is likewise normalised, and the at-risk row shows
  both the raw score and the available weight.

The alternative — comparing a raw 70 against an absolute 70 — would quietly
mark a whole cohort as under-prepared because of a component nobody has
built. That is the failure mode the spec's "show missing as missing" exists
to prevent, and it does not stop at the student's own card.

### R6 — `auditLog` is forbidden to READ on placement surfaces, and written
only through `audit()`

`PLACEMENT_FORBIDDEN_DELEGATES` is `Note`, `CodeDraft`, `SubmissionSource`,
`SubmissionTestDetail`, **`Accommodation`** (see R-U7) and **`AuditLog`**.

The read/write split the design owed: placement code may not call
`db.auditLog.*` at all — not `findMany`, not `count`. It records a drill-down
by calling `audit()`, which is the same helper every other sensitive
mutation uses and which no placement module can read back. An officer who
could read `AuditLog` could read other officers' `SENSITIVE` rows, which is
both a privacy failure and a way to learn which students the placement cell
is quietly worried about.

### R7 — the eligibility guarantee is restated honestly

The design claimed a NOT NULL actor plus an FK made an automatic eligibility
row impossible. It does not: any job holding a staff user id satisfies both.

What ships instead, and what is actually enforced:

- `DriveEligibilityDecision.decidedById` NOT NULL with an FK, and
  `char_length(btrim(reason)) >= 10` — so a row always names a person and a
  reason;
- a **deferred constraint trigger** `recx_refuse_eligibility_without_audit`
  requiring, at commit, an `AuditLog` row for that decision in the same
  transaction. That is the spec's "a human decision recorded in the audit
  log" expressed where no code path can route around it — exactly the shape
  Phase 8 used for `AccountRestriction_requires_event`;
- and the honest sentence in the doc: the database cannot tell a human from
  a job holding a human's id. What it can enforce is that the decision is
  **attributable and audited**, and that is what it enforces.

### R-U1 — the export reuses the LMS certificate pattern, named

`ProfileExport` reuses the pattern, stated: a random public `code`, an
`HMAC-SHA256` signature over a **canonical** payload, a `/verify/[code]`
route that re-derives the signature server-side, and a `revokedAt` so a
student can withdraw a link they have already sent. The secret is
`EXPORT_SIGNING_SECRET`, separate from `AUTH_SECRET`, so a leaked verify
secret cannot mint sessions.

What it does NOT reuse is the LMS's database: §7's "do not share a database
with the LMS" holds, and `ProfileExport` is a REC Code table. The reuse is of
the SHAPE — code, signature, verify route, revocation — not of the storage.

### R-U2 — SERVICE's coverage counts assisted solves, deliberately

The spec names SERVICE's component `easyMediumCoverage` and the other two
`mediumUnassistedCoverage` and `mediumHardUnassistedCoverage`. That omission
is read as meaning what it says: **SERVICE counts a solve however it was
reached**, and the two higher tiers count only unassisted ones.

The reason it is the right reading: a service-tier interview asks whether you
can write a loop and a string manipulation at all, and a student who got
there with a hint can do that. A product or top interview asks whether you
can get there alone. So `coverage()` takes an `unassisted: boolean` and the
three tiers pass different values — one function, three configurations, and a
test per tier asserting which one counts a hinted solve.

### R-U3 — the per-difficulty unassisted counts, with their query

`UserStats` carries one scalar `assistedSolves`, so it cannot answer "medium
unassisted". The source is `UserProblemStatus × Problem`, in **one aggregate
for the whole college** rather than one per student:

```sql
SELECT ups."userId", p."difficulty", ups."assisted", count(*)::int AS n
  FROM "UserProblemStatus" ups
  JOIN "Problem" p ON p."id" = ups."problemId"
 WHERE ups."status" = 'SOLVED'
 GROUP BY 1, 2, 3
```

One sequential pass, read once per nightly run and held in memory for the
whole cohort. The design's "no new counter, no new denormalisation" survives;
its "no join" did not, and the join is a single grouped scan rather than
5,000 queries. An index on `UserProblemStatus(status)` is added for it.

`topicBreadth` needs no join at all: `UserStats.topicSolved` and
`topicAssisted` are already per-topic JSON maps, and unassisted-per-topic is
their difference.

### R-U4 — the next action names its points, and the format is a constant

The spec gives a literal output: `"+9 points available: graphs, 6 unassisted
mediums"`. So:

- points available for a component = `weight × (1 − value) × 100`, rounded,
  which is exactly how many of the tier's 100 points that component is
  currently leaving on the table;
- `nextAction()` returns `{ points, componentLabel, detail }` and the
  renderer composes `+{points} points available: {detail}`;
- the three largest gaps are ranked by that same points figure, so the
  headline action and the gap list cannot disagree;
- a test asserts the exact string for a seeded lopsided profile.

Missing components contribute **no** points-available: a component with no
source is not a gap the student can close, and telling them otherwise would
send them to look for something that does not exist.

### R-U5 — the TA_MENTOR badge is a Phase 9 constant, not a Phase 11 feature

`mentor.doubts.answer` stays at `arrives: { phase: 11 }`, but the visible
marker does not wait for it: `MENTOR_BADGE_LABEL` ("TA / mentor") and the
`MentorBadge` component ship now, rendered beside a mentor on
`/placement`'s at-risk routing and on the mentee list. The spec names the
badge as part of the ROLE, and a role whose marker arrives two phases after
the role is a role students cannot recognise.

### R-U6 — the CSV carries assessment SCORES, as the spec says

Open question 13 narrowed the declared set to a count of released assessment
scores. Un-narrowed: the spec's allowlist is "solved counts, rating,
readiness, assessment scores and activity dates", and it is the privacy
boundary **in both directions** — narrowing a permitted field is as much a
departure as widening a forbidden one. The CSV carries released assessment
scores, and only released ones.

### R-U7 — `Accommodation` is forbidden to placement surfaces

§7: "Do not expose a disability label to a reviewer or invigilator." An
officer explaining a low assessment score is exactly that reviewer, so
`Accommodation` joins `PLACEMENT_FORBIDDEN_DELEGATES` and test 3's assertion
list. The accommodation's EFFECT (extra time) is already invisible on the
officer surfaces, which read scores and not attempt clocks.

### R-U8 — "qualifying" is defined, and it is the spec's own word

`consistency` = **active days** in the last 30 ÷ 30, where an active day is
an `ActivityDay` row with `submissions + solved > 0`. The spec's parenthetical
says "active days", `ActivityDay` is documented as "any activity", and the
draft's silent substitution of "qualifying" is dropped.

The one narrowing that IS taken, and noted: a day with an `ActivityDay` row
but no submission and no solve — a student who opened a problem and left — is
not an active day. Otherwise consistency measures browsing.

### R-U9 — the unsatisfiable half of the Done-when test, said out loud

"PLACEMENT_OFFICER cannot reach notes, drafts or **chat content** by any
route": no model holding discussion drafts or assistant chat content exists
(Phase 11+). Test 3 therefore asserts the models that DO exist — `Note`,
`CodeDraft`, `SubmissionSource`, `SubmissionTestDetail`, `Accommodation`,
`AuditLog` — and a second test asserts the CLASSIFICATION RULE: every model
is either in the readable allowlist or the forbidden list, so a future
`Discussion` or `AssistantMessage` model fails the fence the day it is added
rather than the day somebody notices. That is how the other half is
discharged, and the doc says so rather than implying the test is complete.

### R-U10 — what `/placement` renders with no snapshot

Three stated empty states, because "no readiness yet" has three different
causes and only one of them is the student's to act on:

- **no snapshot ever** (a new student, or before the first nightly run): the
  page explains that readiness is computed overnight, shows what it will be
  computed FROM, and links to practice. It does not show zeros.
- **a snapshot older than 48 hours**: the figures render with the date they
  were computed, and a line saying so. A stale number labelled stale is
  useful; an unlabelled one is a lie.
- **excluded** (`GRADUATED` / `ARCHIVED`): the page says the account is no
  longer being assessed, and offers the signed profile export, which is the
  thing a graduate actually wants.

### And one thing the review did not raise

`mockInterviewScore` is 10 % of SERVICE, 10 % of PRODUCT and **15 % of TOP**,
and has no source in this plan at any phase — the mock-interview scheduler is
Phase 11+. It is therefore permanently `MISSING / NO_SOURCE_YET` at launch,
which R5 now makes visible everywhere rather than only on the student's card.

Worth stating plainly in the doc because it is the single largest honesty
risk in the phase: a TOP score is a score out of 85, computed from three
components, and the fourth is not coming this year. The UI says that; the
weights are not quietly renormalised to hide it, because renormalising would
make a student with no interview practice look as ready as one who has had
five.

---

## Review findings (verbatim, as received)

An independent pass over this document against `docs/handoff/SPEC.md` and the
actual repository returned **needs-revision**. These are the items as the
reviewer wrote them; every one is settled above. Each was checkable against a
file or a spec line when it was written (2026-10-19).

### Contradicts the spec or the codebase (7)

1. §0: "Depended on but built by **earlier, already-gated phases of this run**" — Phase 7 and Phase 8 are NOT built. `docs/handoff/phase7/` and `docs/handoff/phase8/` each contain only `DESIGN.md`, HEAD is `ffee0c5 Phase 6b`, and `grep -nE 'Aptitude|MockPattern|MockAttempt|AccountRestriction|CalendarDay|LeaveException' packages/db/prisma/schema.prisma` returns nothing. `aptitudePercentile` + `verbalPercentile` are 55 % of SERVICE and 20 % of PRODUCT, and "the only source" named for them does not exist. The hedge "if either is missing, Phase 9 stops" does not repair the false claim that they are already gated.

2. `ReadinessRun` is unstorable as specified: `computedOn DateTime @id @db.Date` is the sole primary key, yet the model also carries `dryRun Boolean @default(false)` and the dashboard reads "the newest run with `ok = true` and `dryRun = false`". A dry run and a live run cannot coexist on one campus day — and the design's own manual gate says "run the nightly job `--dry-run`, read its report, **run it live**". `ReadinessSnapshot` also takes "a foreign key to `ReadinessRun(computedOn)`", so a dry run either writes snapshots indistinguishable from live ones or the `dryRun` column and its filter are dead.

3. The `components` JSON shape contradicts the columns in the same model. The doc says "one entry per `ReadinessComponent`, so a breakdown is always complete" and gives `{"TOPIC_BREADTH":{"state":"PRESENT","value":0.17,"limitingTopic":"GRAPHS"}}` — a single value and a single argmin. But `topicBreadth` is tier-specific ("PRODUCT … perTopic 4 · TOP … perTopic 8") and the model stores `topicBreadthProduct Int?  topicBreadthTop Int?` and `limitingTopicProduct Topic?  limitingTopicTop Topic?`. One `TOPIC_BREADTH` entry cannot hold both, so §4's stated purpose — "The disputed number must be recomputable years later from the stored component values and `rulesVersion`" — fails for PRODUCT and TOP, the two tiers that use it.

4. Decision 9 claims "every officer aggregate is one index scan with **no join to `User`**", but the §5 route table specifies the at-risk page as "Ordered by `lastActiveAt ASC`" and decision 10 repeats "an at-risk list ordered by `lastActiveAt ASC`". `lastActiveAt` is a `User` column (schema.prisma, `User.lastActiveAt DateTime?`, `@@index([status, lastActiveAt])`); the snapshot's own column is `lastActiveOn DateTime? @db.Date`. Either the no-join claim is false or the specified ORDER BY names a column that is not there.

5. The officer dashboard reads three different scales as if they were one. Decision 2 + decision 5 together guarantee no TOP score can exceed 85 (`mockInterviewScore` is "permanently `MISSING / NO_SOURCE_YET`", 15 % of TOP) and no SERVICE/PRODUCT score can exceed 90, and the CHECK `score <= availableWeight` enforces it. Yet `DISTRIBUTION_BUCKETS` are absolute ("0–19, 20–39, 40–59, 60–79, **80–100**"), the per-drive view counts "214 students at PRODUCT ≥ 70", and `AT_RISK_SERVICE_SCORE = 40` is an absolute cut. Nothing says the officer surfaces disclose `availableWeight` — the design engineers "missing, never silently as zero" into the student card and the DB, then drops it on the cohort dashboard, the drive count and the at-risk rule.

6. The new `PLACEMENT_FORBIDDEN_DELEGATES` drops `auditLog`, which the fence it says it copies forbids. §0 quotes the existing fence correctly — "`FORBIDDEN_DELEGATES = note, codeDraft, submissionSource, auditLog`" (verified at tests/repo/admin-scope.test.ts:90) — but decision 8's placement list is only "`Note`, `CodeDraft`, `SubmissionSource` and `SubmissionTestDetail`". Since the drill-down loader must *write* `audit()`, the design owes an explicit read/write split for `auditLog` on placement surfaces; as written, an officer page may read the audit trail (including other officers' `SENSITIVE` drill-downs and `AuditSensitivity` rows) and the classification rule would let it through as `PLACEMENT_READABLE`.

7. §3's "Together with the NOT NULL actor, these are why no job and no raw-SQL shortcut can produce an automatic eligibility row" overstates what is enforced. `decidedById String` NOT NULL with an FK to `User` stops a *null* actor, not an automatic one: any job holding a staff user id (or the seed's own SUPER_ADMIN) satisfies both constraints and the `length(btrim(reason)) >= 10` CHECK. The spec requires "a human decision **recorded in the audit log**"; the audit row is asserted only for "the action" (test 10), so the DB-level guarantee the design claims does not exist.


### Spec requirements the design does not cover (10)

1. "HMAC-signed profile/resume export reusing the LMS certificate + /verify pattern." — the design contains ZERO occurrences of "LMS" or "certificate" (grep -nI 'LMS\|certificate' docs/handoff/phase9/DESIGN.md returns nothing). It invents a fresh scheme instead (24 url-safe chars, `EXPORT_SIGNING_SECRET`, `algorithm String @default("HMAC-SHA256")`, `canonicalisePayload()`) and never states what it reuses from the LMS pattern, nor confirms §7's "Do not ... share a database with the LMS" is honoured by the new `ProfileExport` table.

2. "0.25 × easyMediumCoverage" (SERVICE) vs "0.30 × mediumUnassistedCoverage" (PRODUCT) vs "0.30 × mediumHardUnassistedCoverage" (TOP) — the spec deliberately names the SERVICE component WITHOUT "Unassisted" and the other two WITH it. The design collapses all three into one generic `coverage()` in its §4 module table and never once says whether assisted solves count toward SERVICE's `easyMediumCoverage`. It is not even listed as an open question, while targets for the same three components are (open question 1).

3. The data source for the per-difficulty UNASSISTED counts is never stated and does not exist. §0 claims "Unassisted-solve accounting … `UserStats.solvedEasy/Medium/Hard`, `assistedSolves` | Every coverage component reads these. **No new counter, no new denormalisation, no aggregation over `Submission`.**" But `UserStats` (schema.prisma:921) carries only a single scalar `assistedSolves Int` with no per-difficulty split, and `UserProblemStatus` (schema.prisma:876) has no difficulty column. `mediumUnassistedCoverage` (0.30 of PRODUCT) and `mediumHardUnassistedCoverage` (0.30 of TOP) therefore require a per-student `UserProblemStatus × Problem` join the design never describes, never indexes and never budgets for 5,000 students nightly.

4. "Always render … one concrete next action (\"+9 points available: graphs, 6 unassisted mediums\")" — the spec gives a literal output format containing the POINTS AVAILABLE. The design lists `nextAction()` as an export and test 1/slice 9a says it asserts "the exact next-action string", but it never states what that string is, never says the string must name a points figure, and nothing in §4 explains how points-available is derived from the weights.

5. TA_MENTOR must "answer doubts with a badge". The design declares `mentor.doubts.answer` with `arrives: { phase: 11 }` but never mentions the badge — no component, no copy constant, no test row for the visible TA_MENTOR marker on an answer.

6. "officers may see solved counts, rating, readiness, assessment scores and activity dates." Open question 13 narrows the declared CSV set to "released assessment score **count**" — a count of scores, not the scores the spec explicitly permits. The spec's allowlist is the privacy boundary in both directions; the design narrows one permitted field without flagging it as the narrowing it is.

7. §7 "Do not expose a disability label to a reviewer or invigilator." §0 lists "**Accommodation**, `ProctorEventKind` (all 25 kinds), the assessment and attempt engine" as available and "Read-only" to Phase 9, and `Accommodation` appears NOWHERE in the design's `PLACEMENT_FORBIDDEN_DELEGATES` (which is "`Note`, `CodeDraft`, `SubmissionSource` and `SubmissionTestDetail`") nor in test 3's assertion list. An officer explaining a low assessment score is exactly the reviewer §7 names.

8. "consistency(active days in last 30 ÷ 30)" — §0 silently substitutes "`consistency` = **qualifying** days in the last 30 ÷ 30" and never defines "qualifying". §0 of the SPEC requires the narrower reading be noted; this one is an unexplained redefinition of the spec's own parenthetical, and `ActivityDay` (schema.prisma:903) is documented as "any activity".

9. "a test asserting PLACEMENT_OFFICER cannot reach notes, drafts or chat content by any route" — no model holding discussion drafts or assistant chat content exists (grep for `model .*(Help|Chat|Assist|Doubt|Discussion)` in schema.prisma returns nothing). The design's test 3 can only assert the four models that do exist; it never says the "chat content" half of the Done-when test is unsatisfiable today and is discharged only by decision 8's future-classification rule.

10. Nothing specifies what `/placement` renders for a student with no snapshot (a new student, or the gap before the first nightly run, or open question 10's excluded `GRADUATED`/`ARCHIVED` students). "Show missing components as missing" is designed in detail; a missing whole snapshot has no stated empty state.

