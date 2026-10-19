# Phase 8 design: inactivity as a policy engine, not a kill switch

Coordinator working notes. Delete `docs/handoff/phase8/` once Phase 8 is gated.

Source of truth: `docs/handoff/SPEC.md` §8. The college asked for "inactive
5 days → account disabled". The spec refuses to build that and spends four
paragraphs saying why. **The refusal and the soft-restriction default are the
requirement**; the policy engine is the mechanism that satisfies the college's
wording without the harm. `autoDisableEnabled` defaults **false**, and §0 is
absolute: no account is hard-disabled by a cron job.

The spec's own reasoning, carried across because it is what the design is for:
in a 5,000-student cohort a literal 5-calendar-day window will, in the first
month, fire on students who are hospitalised, in semester exams, on festival
travel, at an off-campus placement drive, on internship, or whose laptop died.
A disabled account cannot practise, so the policy works against its own stated
goal. It also generates a continuous support queue and teaches students to game
it with a daily one-minute login, which pollutes the engagement data worse than
inactivity does. Hard-disabling a student on medical or exam leave is a real
risk, not a hypothetical.

## 0. What is already built

Phase 8 is the least greenfield phase so far. Checked against the tree on
2026-10-19. **None of this is redesigned.**

Account state and the soft restriction

- **`AccountStatus`** — `ACTIVE SOFT_RESTRICTED DISABLED GRADUATED ARCHIVED`,
  `packages/db/prisma/schema.prisma:31`. Phase 8 adds no member.
- **`SOFT_RESTRICTED` already signs in.** `SIGN_IN_STATUSES` is
  `{ACTIVE, SOFT_RESTRICTED}` in `apps/web/src/lib/auth/session-token.ts:14`,
  `lib/auth/session.ts:19`, `lib/auth/sign-in.ts:47` and
  `lib/accounts/status.ts:23`. The "does not block signing in" half of the
  spec's restriction semantics is done.
- **Contest registration already refuses a restricted account** —
  `apps/web/src/server/actions/contests.ts:50`, with the Phase 8 reasoning
  already in its header comment.
- **`User.status`, `User.lastActiveAt` and the sweep index** —
  `@@index([status, lastActiveAt])` on `User`, `schema.prisma:405`. The index
  §4 calls "the dormancy sweep" exists; the candidate query uses it as-is.
- **Manual status change, end to end** — `apps/web/src/lib/accounts/status.ts`
  (`planStatusChange`, `planRoleChange`, `STATUS_LABEL`),
  `server/actions/super-users.ts` (`setAccountStatus`, `bulkSetAccountStatus`,
  `requestBulkStatusChange`), `lib/privileged/executors/bulk-status.ts`,
  capability `accounts.status`, page `/super/users`. Phase 8 only makes these
  paths *also* write an `AccountStatusEvent`; the plan functions, the
  last-super-admin rule and the session invalidation stay.
- **Cohort filters already treat restricted as current** —
  `ACTIVE_STUDENT_STATUSES` in `lib/auth/scope-where.ts:38`, `CURRENT` in
  `lib/admin/roster-plan.ts:92` and `server/queries/admin-reports.ts:37`.

The scheduler, which is where the nightly job goes

- **`apps/scheduler`** exists with the whole harness: `src/main.ts` (`--once`,
  `--dry-run`, per-job isolation via `runJob`, serial ticks), `src/config.ts`
  (direct non-pooled URL, `withSingleConnection`), `src/job-status.ts`
  (`recordJobStatus` → `SchedulerJobStatus`, read by `/super/jobs`).
  `main.ts:27` already reserves the slot: "Later phases add the dormancy
  sweep … to this same loop."
- **`SCHEDULER_JOB_NAMES`** — `packages/shared/src/governance.ts:95`. Phase 8
  appends one member, `"inactivitySweep"`.
- **`GovernanceSweepJob`** — `apps/scheduler/src/governance.ts` is the exact
  shape to copy: a pure classifier (`classifyPrivilegedOperation`) that mirrors
  the SQL predicate, a dry-run branch that only counts, and one transaction per
  category whose `UPDATE … RETURNING` and audit rows commit together.
- **Submission cancellation already has both halves** —
  `JudgeQueuePort.remove(lane, id)` at `apps/scheduler/src/queues.ts:102`, and
  the database-side shape at `apps/web/src/lib/judge/validation.ts:540`
  (`status: "CANCELLED", judgeState: "CANCELLED", claimToken: null,
  leaseExpiresAt: null`). The reconciler never re-enqueues a `CANCELLED` row.
- **Retention and legal hold** — `RETENTION_SETTING_KEY`,
  `retentionSettingSchema` in `packages/shared/src/governance.ts`, enforced in
  `apps/scheduler/src/reconciler.ts`. Phase 8 adds no purge.

Capability wiring that constrains the slicing

- **`calendar.manage` is already declared** — `apps/web/src/lib/auth/
  capabilities.ts:171-177`, SUPER_ADMIN only, label "Edit the academic calendar
  and approve MEDICAL leave", `actions: []`,
  `arrives: { phase: 8, models: ["CalendarDay", "LeaveException"] }`.
  `apps/web/test/capabilities.test.ts` **fails the moment either model appears
  in `schema.prisma` while the action list is still empty** (see
  `docs/handoff/phase4/designs/super-governance.md:6`). So the migration that
  adds `CalendarDay` and `LeaveException` and the actions that manage them are
  one slice, not two. Getting this wrong costs a whole slice.
- `docs/SECURITY.md:166` carries the generated row for it, and the same test
  checks the table — the doc line changes in that slice too.

Data the counter reads

- **`ActivityDay`** — `@@id([userId, date])` with `submissions`, `accepted`,
  `solved`, `xp`, `xpEasy`, `activeSeconds`, `@@index([date])`,
  `@@index([userId, date(sort: Desc)])`, `schema.prisma:903`. §4 already names
  it "the streak source, heatmap, **and the inactivity evidence**". Phase 8
  adds no activity table and no new write to this one.
- **`Notification`** — `schema.prisma:1188`, with `kind/title/body/link`.
  **`EmailOutbox`** + `OutboxDrainJob` for mentor and (opt-in) parent mail.
  No new notification or mail mechanism.
- **`PlatformSetting`** (`key`/`value Json`, `schema.prisma:1293`) for the
  non-versioned knobs. **`AuditLog`** with the per-day hash chain and
  `appendAuditEntriesInTx` from `@recx/db/audit`.
- **Campus calendar arithmetic** — `CAMPUS_TIME_ZONE = "Asia/Kolkata"`,
  `campusDay`, `campusDayDate`, `dayDifference`, `monthKey` in
  `packages/shared/src/time.ts`. The 02:00 Asia/Kolkata cadence and every day
  subtraction reuse these; Phase 8 writes no new date formatter.
- **`Accommodation`** (Phase 4, `schema.prisma:1627`) and
  **`AccommodationKind`** are complete and **not touched**. A `LeaveException`
  is a different object: an accommodation changes how a student sits an exam, a
  leave exception excludes days from a counter. Do not merge them.
