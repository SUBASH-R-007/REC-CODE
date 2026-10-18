# Phase 5 design: contests

Coordinator working notes, as for Phase 4 (`docs/handoff/phase4/`). Delete
`docs/handoff/phase5/` once Phase 5 is gated.

Source of truth: `docs/handoff/SPEC.md` §5 "Phase 5 — Contests", plus the five
structural decisions in §4 — (e) is this phase's spine — and the §7 DO-NOTs
that bear on it.

## 0. Key decisions

1. **`ContestProblemAttempt` is authoritative; `ContestStanding` is a
   materialised view of it.** The spec is explicit (§4e). Every verdict
   updates the attempt row inside the judge-finalise transaction; `rank` is
   recomputed by ONE job every 15 s, never per submission. The acceptance
   test for this is `rebuild-standings`, which must reproduce a standings
   table byte-for-byte from attempts alone.
2. **Redis holds the live board; Postgres holds the truth.** Mirrors the
   judge queue decision: a Redis flush loses the live board's warm cache and
   zero data. `rebuild-standings` is therefore a first-class, tested command
   shipped before the first real contest, not a recovery script.
3. **Pinned problem versions, always.** `ContestProblem.problemVersionId`
   references a frozen `ProblemVersion`, never `Problem.liveVersionId`
   (§4a, §7). This is what makes "a mid-contest problem edit does not change
   any already-judged verdict" true by construction rather than by care.
4. **Rating is a pure function, and its inputs are stored.** The formula is
   fully specified, so it goes in `packages/shared` with no I/O, and every
   `RatingChange` row stores the seed it was computed from so a dispute is
   reconstructable years later. Computation takes `SELECT … FOR UPDATE` on
   the `Contest` row and aborts if `ratingComputedAt IS NOT NULL` —
   idempotence is a gate test.
5. **Virtual contests never touch the real board.** Unrated, excluded from
   standings, replayed against the original clock. They are a separate
   participation row, not a second kind of standing.
6. **The arena is hard-blocked below 768 px** with an explanatory page (§7:
   not a degraded experience). Same rule as a proctored attempt.
7. **No new XP economy.** Contest participation and solves reuse the
   existing `XpEvent` ledger with the documented `idempotencyKey` format
   `contest:{contestId}:{userId}:participation` (§4d).

## 1. Prisma additions

New enums:

```prisma
enum ContestKind       { ICPC SUBTASK }          // scoring mode of the contest
enum ContestStatus     { DRAFT PUBLISHED RUNNING FINISHED RATED CANCELLED }
enum ContestVisibility { PUBLIC COHORT }          // COHORT = audience columns apply
enum ParticipationKind { RATED UNRATED VIRTUAL }
enum ContestDivision   { DIV1 DIV2 DIV3 }
```

New models (sketch; exact columns settled when the migration is written):

| Model | Purpose |
|---|---|
| `Contest` | identity, window (`startsAt`, `endsAt`, `durationSec`), `kind`, `status`, `visibility`, audience columns, `freezeMinutes`, `isRated`, `ratingComputedAt`, `standingsVersion`, `createdById` |
| `ContestProblem` | `contestId` + `problemVersionId` (pinned), `index` ("A", "B", …), `points`, `@@unique([contestId, index])` |
| `ContestRegistration` | who registered, `ParticipationKind`, `registeredAt`, `virtualStartsAt?` |
| `ContestProblemAttempt` | `@@id([contestId, userId, contestProblemId])` — `wrongAttempts`, `points`, `solvedAt`, `penaltyMinutes`, `bestSubmissionId` (**authoritative**) |
| `ContestStanding` | `@@id([contestId, userId])` — `rank`, `score`, `penalty`, `lastAcceptedAt`, `version` (optimistic concurrency) |
| `RatingChange` | `userId`, `contestId`, `before`, `after`, `delta`, `rank`, **`seed`**, `ratedCount`, `computedAt` |
| `UserRating` | `userId @id`, `rating`, `contestsRated`, `isProvisional` (< 5), `lastRatedAt`, `division` |

Database-enforced invariants to write as CHECKs and triggers, in the Phase 4
style (every one listed in `packages/db/test/support/guard-catalog.ts`):

- `endsAt > startsAt`; `freezeMinutes >= 0`, and freeze only on contests
  ≥ 90 minutes;
- `ContestProblem.points > 0`;
- a `ContestProblemAttempt` with `solvedAt` set has `bestSubmissionId`;
  `wrongAttempts >= 0`; `penaltyMinutes >= 0`;
- `RatingChange` is append-only (no UPDATE, no DELETE — the `XpEvent` rule);
- `Contest.ratingComputedAt` is set once and never cleared;
- a `RATED` contest has `ratingComputedAt`; a contest with fewer than 30
  rated participants can never reach `RATED`;