- **`ProctorEventKind`** — all 25 kinds, `schema.prisma:265`. Untouched.
- **Assessment, `AssessmentAttempt`, `ExamSession`, `AttemptStatus`** (Phase
  6a/6b, `schema.prisma:2142`, `:2318`, `:2253`, `:2099`). The never-sweep
  guards read these; Phase 8 adds no column to them.

Fences every new migration and page must satisfy

- `packages/db/test/support/guard-catalog.ts` — `GUARD_FUNCTIONS`,
  `TRUNCATE_GUARDED`, the `GuardTrigger` list and the CHECK list. Adding a
  guard to a migration means adding it here; `frozen-coverage.test.ts` (static)
  and `guard-state.db.test.ts` (live) enforce it.
- `packages/db/test/enum-parity.test.ts` — a Prisma enum that mirrors a
  `@recx/shared` constant must hold the same members in the same order.
- `tests/repo/forbidden-words.test.ts`, `tests/repo/student-exposure.test.ts`,
  `apps/web/test/capabilities.test.ts`, `apps/web/test/capability-matrix.test.ts`.
- Leaderboard hiding is **one** `Prisma.sql` fragment plus **one** pure
  function: `HIDDEN` at `apps/web/src/server/queries/leaderboard.ts:43` and
  `isHidden()` at `:235`. Phase 8 extends those two and builds nothing new.
- XP finalise is `apps/web/src/lib/progress/apply.ts`
  (`applySubmissionProgress`, `meta` objects at `:163` and `:192`). The
  `meta.restricted` marker is a field added there, not a new path.

Not built, and therefore Phase 8's work: `RestrictionStage`,
`InactivityPolicy`, `CalendarDay`, `LeaveException`, `AccountRestriction`,
`AccountStatusEvent`, the sweep job, the pure modules, `/super/calendar`,
`/super/settings/inactivity`, `/admin/inactivity`, `/account/reactivate`,
`/account/leave`, and the dormancy chip on `/dashboard`.

Also not built, and a real dependency: **`IntegrityFlag` and the appeal arrive
in slice 6e.** The spec's "never sweep … a pending appeal" is therefore a
single `EXISTS` fragment plus one boolean parameter of a pure function, so that
when 6e lands only the fragment changes. Phase 8 does not invent an appeal
model.

## 1. Key decisions

1. **The hard-disable ceiling is enforced in the database, not in the job.**
   Trigger `recx_refuse_system_disable` refuses any `AccountStatusEvent` INSERT
   with `triggeredBySystem = true` and `toStage = 'DISABLED'` (or
   `toStatus = 'DISABLED'`) unless the `InactivityPolicy` row at
   `NEW."policyVersion"` has `autoDisableEnabled = true`. With the default
   `false`, the database itself refuses the row — a future job, a future
   migration, a future `psql` session all hit the same refusal. §0 says no
   account is hard-disabled by a cron job; a code-path check would be one
   refactor away from untrue, so this lands in the phase's first migration that
   has the event table, before any sweep exists to tempt anyone.
2. **The maximum automatic consequence is a restriction, and a restriction is
   reversible by one student click.** No approval, ever: §7 says plainly "do
   not require admin approval to clear a soft restriction", and the spec's
   reason is that anything requiring approval turns a 10-day lapse into a
   permanent exit. `/account/reactivate` is one button, `requireActionUser()`,
   acting only on the caller's own row. A static test asserts that action's
   guard is `requireActionUser()` and nothing stronger, so nobody "hardens" it
   later.
3. **Solving one problem clears NUDGED / WARNED / SOFT_RESTRICTED
   automatically**, in the existing finalise transaction. The cheapest possible
   exit from the restriction is doing the thing the policy wanted.
4. **One stage transition per run, in the data.** Trigger
   `recx_refuse_stage_jump` requires a system escalation to move exactly one
   rung of `NONE → NUDGED → WARNED → SOFT_RESTRICTED → DISABLED`, while
   allowing a drop straight to `NONE` in one move (a restoration is not a
   penalty, so it is never rate-limited). Nobody jumps NONE → DISABLED, even by
   raw SQL.
5. **The evidence JSON is the product.** `AccountStatusEvent.evidence` carries
   `lastActiveAt`, `calendarDaysElapsed`, `countedInactiveDays`,
   `excludedDates`, `excludedReason`, `thresholdDays`, `policyVersion`,
   `evaluatedAt` — required by CHECK `AccountStatusEvent_system_evidence_check`
   and mirrored by `inactivityEvidenceSchema` in `@recx/shared`. The spec's
   reason, carried across: without it, "the system disabled me" is
   unanswerable, and that is the failure mode that destroys trust in a
   placement platform. A disputed lockout must be explainable months later, so
   the row cannot exist without its explanation.
6. **Append-only history.** `AccountStatusEvent` refuses UPDATE except setting
   `notifiedAt` once, refuses DELETE and refuses TRUNCATE — the same shape as
   `XpEvent` (`recx_refuse_xp_event_change`). The audit chain is
   tamper-evident, and the status history is the thing an appeal reads.
7. **Policy rows are immutable and versioned.** `version Int @unique
   @default(autoincrement())`; trigger
   `recx_refuse_inactivity_policy_change` makes every column except `isActive`
   immutable after insert, so editing a threshold writes a new version. An
   event cites `policyVersion`; if the row it cites could be edited, the
   evidence would quietly become a lie. Every threshold is a
   super-admin-configurable, audit-logged setting rather than a constant, so the
   policy can be tightened without a deploy.
8. **Dry run ships before the live sweep** — slice 8c writes nothing to `User`
   or `AccountRestriction` at all. The spec asks for a dry-run mode "shipped
   first", and the manual gate is to read a dry-run report over seeded data
   covering every case before the job is allowed to write.
9. **Idempotent per `(userId, evaluationDate)`, in the data.**
   `AccountStatusEvent.evaluationDate @db.Date` plus partial unique index
   `AccountStatusEvent_sweep_once_per_day` on `(userId, evaluationDate) WHERE
   "triggeredBySystem"`. A second run on the same campus day is a unique
   violation on one row, not a second transition for the cohort.
10. **What the restriction blocks is a single list, read by every consumer.**
    `RESTRICTION_EFFECTS` in `@recx/shared` says: blocks contest registration,
    leaderboard visibility, new XP accrual (events still recorded, flagged
    `meta.restricted`) and rewards; does **not** block signing in, reading
    problems, solving, or sitting a scheduled assessment. The spec's reason,
    carried across: locking a student out of a graded assessment because they
    were ill is a worse failure than under-enforcing.
11. **XP is withheld from the board, never destroyed.** The ledger is
    append-only (§4d), so a restricted student's `XpEvent` is written with
    `meta.restricted = true` and the buckets are not advanced. Nothing has to
    be re-awarded on restoration, and no compensating row is needed.
12. **Never sweep an account with an open attempt, a pending appeal, or an
    assessment scheduled in the next 72 hours.** Enforced three times: the
    candidate query's `NOT EXISTS` fragments, the pure `sweepHoldback()`, and
    trigger `recx_refuse_sweep_with_open_attempt` for the attempt case (the one
    whose table already exists). §7 repeats it as an anti-requirement, and
    §5 adds that a disabled account keeps access to its own integrity report
    and appeal.
13. **Judge capacity is never spent on a locked lane.** On entering
    `SOFT_RESTRICTED` the transaction cancels that user's `QUEUED` and
    `JUDGING` submissions and the job then calls `queues.remove(lane, id)`.
    An unremoved Redis job is harmless — the row is `CANCELLED` and the
    reconciler leaves it alone — so the Redis call is best-effort and outside
    the transaction, as every other enqueue in this codebase is.
14. **"Disabled" never appears in student-facing copy.** The day-5 state reads
    "restricted for inactivity" in administrative reporting, which satisfies the
    policy's wording, and reads as a dormancy countdown to the student. A copy
    test asserts no new student-facing string contains the word.
15. **Never a hard delete.** No student row is removed by anything in this
    phase; `DISABLED` is a state, and `GRADUATED`/`ARCHIVED` plus anonymisation
    remain the only end states (§4 retention).
16. **The "why" is shipped as product copy, not a comment.** The paragraph at
    the top of this file goes verbatim into `docs/RUNBOOK.md` §2 and onto
    `/super/settings/inactivity`, above the `autoDisableEnabled` switch. A
    super-admin about to turn on auto-disable reads the argument against it on
    the same screen.

## 2. Sequencing into gated slices

Five slices. Each is green on lint, typecheck, test and build on its own before
the next begins. Only 8e closes the phase.

| Slice | Contents |
|---|---|
| **8a Calendar and leave** | `CalendarDayKind`, `LeaveKind`, `LeaveStatus`; `CalendarDay`, `LeaveException` and their CHECKs, triggers and the `btree_gist` exclusion constraint; `packages/shared/src/calendar.ts`; `/super/calendar` + `super-calendar.ts` actions; **`calendar.manage` wired** (its `arrives` removed, actions and page listed, `docs/SECURITY.md` row regenerated) — mandatory in this slice, because `capabilities.test.ts` fails as soon as the two models exist with an empty action list; `/account/leave` for a student's own `REQUESTED` row |
| **8b The policy record** | `RestrictionStage`; `InactivityPolicy` with the threshold-ordering CHECK, the `autoDisableEnabled` CHECK, the scope partial unique index and the version-immutability trigger; `packages/shared/src/inactivity-policy.ts` (resolution, zod, defaults); `/super/settings/inactivity` + `super-inactivity.ts` under `settings.write`, carrying the "why" copy; the `docs/RUNBOOK.md` §2 section. No sweep, no counter |
| **8c The counter and the dry run** | `AccountRestriction`, `AccountStatusEvent` with every CHECK and trigger from §3 — including `recx_refuse_system_disable` and `recx_refuse_stage_jump`; `packages/shared/src/inactivity.ts`; `"inactivitySweep"` appended to `SCHEDULER_JOB_NAMES`; `InactivitySweepJob` in `apps/scheduler`, **dry-run only**: it resolves policies, counts days, applies the holdbacks and reports, and writes nothing but its `SchedulerJobStatus` row |
| **8d The live sweep** | the 02:00 Asia/Kolkata gate and the `(userId, evaluationDate)` idempotence; the one transaction writing `AccountRestriction` + `AccountStatusEvent` + `AuditLog` + `Notification` (+ `EmailOutbox` for the mentor); grace handling off `notifiedAt`; stopping at `SOFT_RESTRICTED` and raising the admin review item when `autoDisableEnabled` is false; the restriction effects (leaderboard `HIDDEN`, `meta.restricted` in `apply.ts`, rewards); submission cancellation and `queues.remove`; `AccountStatusEvent` written by the existing manual paths in `super-users.ts` and `bulk-status.ts`; `/admin/inactivity` |
| **8e Restoration and the student surface** | auto-clear on solve inside the finalise transaction; `/account/reactivate` one-click self-service and the `selfClearedCount` gate; retroactive approved `LeaveException` reversing a disable and writing the reversal event; the dormancy countdown chip on `/dashboard`; the four new pages added to the gating a11y Playwright rows; `docs/OPEN-QUESTIONS.md` entries |

## 3. New Prisma models, enums and database-enforced invariants

Enums (mirrored in `@recx/shared` in the same order, per `enum-parity.test.ts`):

```prisma
enum RestrictionStage { NONE NUDGED WARNED SOFT_RESTRICTED DISABLED }
enum CalendarDayKind  { REGULAR HOLIDAY EXAM_WEEK SEMESTER_BREAK PLACEMENT_WEEK }
enum LeaveKind        { MEDICAL BEREAVEMENT UNIVERSITY_EXAM PLACEMENT_DRIVE INTERNSHIP SPORTS_EVENT APPROVED_OTHER }
enum LeaveStatus      { REQUESTED APPROVED REJECTED CANCELLED }
```

`User` gains three relations only: `restriction AccountRestriction?`,
`statusEvents AccountStatusEvent[]`, `leaveExceptions LeaveException[]`.

### `CalendarDay` (slice 8a)

`date DateTime @id @db.Date`, `isWorkingDay Boolean @default(true)`,
`label String`, `kind CalendarDayKind @default(REGULAR)`, `createdById`,
`createdAt`.

- CHECK `CalendarDay_label_check`: `char_length(label) between 1 and 120`.
- CHECK `CalendarDay_regular_is_working_check`:
  `kind = 'REGULAR' OR "isWorkingDay" = false` — a non-regular day never
  claims to be a working day. A `REGULAR` day may still be false (a Sunday).
- trigger `recx_refuse_past_calendar_day_change` →
  `CalendarDay_past_immutable`: UPDATE or DELETE of a `date < current_date` is
  refused. Evidence rows already cite those days; a correction to history goes
  through a retroactive `LeaveException`, which is the spec's own reversal path.
- trigger `CalendarDay_no_truncate`.
- `@@index([kind, date])`.

### `LeaveException` (slice 8a)

`id`, `userId` + relation, `kind LeaveKind`, `startDate @db.Date`,
`endDate @db.Date`, `status LeaveStatus @default(REQUESTED)`, `reason`,
`evidenceFileId String?`, `requestedById`, `decidedById String?`,
`decidedAt DateTime?`, `decisionNote String?`, `createdAt`.

- Migration prologue: `CREATE EXTENSION IF NOT EXISTS btree_gist;` (only
  `pg_trgm` is installed today, by `20261010001004`).
- CHECK `LeaveException_range_check`: `"endDate" >= "startDate"` and
  `"endDate" - "startDate" <= 180`.
- CHECK `LeaveException_reason_check`: `char_length(reason) between 10 and 1000`.
- CHECK `LeaveException_decision_pair_check`:
  `(status IN ('APPROVED','REJECTED')) = ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)`.
- CHECK `LeaveException_rejection_note_check`: `status <> 'REJECTED' OR
  char_length("decisionNote") >= 10` — a refusal a student can read.
- CHECK `LeaveException_two_person_check`: `"decidedById" IS NULL OR
  "decidedById" <> "requestedById"` — a leave is never self-approved, the same
  shape as `PrivilegedOperation`'s two-person rule.