- TRUNCATE refused on `ContestProblemAttempt`, `ContestStanding`,
  `RatingChange`.

## 2. Pure modules (`packages/shared`)

### `rating.ts`

The spec's formula, verbatim and unit-tested:

```
seed_i    = 1 + Σ_{j≠i} 1/(1 + 10^((R_i − R_j)/400))
m_i       = sqrt(seed_i × actualRank_i)
R'_i      = solve seed(R'_i) = m_i, 25-iteration binary search on [0, 4000]
delta_i   = (R'_i − R_i)/2
          − Σdelta/n   (applied to everyone)
then shift the top min(n, round(4·√n)) by pre-contest rating so Σdelta ≤ 0
finally clamp |delta_i| ≤ 200
```

Exports: `computeRatingChanges(participants) → RatingChange[]`,
`seedOf`, `divisionOf(rating)`, `isProvisional(contestsRated)`,
`RATING_SEED = 1200`, `MIN_RATED_PARTICIPANTS = 30`, `RATING_CLAMP = 200`.

### `contest-scoring.ts`

- ICPC: `penalty = solveMinutes + 20 × wrongAttemptsBeforeSolve`, and a
  rejected submission on a problem never solved adds nothing.
- SUBTASK: partial credit per subtask, aggregated by the problem's existing
  `SubtaskAggregation` (`MIN` / `SUM_FRACTION`) — reuses Phase 2's logic
  rather than a second implementation.
- `rankStandings(rows)` — the tie rule, shared by the live board and
  `rebuild-standings`, so both orderings are the same function.
- `isFrozen(contest, now)` — freeze engages for the final 30 minutes of a
  contest ≥ 90 minutes.

## 3. Standings: live and rebuilt

- Redis ZSET per contest, score packed so one `ZREVRANGE` gives the order;
  SSE pushes coalesced at 2 s (never per submission).
- Postgres snapshot every 60 s and at contest end (scheduler job).
- `rank` recomputed by one job every 15 s.
- `scripts/rebuild-standings.ts <contestId>` — reads
  `ContestProblemAttempt` only, rewrites `ContestStanding`, and is the gate
  test for decision 1.
- During freeze the board serves the pre-freeze snapshot to everyone except
  staff; a participant always sees their own row live.

## 4. Routes and guards

| Route | Notes |
|---|---|
| `/contests` | list: upcoming, running, past; registration state |
| `/contests/[slug]` | landing + rules; register / start virtual |
| `/contests/[slug]/arena` | **no sidebar**; hard-blocked < 768 px |
| `/contests/[slug]/standings` | live (SSE), freeze-aware |
| `/contests/[slug]/analysis` | after the contest: editorials, own attempts |

Guards: student pages behind the student layout guard; contest authoring
under `/admin/contests` (staff, `AdminScope` for COHORT visibility). The
arena refuses a non-registered user and a finished contest.

## 5. Judge integration

Contest submissions use the existing `CONTEST` lane and
`SubmissionOrigin.CONTEST`; nothing new in the worker. The finalise
transaction gains the contest branch the spec already names: update
`ContestProblemAttempt` and touch `ContestStanding` — counters by
`{ increment }`, no rank renumbering inside the transaction.

## 6. Tests (the phase's "Done when")

1. **Rating fixture** — a known Codeforces-shaped fixture; asserts
   `Σdelta ≈ 0` and the top-set constraint.
2. **Rating idempotence** — a second computation is refused
   (`ratingComputedAt` already set) and changes nothing.
3. **`rebuild-standings`** — reproduces a standings table byte-for-byte
   from `ContestProblemAttempt` after a simulated Redis flush.
4. ICPC penalty and SUBTASK partial-credit unit tables, including a rejected
   submission on a never-solved problem.
5. Freeze engages / lifts; a participant sees their own row during freeze.
6. Structure: no page aggregates `ContestProblemAttempt` to render a board;
   `ContestProblem` never references `Problem.liveVersionId`.
7. e2e: a contest a student can register for, enter, solve in, and see
   themselves on the board.

Manual (spec): a 150-participant simulated contest — standings update within
2 s, freeze engages, the practice lane is never starved, and a mid-contest
problem edit changes no already-judged verdict. The Phase 2 burst harness
(`scripts/load/`) is the starting point for generating it.

## 7. Open questions to record

- Does a virtual contest write `XpEvent` rows at all? Narrower reading:
  no XP for virtual participation (it is practice against a replayed clock),
  so the ledger stays comparable.
- Division is derived from rating; is it stored on `UserRating` (fast reads,
  must be kept in step) or computed on read? Narrower reading: computed by
  `divisionOf()`, stored only if a board query needs it.
- A contest that never reaches 30 rated participants: `FINISHED` forever, or
  a terminal `UNRATED` marker? The spec says "automatically unrated and says
  so in advance", which suggests the flag is decided before the start.