- EXCLUDE constraint `LeaveException_no_overlapping_approved`:
  `EXCLUDE USING gist ("userId" WITH =, daterange("startDate","endDate",'[]') WITH &&) WHERE (status = 'APPROVED')`
  — one student never holds two overlapping approved leaves, so a day is never
  excluded twice and `excludedReason` is unambiguous.
- trigger `recx_refuse_leave_terms_change` → `LeaveException_terms_immutable`:
  `userId`, `kind`, `startDate`, `endDate`, `reason`, `evidenceFileId`,
  `requestedById` and `createdAt` never change; `status` moves only
  `REQUESTED → APPROVED|REJECTED|CANCELLED` or `APPROVED → CANCELLED`; the
  decision fields are set once. Modelled on
  `recx_refuse_granted_accommodation_terms`.
- trigger `LeaveException_no_truncate`.
- `@@index([userId, status, startDate])`, `@@index([status, startDate])`.

### `InactivityPolicy` (slice 8b)

Exactly the spec's field list (`version Int @unique @default(autoincrement())`,
`isActive`, `batchYear?`, `departmentCode?`, `nudgeAfterDays?`,
`warnAfterDays?`, `softRestrictAfterDays?`, `disableAfterDays?`,
`autoDisableEnabled @default(false)`, `graceDays @default(2)`,
`countsAsActivity Json`, `minActivityPerDay @default(1)`,
`excludeNonWorkingDays @default(true)`, `excludeApprovedLeave @default(true)`,
`notifyMentor @default(true)`, `notifyParentEmail @default(false)`,
`createdById`, `createdAt`).

- CHECK `InactivityPolicy_threshold_order_check`: each non-null threshold is
  between 1 and 365, and the non-null ones are non-decreasing in the order
  nudge ≤ warn ≤ softRestrict ≤ disable. A null means that stage never fires.
- CHECK `InactivityPolicy_grace_check`: `"graceDays" between 0 and 30`.
- CHECK `InactivityPolicy_min_activity_check`:
  `"minActivityPerDay" between 1 and 20`.
- CHECK `InactivityPolicy_auto_disable_check`: `NOT "autoDisableEnabled" OR
  ("disableAfterDays" IS NOT NULL AND "disableAfterDays" >= 14)` — if a human
  deliberately turns the switch on, the database still refuses a disable
  threshold short enough to catch a fortnight's illness.
- CHECK `InactivityPolicy_scope_check`: `"departmentCode" IS NULL OR
  char_length("departmentCode") between 2 and 16`.
- partial unique index `InactivityPolicy_active_scope_key` on
  `(coalesce("batchYear", -1), coalesce("departmentCode", ''))
  WHERE "isActive"` — at most one active policy per scope, nulls treated as
  equal, so resolution is always single-valued.
- trigger `recx_refuse_inactivity_policy_change` →
  `InactivityPolicy_version_immutable`: every column except `isActive` is
  immutable after insert; a threshold change is a new version row. DELETE is
  refused once any `AccountStatusEvent` cites the version.
- trigger `InactivityPolicy_no_truncate`.

### `AccountRestriction` (slice 8c)

`userId String @id` + relation, `stage RestrictionStage @default(NONE)`,
`stageEnteredAt`, `graceEndsAt DateTime?`, `countedInactiveDays Int @default(0)`,
`lastEvaluatedAt DateTime?`, `policyVersion Int?`,
`selfClearedCount Int @default(0)`, **`selfClearedTermKey String?`**.

`selfClearedTermKey` is an addition to the spec's shape, with a reason: the
spec gates self-service on `selfClearedCount < 1` and calls it "once per
semester" without defining a semester. Storing the term the count belongs to is
what makes the reset real rather than a cron guess.

- CHECK `AccountRestriction_counted_check`: `"countedInactiveDays" >= 0`.
- CHECK `AccountRestriction_self_cleared_check`:
  `"selfClearedCount" between 0 and 8` and
  `("selfClearedCount" = 0) = ("selfClearedTermKey" IS NULL)`.
- CHECK `AccountRestriction_grace_check`: `"graceEndsAt" IS NULL OR
  "graceEndsAt" >= "stageEnteredAt"`.
- CHECK `AccountRestriction_none_check`: `stage <> 'NONE' OR
  ("countedInactiveDays" = 0 AND "graceEndsAt" IS NULL)`.
- deferred constraint trigger `recx_require_restriction_event` →
  `AccountRestriction_requires_event` (`DEFERRABLE INITIALLY DEFERRED`, AFTER
  INSERT OR UPDATE OF `stage`): at commit there must be an
  `AccountStatusEvent` for that `userId` with `toStage = NEW.stage` and
  `createdAt >= NEW."stageEnteredAt"`. A stage therefore cannot move without
  its explanation, whichever path moved it.
- trigger `AccountRestriction_no_truncate`.
- `@@index([stage, stageEnteredAt])`, `@@index([lastEvaluatedAt])`.

### `AccountStatusEvent` (slice 8c) — append-only

`id BigInt @id @default(autoincrement())`, `userId` + relation,
`fromStage`/`toStage RestrictionStage`, `fromStatus`/`toStatus AccountStatus`,
`policyVersion Int?`, `evidence Json`, `triggeredBySystem Boolean`,
`actorId String?`, `reason String?`, `notifiedAt DateTime?`,
**`evaluationDate DateTime? @db.Date`**, `createdAt @default(now())`.

- CHECK `AccountStatusEvent_change_check`: `"fromStage" <> "toStage" OR
  "fromStatus" <> "toStatus"` — no no-op rows in the history.
- CHECK `AccountStatusEvent_actor_check`:
  `"triggeredBySystem" = ("actorId" IS NULL)` — a system event has no actor, a
  manual one always has one.
- CHECK `AccountStatusEvent_manual_reason_check`: `"triggeredBySystem" OR
  char_length(reason) >= 10` — "hard disable is otherwise only ever a manual,
  **reasoned**, audit-logged admin action".
- CHECK `AccountStatusEvent_system_policy_check`: `NOT "triggeredBySystem" OR
  ("policyVersion" IS NOT NULL AND "evaluationDate" IS NOT NULL)`.
- CHECK `AccountStatusEvent_system_evidence_check`: `NOT "triggeredBySystem" OR
  (evidence ?& array['lastActiveAt','calendarDaysElapsed','countedInactiveDays',
  'excludedDates','excludedReason','thresholdDays','policyVersion','evaluatedAt']
  AND jsonb_typeof(evidence->'excludedDates') = 'array'
  AND jsonb_typeof(evidence->'excludedReason') = 'array')`. The load-bearing
  constraint of the phase: a system transition cannot be recorded without the
  explanation a disputed lockout needs months later.
- partial unique index `AccountStatusEvent_sweep_once_per_day` on
  `("userId", "evaluationDate") WHERE "triggeredBySystem"` — idempotence per
  `(userId, evaluationDate)`.
- trigger `recx_refuse_account_status_event_change` →
  `AccountStatusEvent_append_only`: DELETE refused; UPDATE refused except
  `notifiedAt` moving from NULL to a value exactly once. Same shape as
  `recx_refuse_xp_event_change`.
- trigger `recx_refuse_system_disable` →
  `AccountStatusEvent_system_disable_opt_in`: BEFORE INSERT, refuse
  `"triggeredBySystem" AND ('DISABLED' IN ("toStage", "toStatus"))` unless
  `EXISTS (SELECT 1 FROM "InactivityPolicy" p WHERE p.version = NEW."policyVersion"
  AND p."autoDisableEnabled")`. **This is §0's "no account is hard-disabled by
  a cron job", expressed where no code path can route around it.**
- trigger `recx_refuse_stage_jump` → `AccountStatusEvent_single_step`: for a
  system row, `toStage` is `NONE`, or exactly one rung above or below
  `fromStage` on the `NONE/NUDGED/WARNED/SOFT_RESTRICTED/DISABLED` ladder.
- trigger `recx_refuse_sweep_with_open_attempt` →
  `AccountStatusEvent_no_sweep_mid_attempt`: refuse an escalating system row
  when the user has an `AssessmentAttempt` in `('IN_PROGRESS','DISCONNECTED')`.
- trigger `AccountStatusEvent_no_truncate`.
- `@@index([userId, createdAt(sort: Desc)])`, `@@index([toStage, createdAt])`,
  `@@index([triggeredBySystem, createdAt])`.

Every guard function, trigger, CHECK and partial index above is added to
`packages/db/test/support/guard-catalog.ts` in the same slice as its migration.

## 4. The pure modules in `packages/shared`

All three are pure in the house style of `attempt-clock.ts`: no I/O, no Prisma,
no ambient clock — `now` is always a parameter. None of this arithmetic may
live in the job or in a component.

**`packages/shared/src/calendar.ts`** (8a)

- `CALENDAR_DAY_KINDS`, `LEAVE_KINDS`, `LEAVE_STATUSES` (enum-parity mirrors).
- `isCountedDay(day: string, cal: CalendarLookup): boolean` — a day counts only
  when it is `REGULAR` and `isWorkingDay`.
- `countedDaysBetween(fromDay, toDay, cal): string[]` — the campus days in
  `(from, to]`, counted ones only, built on `dayDifference` from `time.ts`.
- `leaveCoveredDays(leaves, fromDay, toDay): Map<string, LeaveKind>` —
  `APPROVED` rows only, inclusive of both end dates.
- `mergeExclusions(...): { excludedDates: string[]; excludedReason: string[] }`
  — one entry per excluded day, in ascending date order, the two arrays
  positionally aligned, reason one of `HOLIDAY | EXAM_WEEK | SEMESTER_BREAK |
  PLACEMENT_WEEK | NON_WORKING | <LeaveKind>_LEAVE | ACTIVE`. A calendar
  exclusion wins over a leave exclusion so the reason is deterministic.
- `termKeyFor(day, cal): string` — the academic term a day falls in, derived
  from `SEMESTER_BREAK` boundaries, for `selfClearedTermKey`.

**`packages/shared/src/inactivity-policy.ts`** (8b)

- `INACTIVITY_STAGES` (the ladder), `stageIndex(stage)`,
  `nextStage(stage)`, `RESTRICTION_STAGE_LABEL` (student-facing copy, with no
  use of the word "disabled" below `DISABLED` itself).
- `resolveInactivityPolicy(policies, { batchYear, departmentCode })` —
  most specific scope first: department+batch > batch > department > global,
  tie-broken on highest `version`. Total: returns `null` only when no active
  policy exists at all, and the job then does nothing.
- `countsAsActivitySchema` (`{submission, solve, login, lesson}` booleans),
  `inactivityPolicySchema` with the threshold-ordering refinement and the
  `autoDisableEnabled ⇒ disableAfterDays >= 14` refinement — the zod mirror of
  the two CHECKs.
- `DEFAULT_INACTIVITY_POLICY` (nudge 3, warn 5, softRestrict 10, disable 30,
  `autoDisableEnabled: false`, grace 2, `login: false`).
- `thresholdFor(policy, stage)` and `stageForCountedDays(policy, n)`.

**`packages/shared/src/inactivity.ts`** (8c)

- `countInactiveDays(input): InactivityCount` — returns
  `{ countedInactiveDays, calendarDaysElapsed, excludedDates, excludedReason,
  lastCountedDay }` from `lastActiveAt`, the calendar, the approved leaves, the
  `ActivityDay` rows and `minActivityPerDay`. A day with activity at or above
  `minActivityPerDay` is excluded with reason `ACTIVE`; a day below it counts.
- `planStageTransition(input): StagePlan` — `{ kind: "hold" | "escalate" |
  "clear", toStage, graceEndsAt, reason }`. At most one rung. Holds while
  `notifiedAt` is set and `graceEndsAt > now`. Caps at `SOFT_RESTRICTED` when
  `autoDisableEnabled` is false, and returns
  `{ raisesAdminReview: true }` in that case.
- `sweepHoldback(input): "open-attempt" | "pending-appeal" |
  "assessment-within-72h" | "calendar-incomplete" | null` — the pure mirror of
  the candidate query's `NOT EXISTS` fragments. `pendingAppeal` is a boolean
  parameter, so slice 6e lands by changing one SQL fragment.
- `buildInactivityEvidence(...): InactivityEvidence` and
  `inactivityEvidenceSchema` — the exact shape the CHECK requires, so the
  database constraint and the zod schema are provably the same list (a test
  asserts the key sets match).
- `RESTRICTION_EFFECTS` — the blocks / does-not-block list from decision 10, as
  data, read by the contest action, the leaderboard query, `apply.ts` and the
  student copy.
- `canSelfClear({ stage, selfClearedCount, selfClearedTermKey, termKey })` and
  `dormancyChip({ countedInactiveDays, policy, stage, now })` for the
  `/dashboard` countdown.

## 5. Routes, pages and the guard each needs

| Surface | Guard | Capability | Notes |
|---|---|---|---|
| `app/super/calendar/page.tsx` | `requirePageRole(["SUPER_ADMIN"])` | `calendar.manage` | the academic calendar and the leave decision queue |
| `super-calendar#upsertCalendarDay`, `#importCalendarDays`, `#decideLeaveException` | `requireSuperAdmin()` first statement of the `runAction` body | `calendar.manage` | each `audit()`s at `SENSITIVE`; the decision action is refused by CHECK if the decider is the requester |
| `app/super/settings/inactivity/page.tsx` | `requirePageRole(["SUPER_ADMIN"])` | `settings.write` | carries the "why" copy above the switch |
| `super-inactivity#saveInactivityPolicy`, `#activateInactivityPolicy`, `#setAutoDisableEnabled` | `requireSuperAdmin()` | `settings.write` | `setAutoDisableEnabled` audits at `SECURITY` and emails every super-admin through `EmailOutbox` |
| `app/admin/inactivity/page.tsx` | `requireAdminScopePage()` (fail-closed: an ADMIN with no active `AdminScope` sees no students) | staff | the review queue of accounts the job stopped at `SOFT_RESTRICTED`; virtualised |
| `admin-inactivity#clearRestriction`, `#requestLeaveExceptionFor` | `requireAdminScopeAction()` | staff | clearing is a de-escalation to `NONE`, never an escalation |
| `app/(student)/account/reactivate/page.tsx` | the `(student)` layout guard | `SELF_SERVICE` | one button, one click, no approval |
| `account#selfClearRestriction` | `requireActionUser()` **only** | `SELF_SERVICE` | own row only; rate-limited via `lib/rate-limit.ts`; a static test asserts the guard is not stronger |
| `app/(student)/account/leave/page.tsx`, `account#requestLeaveException` | `requireActionUser()` | `SELF_SERVICE` | writes `REQUESTED` rows for the caller only |
| `app/(student)/dashboard/page.tsx` | existing | — | the dormancy chip; no new route |
| `app/super/jobs/page.tsx` | existing | — | one new row appears once `"inactivitySweep"` is in `SCHEDULER_JOB_NAMES` |

No surface in this phase reads hidden tests, checkers or
`ReferenceSolution`, so nothing lands under `SENSITIVE_PREFIXES`. The
`super-` / `admin-` filename prefixes are still used, because
`capabilities.test.ts` parses the guard from them. `/account/*` is a student
entry, so its closure must reach only the pure `@recx/shared` modules —
`tests/repo/student-exposure.test.ts` checks it.

## 6. Tests the phase is gated on

From the spec's "Done when", plus what the design above implies.

1. **Day counting, pure** (`packages/shared/test/inactivity.test.ts`): across
   holidays, exam weeks, semester breaks, placement weeks, approved leave and
   partial activity — including a day whose activity is below
   `minActivityPerDay` (counts), a leave range half-covering the window, a
   holiday inside a leave range (excluded once, one reason), and a student with
   `lastActiveAt = null`.
2. **At most one stage transition per run**: the pure planner, plus a DB test
   that `recx_refuse_stage_jump` refuses `NONE → DISABLED` through raw SQL.
3. **The job refuses to sweep an account with an open attempt or a pending
   appeal** (`apps/scheduler/test/inactivity-sweep.db.test.ts`), plus the
   trigger test for the attempt case, plus the 72-hour case.
4. **`autoDisableEnabled = false` never reaches `DISABLED`**: the pure planner
   caps at `SOFT_RESTRICTED` and sets `raisesAdminReview`; the job test shows
   the review item; and `recx_refuse_system_disable` rejects the row through
   raw SQL with the switch off.
5. **A retroactive approved `LeaveException` reverses a disable**: the counted
   days drop below the threshold, the account returns to its prior status, and
   a reversal `AccountStatusEvent` is written citing the leave.
6. **Idempotence**: the job run twice for one `evaluationDate` produces exactly
   one `AccountStatusEvent` per user (the partial unique index), and the second
   run reports zero transitions rather than failing the tick.
7. **Grace**: no escalation before `graceEndsAt` once `notifiedAt` is set.
8. **Policy resolution**: department+batch > batch > department > global, the
   version tie-break, and the single-active-policy-per-scope index.
9. **Evidence**: the key set of `inactivityEvidenceSchema` equals the key list
   in `AccountStatusEvent_system_evidence_check` (parsed from the migration
   SQL), and a system event missing any key is refused.
10. **Restriction effects**: a `SOFT_RESTRICTED` student signs in, opens a
    problem, solves it and starts a scheduled assessment; cannot register for a
    contest; does not appear on any board or in "my rank"; and their `XpEvent`
    carries `meta.restricted` while no `XpBucket` moves.
11. **Self-clear needs no approval**: one click clears
    `NUDGED/WARNED/SOFT_RESTRICTED`, the `selfClearedCount`/`termKey` gate
    works, and a static test asserts `account#selfClearRestriction` guards with
    `requireActionUser()` and nothing stronger.
12. **Judge capacity**: entering `SOFT_RESTRICTED` cancels that user's `QUEUED`
    and `JUDGING` rows and calls `queues.remove`; the reconciler does not
    re-enqueue them.
13. **Append-only**: `AccountStatusEvent` refuses UPDATE (except the one
    `notifiedAt` write), DELETE and TRUNCATE; `InactivityPolicy` refuses an
    edit to any column but `isActive`; a past `CalendarDay` refuses UPDATE.
14. **Fence parity**: every new guard function, trigger, CHECK and partial
    index is in `guard-catalog.ts`; `frozen-coverage.test.ts` and
    `guard-state.db.test.ts` green; `enum-parity.test.ts` green for the four
    new enums.
15. **Capability wiring**: `calendar.manage` has actions and pages in the same
    slice its two models appear; `capabilities.test.ts`,
    `capability-matrix.test.ts` and the `docs/SECURITY.md` table green.
16. **Copy**: `forbidden-words.test.ts` green over all new copy and the RUNBOOK
    section; plus a copy test that no student-facing string in the new surfaces
    contains the word "disabled".

### Accessibility requirements, not polish

- The dormancy chip is **never colour alone**: icon + text + an `aria-label`
  carrying the whole sentence ("3 of 10 inactive days counted — solve one
  problem to reset"). If a `ProgressRing` is used, the number is also text and
  the ring is `role="img"` with a label.
- The chip is **not** a `role="timer"` live region. It announces once, through
  `aria-live="polite"`, when the stage changes — a per-tick announcement makes
  a screen reader unusable, the same rule Phase 6 applies to the exam timer.
- The restriction explanation sits **before** `main`'s content in DOM order, so
  a screen-reader user meets it first, and it is never a toast: a message that
  disappears is not an explanation.
- `/account/reactivate` is a single keyboard-reachable `<button>` with a
  visible focus ring; the outcome is announced in a live region. No
  dialog-only, hover-only or drag path to clearing a restriction.
- The leave form's dates follow the repo's absolute-instant rule for every
  date-and-time field (`istLocalInput()` plus an explicit `+05:30` before the
  value leaves the browser) — `docs/OPEN-QUESTIONS.md` records why: on a
  development box whose zone is already Asia/Kolkata the bug is invisible.
- `/admin/inactivity` virtualises its rows (never 5,000 DOM rows) and is fully
  keyboard-navigable. The four new pages join the gating a11y Playwright rows.

### Manual gate (spec)

Run the sweep in `--dry-run` against seeded data covering holidays, exam weeks,
approved leave, partial activity, an open attempt, a pending appeal, an
assessment 48 hours out and a student with no activity at all. Read the output.
Then run it live and inspect the `AccountStatusEvent.evidence` of one affected
student, confirming the excluded dates and reasons match the seed. Record both
in `docs/RUNBOOK.md` §3 with a date.

## 7. Open questions to record in `docs/OPEN-QUESTIONS.md`

Each with the narrower reading recommended, per §0 ("ask before inventing —
implement the narrower reading and note it").

1. **`countsAsActivity.lesson` has no source in this database.** Lessons live
   in the LMS, and REC Code never creates a student record there.
   *Narrower:* accept the key, ignore it, and have the evidence record
   `"lessonSignalAvailable": false`, so nobody later reads a missing signal as
   inactivity. Wiring it is a roster-sync field, not a Phase 8 feature.
2. **`login: false` by default.** *Narrower:* keep it false — the spec's own
   argument is that a policy counting logins teaches a daily one-minute login
   that pollutes the engagement data worse than inactivity does. A super-admin
   may flip it, and the settings page states that consequence next to the
   switch.
3. **"Once per semester" is undefined.** *Narrower:* `selfClearedTermKey`
   derived from `SEMESTER_BREAK` boundaries in `CalendarDay`; while the
   calendar has no break rows, the term key is the academic year, which allows
   *fewer* self-clears and is therefore the stricter reading. Revisit once a
   real calendar is loaded.
4. **`PLACEMENT_WEEK` / `EXAM_WEEK` versus `isWorkingDay`.** *Narrower:* any
   day whose `kind <> 'REGULAR'` is excluded from this counter regardless of
   `isWorkingDay`, and the CHECK keeps a non-regular day from claiming to be a
   working day. `CalendarDay` has exactly one consumer today; revisit when it
   gains a second.
5. **Pending appeal depends on slice 6e.** *Narrower:* `sweepHoldback` takes
   `pendingAppeal` as a boolean and the candidate query carries one `NOT
   EXISTS` fragment reading `IntegrityFlag.status IN ('OPEN','REVIEWING')`.
   Phase 8 invents no appeal model; when 6e lands, one fragment changes.
6. **`notifyParentEmail`.** *Narrower:* stays false, needs a SUPER_ADMIN flip
   and a recorded `ConsentRecord`; a parent address is third-party PII and the
   spec defaults it off.
7. **An empty or sparse `CalendarDay` makes every day a working day**, which is
   the counter's *harshest* reading. *Narrower, and recommended:* the job
   refuses to escalate anyone while the calendar does not cover the evaluation
   window, reporting `"calendarIncomplete": true` and raising an admin review
   item instead. Under-enforcing is the correct failure direction here.
8. **Does a reversal restore withheld XP?** *Narrower:* nothing was lost. The
   ledger is append-only and the events were written with `meta.restricted`, so
   the reversal clears the flag's effect on bucket visibility and writes no
   compensating row and no re-award.
9. **Who is the "named human" `notifyMentor` means?** *Narrower:* the student's
   `TA_MENTOR` by cohort; when none resolves, the department `ADMIN` rather
   than nobody, and the evidence records which was notified. The spec's point
   is that non-progress is visible to a named human who can intervene, so the
   notification must never silently go nowhere.
10. **A past `CalendarDay` is immutable, so a mis-entered holiday cannot be
    corrected in place.** *Narrower:* correct history through a retroactive
    `LeaveException`, which is already the spec's reversal mechanism; a
    super-admin override would need its own `PrivilegedOperationKind`, which
    Phase 8 does not add.
11. **"Every student must make progress" cannot be enforced by software** — the
    spec asks for this to be recorded honestly, so it is recorded as its own
    entry. What the platform can do is make the next action unambiguous (one
    Continue card, not a wall of choices), keep the weekly goal small (3
    problems, not 30), make non-progress visible to a named human who can
    intervene, and make progress legible to the student. The honest promise is
    "nobody falls through unnoticed and nobody is ever unsure what to do next"
    — not "everyone progresses".


---

## Review findings — fix before implementing
An independent pass over this document against `docs/handoff/SPEC.md` and the
actual repository returned **needs-revision**. Nothing below has been applied yet: this
design is a DRAFT, and these are the items to settle first, when Phase 8 starts
and the codebase is whatever it is by then. Each one was checkable against a
file or a spec line when it was written (2026-10-19).

### Contradicts the spec or the codebase (9)

1. Decision 7 and §3's `InactivityPolicy_auto_disable_check` contradict the spec clause the design quotes two sentences later. The CHECK is "`NOT "autoDisableEnabled" OR ("disableAfterDays" IS NOT NULL AND "disableAfterDays" >= 14)`", justified as "the database still refuses a disable threshold short enough to catch a fortnight's illness". The spec says "Every threshold is a Super-admin-configurable, audit-logged setting rather than a constant, so the policy can be tightened without a deploy" — the design pastes that sentence verbatim into the same decision while making 14 a hard constant. The college's literal ask (5 days → disabled) becomes unreachable without a migration, which is the one thing the spec says must not require a deploy. If a floor is wanted it belongs in the settings UI with the "why" copy, not in a CHECK.

2. §4 specifies `RESTRICTION_STAGE_LABEL` as "(student-facing copy, with no use of the word \"disabled\" below `DISABLED` itself)" — i.e. the `DISABLED` label *does* use the word in student-facing copy. The spec says flatly "Keep the word 'disabled' out of student-facing copy", and the design's own gating test 16 is "a copy test that no student-facing string in the new surfaces contains the word 'disabled'". The design contradicts both the spec and its own test in the same document.

3. Decision 13 contradicts decisions 3 and 10. 13: "On entering `SOFT_RESTRICTED` the transaction cancels that user's `QUEUED` and `JUDGING` submissions". 10: the restriction "does **not** block signing in, reading problems, solving". 3: "Solving one problem clears NUDGED / WARNED / SOFT_RESTRICTED automatically". A student solving at 02:00 is simultaneously told solving is permitted and the exit route, and has that submission killed mid-judge by the same transaction. The cancellation is never scoped (practice vs contest vs assessment lane, nor "submitted before the restriction committed"), and the open-attempt holdback does not cover a plain practice submission.

4. OQ5 is unbuildable and contradicts §0 of the same doc. §0: "**`IntegrityFlag` and the appeal arrive in slice 6e** … Phase 8 does not invent an appeal model." OQ5: "the candidate query carries one `NOT EXISTS` fragment reading `IntegrityFlag.status IN ('OPEN','REVIEWING')`". Verified: `IntegrityFlag` is not in `packages/db/prisma/schema.prisma` (only `enum FlagStatus { OPEN REVIEWING UPHELD DISMISSED }` at :2110). The fragment cannot compile or run in Phase 8, so gating test 3 ("refuses to sweep an account with … a pending appeal") has nothing to exercise beyond the boolean parameter.

5. The constraint set makes the restoration paths the spec requires unwritable. `AccountStatusEvent_actor_check` is "`\"triggeredBySystem\" = (\"actorId\" IS NULL)`"; `AccountStatusEvent_system_policy_check` and `_system_evidence_check` require a system row to carry `policyVersion`, `evaluationDate` and the full eight-key evidence JSON; `AccountStatusEvent_sweep_once_per_day` is unique on `("userId", "evaluationDate") WHERE "triggeredBySystem"`; and `recx_require_restriction_event` requires an event for every stage move. Auto-clear-on-solve (decision 3, "in the existing finalise transaction") and the retroactive-leave reversal (8e) are both stage moves with no human actor — so they are system rows that must manufacture sweep evidence inside a submission transaction, and collide on the unique index with the sweep's own row for that campus day. Marked `triggeredBySystem = false` instead, they fail `_actor_check` (no actor) and `_manual_reason_check` (`char_length(reason) >= 10`). The design never reconciles this; nothing in §6 tests a same-day escalate-then-clear.

6. Decision 14 asserts "The day-5 state reads \"restricted for inactivity\" in administrative reporting, which satisfies the policy's wording", but the design's own `DEFAULT_INACTIVITY_POLICY` is "nudge 3, warn 5, softRestrict 10, disable 30". At counted day 5 the stage is `WARNED`, not `SOFT_RESTRICTED`, so the day-5 administrative report does **not** read "restricted" and the college's wording is not satisfied by the shipped defaults. This is the design's central claim to having met the college's ask, and it is arithmetically false against its own default row. Per §0 ("implement the narrower reading and note it") this needed an OPEN-QUESTIONS entry; there is none.

7. §3's `CalendarDay_regular_is_working_check` ("`kind = 'REGULAR' OR \"isWorkingDay\" = false`") forces every `HOLIDAY`/`EXAM_WEEK`/`SEMESTER_BREAK`/`PLACEMENT_WEEK` row to `isWorkingDay = false`. Combined with `isCountedDay` requiring `REGULAR && isWorkingDay`, the `kind` column and the `isWorkingDay` column carry the same information for the counter, and the spec's `excludeNonWorkingDays` toggle has nothing left to switch off. OQ4 ("any day whose `kind <> 'REGULAR'` is excluded … regardless of `isWorkingDay`") describes the collapse without noticing it removes a spec field's only meaning.

8. OQ6 cites a model that does not exist and that Phase 8 does not build: "stays false, needs a SUPER_ADMIN flip and a recorded `ConsentRecord`". `ConsentRecord` is in the spec's model inventory (SPEC.md:295, defined at :519 as a per-assessment privacy record) but is absent from `packages/db/prisma/schema.prisma`, and §0's "Not built, and therefore Phase 8's work" list does not include it. `notifyParentEmail` therefore has a gating precondition with no owner in any slice.

9. Minor citation error in §0: "**Assessment, `AssessmentAttempt`, `ExamSession`, `AttemptStatus`** (Phase 6a/6b, `schema.prisma:2142`, `:2318`, `:2253`, `:2099`)". Line 2142 is `enum AssessmentStatus`; `model Assessment` is at :2175. The other three line numbers check out, as do every other "already built" citation I spot-checked (`AccountStatus`:31, `SIGN_IN_STATUSES` in all four auth files, `@@index([status, lastActiveAt])`:405, `contests.ts`:50, `calendar.manage` at capabilities.ts:172-177 with `arrives: { phase: 8, models: ["CalendarDay", "LeaveException"] }`, `SCHEDULER_JOB_NAMES` with six members, `queues.ts:102`, `ActivityDay`:903, the `main.ts` reserved-slot comment). The design proposes rebuilding nothing Phase 1-6 shipped, and a scan for all five banned proctoring phrases over the doc is clean (only the permitted "tamper-evident", line 186).


### Spec requirements the design does not cover (8)

1. Spec: `excludeNonWorkingDays Boolean @default(true)` and `excludeApprovedLeave Boolean @default(true)`. Both are stored in the model (§3) but no pure function consumes them. §4 defines `isCountedDay(day, cal)` as "a day counts only when it is `REGULAR` and `isWorkingDay`" — hardcoded, no policy argument — and `countInactiveDays(input)` is fed only "`lastActiveAt`, the calendar, the approved leaves, the `ActivityDay` rows and `minActivityPerDay`". Two super-admin-configurable spec fields are dead columns.

2. Spec: `countsAsActivity Json @default("{\"submission\":true,\"solve\":true,\"login\":false,\"lesson\":true}")` and `minActivityPerDay Int @default(1)`. The design defines `countsAsActivitySchema` as "`{submission, solve, login, lesson}` booleans" and says "A day with activity at or above `minActivityPerDay` is excluded with reason `ACTIVE`" — but never says which `ActivityDay` column each flag reads, nor what `minActivityPerDay` counts (submissions? solves? both summed?). `ActivityDay` (verified, schema.prisma:903) has `submissions, accepted, solved, xp, xpEasy, activeSeconds` and **no login column**, so `login` has no data source at all; OQ1 excuses only `lesson` ("accept the key, ignore it"), and OQ2 says of `login` "A super-admin may flip it" — flip it to read what?

3. Spec: "DISABLED → ACTIVE is Super-admin only." The design never states this clause, never tests it, and §5 gives `admin-inactivity#clearRestriction` the staff guard `requireAdminScopeAction()` with the note "clearing is a de-escalation to `NONE`, never an escalation" — nothing stops a department ADMIN de-escalating a `DISABLED` row to `NONE`. No CHECK, trigger or pure-function floor excludes `DISABLED` from that action.

4. Spec: "Candidate set from User [status, lastActiveAt]" plus `AccountStatusEvent { … fromStatus, toStatus … }`. The design never says the sweep writes `User.status`, and gives no stage→status mapping. §2's 8c only implies it by negation ("writes nothing to `User` or `AccountRestriction` at all"); 8d's transaction list is "`AccountRestriction` + `AccountStatusEvent` + `AuditLog` + `Notification`" with no `User` update. This is load-bearing: the already-shipped contest refusal reads `user.status === "SOFT_RESTRICTED"` (apps/web/src/server/actions/contests.ts:50), so without a stated `User.status` write the restriction bites nothing, and without a stated mapping it is undefined whether `NUDGED`/`WARNED` also move `User.status`.

5. Spec: "What SOFT_RESTRICTED blocks: contest registration, leaderboard visibility, new XP accrual …, rewards." `rewards` is carried as a word into `RESTRICTION_EFFECTS` and the 8d row, but no mechanism is named anywhere (no `Badge`/`UserBadge`/`DailyChallenge`/streak-award path, unlike the three others which each get a file and line). Gating test 10 correspondingly tests contest registration, boards and `meta.restricted` and **omits rewards entirely**.

6. Spec: "otherwise the job stops at SOFT_RESTRICTED and raises an admin review item." The design names the flag (`{ raisesAdminReview: true }`) and the page (`/admin/inactivity`) but never says what the review item *is* as data — no model, no reuse of `Notification`, `PrivilegedOperation` or a `SchedulerJobStatus` payload. §2's 8d says only "raising the admin review item", so the queue page has no stated source row.

7. Spec: "Never sweep a student with … an assessment scheduled in the next 72 hours." The holdback is named (`"assessment-within-72h"`) but the design never says how "scheduled for this student" is resolved. `Assessment`/`AssessmentProblem` carry cohort scoping, not a per-student invitation row, so the `NOT EXISTS` fragment §4 promises has no stated shape — unlike the open-attempt case, which gets a concrete `AssessmentAttempt` status list.

8. Slice 8a's capability-wiring edit list is incomplete: "`calendar.manage` wired (its `arrives` removed, actions and page listed, `docs/SECURITY.md` row regenerated)". `apps/web/test/capabilities.test.ts:136` additionally hard-codes `expect(SUPER_ADMIN_CAPABILITIES.filter((c) => c.arrives).map(…)).toEqual([["integrity.overturn", 6], ["calendar.manage", 8]])`. That array must be edited in the same slice or 8a cannot go green — exactly the "costs a whole slice" trap the design claims to have mapped.

