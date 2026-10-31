# Phase 4 gate tests and verification plan

## 0. Before Phase 4 can close (blockers)

1. **Phase 3 has no gate record.** The `docs/RUNBOOK.md` §3 gate log stops at Phase 2 (line 533). Ground rule 0 says a phase gate must pass before the next phase begins. The coordinator has to record the Phase 3 rows, or run the Phase 3 gate, before Phase 4 closes.
2. **A leftover debug spec is in the e2e folder.** `apps/web/e2e/zz-debug-a11y.spec.ts` is headed "TEMPORARY debug spec". `e2e/tsconfig.json` typechecks it and lint scans it. Delete it before the gate.
3. **`apps/web/playwright.config.ts` changed while I was reading it.** It now gives each project its own `outputDir` (lines 53–62). New projects must follow that pattern, and one stream should own edits to this file.

## 1. Existing test infrastructure

| Runner | Config | Where it runs |
|---|---|---|
| Unit tests per package | `apps/web/vitest.config.ts` (`test/**`, `src/**`, alias `@`, `server-only` stub); `packages/db/vitest.config.ts` (`fileParallelism:false`, hookTimeout 180 s); `packages/shared`, `packages/design`; `apps/judge-worker/vitest.config.ts` (excludes `test/integration`); `apps/scheduler` | `pnpm test` = `pnpm -r --workspace-concurrency=1 test && vitest run --config vitest.repo.config.ts` |
| Repo structure tests | `vitest.repo.config.ts` → `tests/repo/**`, `scripts/load/**`. Helpers `findFiles`, `lexSource`, `moduleSpecifiers` in `tests/repo/support/repo.ts` | `pnpm test`, Windows and Linux |
| Database / Redis tests | Opt-in: `describe.skipIf(process.env.RECX_DB_TESTS !== "1")`. URL is `RECX_TEST_DATABASE_URL`, default `…@localhost:5433/recx_test`, and must end in `_test`. Most files are `*.db.test.ts`; `packages/db/test/frozen-version.test.ts` is not. Migrations reach `recx_test` only because `frozen-version.test.ts` runs `prisma migrate deploy` in its `beforeAll` (lines 50–59, 84), which works because `pnpm -r` runs `packages/db` before `apps/web`. Web database files run in parallel against one database: unique tags, upsert `LanguageConfig` by catalog key (`judge-pipeline.db.test.ts:~300`). | Linux `services-tests` step; CI Linux leg sets `RECX_DB_TESTS=1` |
| Real isolate sandbox | `apps/judge-worker/vitest.integration.config.ts`: one fork, files in sequence, 600 s per test. Box bases: two-sum 40, judging 50, adversarial 60. Uses `FakeJudgeApi`, `processJob`, `IsolateDriver` | Linux `isolate-integration` step; CI `judge-integration` job runs every file in the folder |
| Playwright | `apps/web/playwright.config.ts`: projects `a11y`, `keyboard`, `perf`; external stack (`E2E_BASE_URL`); `global-setup.ts` signs in student, journey and admin; judge steps need `E2E_JUDGE=1` | Not part of the four gates. CI `e2e` job runs `--project=a11y --project=keyboard` with no judge |

`scripts/dev/linux-gate.sh` runs: sync with `--install`, then lint, typecheck, test, build, `services-tests` (`RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 pnpm test`), `isolate-integration` (`RECX_ISOLATE_INTEGRATION=1 RECX_CACHE_DIR=/tmp/recjudge-cache pnpm --filter @recx/judge-worker test:integration`). Lines 13–16 refuse to start if any `next`/`next-server` process is running in WSL.

## 2. What already covers each "Done when" item

| Item | Status |
|---|---|
| Four gates | The machinery exists. The Phase 3 record is missing (see §0). |
| Role × capability matrix | **Missing.** `guards.ts:61` refers to `src/lib/auth/capabilities.ts`, which does not exist. |
| Golden-file test | **Missing.** `apps/web/test/seed-content.test.ts` re-checks the seed content in JavaScript only. `two-sum.isolate.test.ts` runs only two-sum. Phase 2 validated two problems through the CLI by hand (RUNBOOK row 531), which is not an automated test. |
| Frozen version rejects writes | **Partly there.** `packages/db/test/frozen-version.test.ts` covers ProblemVersion, TestCase, StarterCode and ReferenceSolution against both fences (the repository guard and the database trigger). Subtask, ProblemLanguageLimit, Hint and Editorial have guards (`frozen.ts:19` `CHILD_MODELS`, migration triggers) but are only touched in passing (`judge-pipeline.db.test.ts` checks one limit `updateMany`; `validation-clone.db.test.ts` checks one hint insert). Nested writes through `Problem` skip the extension and are not tested. |
| Two concurrent publishes | **Library level exists:** `apps/web/test/judge-pipeline.db.test.ts:645-708` against `publishVersion` (`validation.ts:637-712`, flip guarded at 672-688). **The Phase 4 server action path is missing:** role check, required expected version, audit actor. |
| No student route returns hidden tests or reference source | **Missing.** Today only `claim.ts:350`, `finalize.ts:267` and `validation.ts` read `referenceSolution`, and only node routes import them. Nothing enforces that. |
| Manual authoring journey | **Missing.** The submission page shows the pinned version's title (`queries/submissions.ts:146`) but not its revision number, so an edit to the statement alone cannot be seen there. |

## 3. Schema and source changes

**Prisma: none from this stream.** No new models or enums, and no migration.

Small source changes this stream needs (owner given where it isn't this stream):

```ts
// packages/db/src/frozen.ts — rename CHILD_MODELS and export it
export const FROZEN_CHILD_MODELS: ReadonlySet<string> = new Set([
  "TestCase","StarterCode","ReferenceSolution","Subtask","ProblemLanguageLimit","Hint","Editorial",
  /* + any Phase 4 version-child */]);
/** Models that reference ProblemVersion but stay writable after freeze, with the reason. */
export const FROZEN_EXEMPT_MODELS: Readonly<Record<string, string>> = {
  Problem: "holds liveVersionId; publish flips it",
  Submission: "pins a version; judged after freeze",
  RunRequest: "pins a version; judged after freeze",
  ValidationRun: "validation history of a version",
};
// packages/db/src/index.ts
export { FrozenVersionError, FROZEN_CHILD_MODELS, FROZEN_EXEMPT_MODELS } from "./frozen";
```

```ts
// apps/web/src/lib/judge/validation-rules.ts (NEW, pure: no server-only, no db)
// Moved verbatim from validation.ts:43-74:
export const CPP_MODEL_LANGUAGES: readonly string[];
export function stageOf(expected: Verdict): 1 | 2;
export function effectiveVerdict(verdict: Verdict, tests: readonly { v: Verdict }[]): Verdict;
export function validationOutcome(expected: Verdict, verdict: Verdict, tests: readonly { v: Verdict }[]): "MATCHED" | "MISMATCHED";
// validation.ts re-exports these, so finalize.ts:17 and test/validation.test.ts are unchanged.
```

Other changes:
- **Submission page shows the revision** (owner: student surface or authoring). Add `revision: true` to `SUBMISSION_SELECT.problemVersion.select` (`queries/submissions.ts:~54`) and return `problem.revision`. In `problems/[slug]/submissions/[id]/page.tsx`, add a fourth `<dt>Problem version</dt><dd>Revision {n}</dd>` to the `<dl>`.
- **Seed accounts** (owner: seed or users stream). In `apps/web/scripts/seed.ts:153-181`, widen `SeedUser.role` to include `"ADMIN"`. Add ADMIN `RECADMIN02` (password from `SEED_ADMIN_PASSWORD`) and student `2116231001004` (used only by the authoring spec).

## 4. Gate tests

### 4.1 Frozen version and its children reject writes

**A. `packages/db/test/frozen-coverage.test.ts`** — unit test, Windows and Linux, `pnpm test`:
- Parse `schema.prisma`. Every model with a `<field> ProblemVersion? @relation(… fields: [...])` must be in exactly one of `FROZEN_CHILD_MODELS` or `FROZEN_EXEMPT_MODELS`, and every exempt model needs a non-empty reason.
- For every child model `M`, some `migrations/*/migration.sql` must contain `CREATE TRIGGER "M_frozen_guard" BEFORE INSERT OR UPDATE OR DELETE ON "public"."M" … recx_refuse_frozen_child_write`. `ProblemVersion_frozen_guard` must be `BEFORE UPDATE OR DELETE`.
- `Object.keys(FACTORIES)` imported from (B) must equal `FROZEN_CHILD_MODELS`. A new child added without a factory fails here, on Windows.

**B. `packages/db/test/frozen-children.test.ts`** — database test, `services-tests`. It follows the setup of `frozen-version.test.ts`: refuse a non-`_test` database, apply migrations, use `createPrismaClient({url, log: []})`.
- `export const FACTORIES: Record<string, (versionId: string, n: number) => object>` gives one valid `create` data per child model.
- For each `M` (via `it.each`): create under a draft (allowed), freeze through the publish transition, then each of these must reject with `FrozenVersionError`: `create`, `createMany`, `update` by id, `updateMany` by version id, `upsert`, `delete`, `deleteMany`, and moving a draft's child into the frozen version. Raw `INSERT`, `UPDATE` and `DELETE` must throw `/frozen/`, and the row count must stay the same.
- Version level:
  - `db.problem.update({ data: { versions: { update: { where: { id: frozen }, data: { statementMd: "x" } } } } })` must throw `/frozen/`. The extension never sees this nested write; the database trigger has to catch it.
  - `db.problemVersion.update({ where: { id: frozen }, data: { testCases: { create: … } } })` must throw `FrozenVersionError`.
  - `status: "RETIRED"` on a frozen version must be refused, which proves retiring has to write to `Problem` only.
- Teardown: one transaction that disables `[...FROZEN_CHILD_MODELS, "ProblemVersion"]` triggers, deletes, and re-enables them (the pattern at `frozen-version.test.ts:142-160`). Then assert no `%_frozen_guard` trigger is left disabled.

### 4.2 Two concurrent publishes: one success, one conflict

**`apps/web/test/problem-publish.db.test.ts`** — database test, `services-tests`. This is the action-level test; the library test at `judge-pipeline.db.test.ts:645` stays as it is.

Contract the authoring stream must meet:

```ts
// apps/web/src/server/actions/admin-problems.ts
export async function publishProblemVersion(
  input: { versionId: string; expectedProblemVersion: number }  // zod: both required
): Promise<ActionResult<{ problemId: string; revision: number }>>
// Guard: requireActionRole("ADMIN","SUPER_ADMIN").
// Maps PublishResult CONFLICT/BLOCKED to { ok:false, error } using the messages at validation.ts:648 and :686.
```

- **Mocks.** The session comes from `AsyncLocalStorage` created in `vi.hoisted`: `vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => als.getStore() ?? null }))`. A single shared `state.user` would race under `Promise.all`. Redis, queue and the test-data store use the fakes from `judge-pipeline.db.test.ts:29-76`. Also mock `next/cache` and `@/lib/ip`. `audit` is real.
- **Fixtures.** Upsert the catalog `LanguageConfig` rows for cpp20 and py312. Create admins A and B (role ADMIN). Create problem P with draft r1 and draft r2, each with test blobs and a cpp20 expected-AC reference. Insert `ValidationRun` rows directly as `DONE`, `MATCHED`, with `measuredMs`, so `summarizeValidation` reports COMPLETE without a judge.
- **Cases:**
  1. A publishes r1 while B publishes r2, both with the same `expectedProblemVersion`. Exactly one `ok:true`; the other `ok:false` with `/changed concurrently/`. `Problem.liveVersionId` is the winner and `version` went up by 1. The loser is still `DRAFT` with `frozenAt null` and its limit rows are unchanged. Exactly one `problem.published` audit row since t0, and its actor is the winner. Repeat 5 times with fresh drafts.
  2. The same draft published twice at once: one ok, one `/already published/`, one audit row.
  3. A stale `expectedProblemVersion` gets a conflict and changes nothing.
  4. Omitting `expectedProblemVersion` fails validation with no writes, so a stale form cannot publish over a newer revision.
  5. STUDENT, TA_MENTOR and PLACEMENT_OFFICER get Forbidden and no audit row.
- **Why it isn't flaky.** Passing the same expected version makes the result independent of timing. In READ COMMITTED, the losing `updateMany … WHERE version = $expected` waits for the winner's row lock, re-checks its condition after the winner commits, and matches 0 rows.

### 4.3 No student route returns hidden tests or reference source

**D1. `tests/repo/student-exposure.test.ts`** — static check, Windows and Linux, `pnpm test`. It works by confining sensitive code to named paths:

```ts
export const SENSITIVE_PREFIXES = [
  "apps/web/src/app/api/judge/", "apps/web/src/lib/judge/claim.ts", "apps/web/src/lib/judge/finalize.ts",
  "apps/web/src/lib/judge/validation.ts", "apps/web/src/lib/testdata/", "apps/web/src/lib/authoring/",
  "apps/web/src/server/queries/admin-", "apps/web/src/server/actions/admin-", "apps/web/src/server/actions/super-",
  "apps/web/src/app/admin/", "apps/web/src/app/super/", "apps/web/src/components/admin/", "apps/web/src/components/super/",
] as const;
```

Rules applied to every `apps/web/src` file outside those paths, with comments stripped by `lexSource`:
- **R1:** no `referenceSolutions?` or `ReferenceSolution` in code or in SQL strings.
- **R2:** no `testBlob` delegate, `readBlobBytes`, `getTestDataStore`, or `"TestBlob"` in SQL.
- **R3:** any `testCase(s)` query block that selects `input:` or `output:` must include `isSample: true`. Today `queries/problems.ts:278` and `queries/submissions.ts:27` pass.
- **R4:** no module outside the sensitive paths may import one inside them (imports resolved through `@/` and relative paths).

Each rule has flagged / not-flagged self-tests, like `tests/repo/xp-ledger.test.ts`.

**D2. `apps/web/test/student-exposure.db.test.ts`** — database test, `services-tests`, using canary strings.
- **Canaries.** `HIDDEN-IN-${tag}`, `HIDDEN-OUT-${tag}`, `HIDDEN-BIG-${tag}` (a blob held only in the fake store under `storageKey`), `REF-SRC-${tag}` (in cpp20 AC and py312 WA reference sources), `CHECKER-SRC-${tag}`. Positive control: `SAMPLE-IN-${tag}`.
- **Fixture.** A published, frozen CHECKER problem. Student S owns a DONE WA submission whose stored jsonb hidden entry is deliberately polluted: `{"i":1,"v":"WA","ms":3,"kb":9,"in":…,"out":…}`. S also has sample-only `SubmissionTestDetail` rows, a DONE `RunRequest`, a bookmark, a note and activity on the problem.
- **Called as S:**
  - **Routes:** every `src/app/**/route.ts`, found by glob. The `ROUTE_CALLS` table must cover every file. `api/judge/*` with the student cookie and no node headers must return 401 or 426. SSE `stream` routes are read until the first event, or 2 s.
  - **Queries:** every export of non-`admin-` modules in `src/server/queries/*.ts`. Each needs an entry or a reason in `NOT_PROBLEM_SCOPED`.
  - **Pages:** each student page under `(student)`, `u`, root and `offline`. Call `await Page({ params, searchParams })` with `next/navigation` and `next/headers` mocked. `test/support/collect-strings.ts` (`collectStrings(node): Promise<string[]>`) walks the returned element props and expands only `AsyncFunction` components. Exceptions go in `PAGE_SKIPS` with a reason; D1 still covers those pages.
  - **Actions:** every action in `SELF_SERVICE_ACTIONS` (from §4.4) with a fixture input.
- **Assertions.** No collected output contains any secret canary. The workspace output contains `SAMPLE-IN` (proves the check isn't empty). The submission view drops the polluted keys.

**D3.** A crawl inside the authoring e2e spec (§5) gives live-runtime evidence.

### 4.4 Role × capability matrix

The capabilities stream must provide `apps/web/src/lib/auth/capabilities.ts`:

```ts
export const ROLES: readonly Role[];
export const SUPER_ADMIN_CAPABILITIES: readonly Capability[];  // exactly the 12 from the spec
export const CAPABILITIES: Readonly<Record<Capability, { roles: readonly Role[]; description: string }>>;
export function can(role: Role, capability: Capability): boolean;
```

**Test support — `apps/web/test/support/capability-bindings.ts`:**

```ts
export type Binding =
  | { kind: "action"; load: () => Promise<Record<string, unknown>>; exportName: string; input: unknown }
  | { kind: "page"; load: () => Promise<{ default: (p: object) => unknown }>; params?: Record<string, string> };
export const CAPABILITY_BINDINGS: Readonly<Record<Capability, readonly Binding[]>>;
export const SELF_SERVICE_ACTIONS: readonly Extract<Binding, { kind: "action" }>[];   // requireActionUser
export const PUBLIC_ACTIONS: readonly { file: string; exportName: string }[];        // auth.login, auth.logout
export const PENDING_CAPABILITIES: Partial<Record<Capability, string>>;               // e.g. ratings → "Phase 6"
```

A second helper, `test/support/fake-db.ts`, provides a `Proxy` that logs and throws `DbTouched` on any property access.

**`apps/web/test/rbac-matrix.test.ts`** — unit test, Windows and Linux.
- **Mocks.** `@/lib/auth/session` returns a state user. `@/lib/auth/guards` is the real module wrapped by `vi.fn` spies that append `guard:*` to a shared call log. `@/lib/db` is the fake db. `audit`, `ip`, `queue`, `redis`, `next/cache` and `rate-limit` are spies. `next/navigation`'s `redirect` throws `RedirectSentinel(url)`.
- **Checks:**
  1. 12 unique super-admin capabilities, each with roles exactly `["SUPER_ADMIN"]`.
  2. For every role (plus signed out) × capability × binding:
     - Denied action: returns exactly the Forbidden result (Unauthorized when signed out), with no db access, no audit call and no enqueue.
     - Allowed action: the error is neither Forbidden nor Unauthorized.
     - Denied page: throws `RedirectSentinel(homeForRole(role))` (`/login` when signed out) before any db access.
     - Allowed page: no redirect.
  3. Each super-admin binding calls `requireSuperAdmin` (actions) or `requireSuperAdminPage` (pages) once, before the first db access in the log.
  4. Completeness: read `src/server/actions/*.ts` from disk and import each module. Every export must be in exactly one list. Every export of an `admin-*` or `super-*` module must be bound to a capability that excludes STUDENT.
  5. Each pending capability has no binding, an `it.todo`, and a phase later than 4.

**`tests/repo/page-guards.test.ts`** — static check: every `page.tsx` and `layout.tsx` under `app/admin/**` calls `requirePageRole(` with staff roles only, and everything under `app/super/**` calls `requireSuperAdminPage()`.

### 4.5 Golden files: seeded reference solutions get AC

**`apps/web/scripts/content/golden.ts`** — new and pure. It may import only `@recx/shared*`, `./index`, `./types` and `../../src/lib/judge/job-spec`; that last module is pure and is the production mapping, `buildJudgeJobSpec` at `job-spec.ts:197`.

```ts
export interface GoldenTest { index:number; isSample:boolean; subtask:number|null; points:number|null; input:string; output:string }
export interface GoldenReference { language: LanguageKey; label: string; expected: Verdict; source: string }
export interface GoldenProblem { slug:string; ioMode:IoMode; signature:FunctionSignature|null; compareMode:CompareMode;
  floatEpsilon:number|null; scoringMode:ScoringMode; stopOnFirstFailure:boolean; timeLimitMs:number; memoryLimitKb:number;
  checkerSource:string|null; subtasks:{index:number;points:number;aggregation:SubtaskAggregation;dependsOn:number[]}[];
  tests:GoldenTest[]; references:GoldenReference[] }
export interface GoldenManifest { enabledLanguages: LanguageKey[]; problems: { slug:string; mode:string; timeLimitMs:number;
  memoryLimitKb:number; tests:{count:number;samples:number;digest:string}; checkerSha256:string|null;
  references:{language:LanguageKey;label:string;expected:Verdict;sourceSha256:string}[] }[] }
export function seededProblems(): GoldenProblem[];      // TWO_SUM (+TWO_SUM_REFERENCE) + AUTHORED_PROBLEMS
export function enabledLanguages(): LanguageKey[];      // LANGUAGE_KEYS.filter(k => LANGUAGE_CATALOG[k].enabledByDefault)
export function goldenManifest(p?: readonly GoldenProblem[]): GoldenManifest;
export function goldenJob(p: GoldenProblem, r: GoldenReference,
  o: { id: string; languageLimit: { timeLimitMs: number; memoryLimitKb: number } | null }): { spec: JudgeJobSpec; blobs: Map<string, Buffer> };
```

`goldenJob` builds a `kind: "validation"` job on lane REJUDGE, so an expected-AC reference runs at the CPU ceiling, exactly as in production.

The committed golden file is `apps/web/scripts/content/seed-golden.json`.

**`apps/web/test/seed-golden.test.ts`** — unit test, Windows and Linux:
- `goldenManifest()` must equal the JSON file, with CRLF normalised. Setting `RECX_UPDATE_GOLDEN=1` rewrites the file; review the diff.
- Every problem × every enabled language has at least one expected-AC reference.
- Every problem has at least one hidden test and at least one deliberately-wrong reference.
- `goldenJob` builds a valid spec for every reference.
- Purity check: the import graph from `golden.ts` contains no db module, `server-only` or `@/` import.

**`apps/judge-worker/test/integration/seed-golden.isolate.test.ts`** — Linux isolate step, box base `RECX_GOLDEN_BOX_BASE ?? 70`, set up like `judging.isolate.test.ts:166-195`:
- **Preflight.** Every enabled language's `/opt/toolchains/<toolchainId>` must exist, and testlib if any problem uses CHECKER. A missing one fails the test rather than skipping it.
- **Stage 1.** Each expected-AC reference in each enabled language must give `verdict === "AC"` with `passedCases === totalCases`. Record the worst time per language.
- **Derived limits.** `deriveTimeLimitMs({ baseMs, measuredModelMs: worst, multiplier, extraMs })`, the same as `validation.ts:229-257`.
- **Stage 2.** Each deliberately-wrong reference runs at the derived limit and must give `validationOutcome(...) === "MATCHED"`.
- Also re-assert that the manifest equals the committed file. Print a summary table; a ratio of limit to measured time below 2.5 is a warning, not a failure.

## 5. Manual verification, automated: `apps/web/e2e/authoring-journey.spec.ts`

New project `authoring`. Skipped unless `E2E_JUDGE=1`. Serial, `test.setTimeout(20 * 60_000)`.

**Support files:**
- `e2e/support/authoring.ts` holds an original problem, "Loud Echo": read one word, print it in upper case. The slug is `e2e-loud-echo-${runId}`.
  - Hidden input: `e2ehidden${runId}`.
  - Sources carry the comment `e2e-ref-canary-${runId}`: a wrong cpp20 "model" that echoes the input unchanged (labelled expected AC), the fixed cpp20 model, a py312 model, and a py312 deliberately-wrong `print(input())` labelled expected WA.
  - Also exports the sha256 of the hidden input.
- `support/accounts.ts`: add `authoring` (`2116231001004`, from `E2E_AUTHORING_STUDENT_ID`) and `staffAdmin` (`RECADMIN02`).
- `global-setup.ts`: sign those two in, and warm `/admin/problems` and `/admin/problems/new` for the admin.

**Steps:**
1. **Create the draft (admin `RECADMIN01`).** On `/admin/problems/new`, create the problem. On `/[id]/testcases`, add 1 sample and 3 hidden tests. Add the references.
2. **Fail validation on purpose.** On `/[id]/validate`, start validation. Within 5 minutes the status must match `/Model solution failed: .*produced WA/`, and Publish must be disabled.
3. **Fix and publish revision 1.** Edit the cpp20 source and re-validate until complete. Publish; expect "Published revision 1".
4. **Student submits.** As student 004, open the workspace, pick Python 3.12 and type `print(input().upper())`. Submit and wait up to 75 s for Accepted. Save the submission URL.
5. **Admin publishes revision 2.** Create a new revision, add `R2-marker-${runId}` to the statement, validate, publish, and expect "Published revision 2".
6. **Check the versions.**
   - The old submission page shows "Revision 1", for both the student and the admin.
   - The workspace contains the R2 marker.
   - A new submission shows "Revision 2".
7. **Crawl as the student (D3).** Visit `/problems`, the workspace, both submission pages, `/api/submissions/<id>`, `/api/search?q=<slug>`, `/dashboard`, `/profile`, `/u/<handle>`, `/leaderboard`, `/bookmarks`, `/notes`, `/sheets`, `/learn` and `/help`.
   - Collect every HTML, `text/x-component` and JSON response.
   - None may contain the hidden input, its upper-case output or the reference canary.
   - `/admin/problems/<id>` must redirect to `/dashboard`.
   - `GET /api/judge/blob/<hiddenSha>` must return 401.
8. **Clean up.** Retire the problem (super-admin, with a reason) so other specs never see it.

**UI contract for the authoring stream** (accessible names; the spec uses `fill`):

| Page | Controls |
|---|---|
| `/admin/problems/new` | Labels "Title", "Slug", "Display code", "Difficulty", "Input mode", "Comparator", "Statement (Markdown)", "Time limit (ms)", "Memory limit (MB)"; button "Create draft" |
| `/[id]/testcases` | Textareas "Input" and "Expected output", checkbox "Sample", button "Add test case" |
| `/[id]` references | Selects "Language" and "Expected verdict", inputs "Label" and "Source"; **"Source" must be a plain `<textarea>`**; button "Save reference solution" |
| `/[id]/validate` | Button "Start validation"; a `role="status"` region showing the blockers; button "Publish"; confirmation text "Published revision N" |
| `/[id]` | Buttons "Create new revision" and "Retire problem" (retire takes a reason) |

**`apps/web/e2e/rbac.spec.ts`** — new project `rbac`, no judge needed, added to the CI e2e job. A student visiting any `/admin/**` or `/super/**` URL ends on `/dashboard`. `RECADMIN02` visiting `/super/**` ends on `/admin`. A super-admin sees the strip "Super-admin — all actions are audited".

**Add to `playwright.config.ts`:**

```ts
{ name: "rbac", testMatch: /rbac\.spec\.ts$/, outputDir: "./test-results/rbac" },
{ name: "authoring", testMatch: /authoring-journey\.spec\.ts$/, outputDir: "./test-results/authoring" },
```

## 6. Gate commands and recording

**Windows:**
```powershell
npx pnpm@9.15.9 lint; if ($?) { npx pnpm@9.15.9 typecheck }; if ($?) { npx pnpm@9.15.9 test }; if ($?) { npx pnpm@9.15.9 build }
```

**Linux**, with every Next server in WSL stopped first:
```powershell
wsl -d Ubuntu -- bash -lc 'RECX_SRC=/mnt/c/Users/SUBASH/OneDrive/Documents/GitHub/REC-CODE bash <(sed "s/\r$//" /mnt/c/Users/SUBASH/OneDrive/Documents/GitHub/REC-CODE/scripts/dev/linux-gate.sh)'
```

Add this step to `linux-gate.sh` before `services-tests`, so the Phase 4 migration doesn't rely on the order `pnpm -r` runs test files in:
```bash
step migrate-test env DATABASE_URL=postgresql://recx:recx-dev-only@localhost:5433/recx_test DATABASE_URL_DIRECT=postgresql://recx:recx-dev-only@localhost:5433/recx_test $PNPM db:migrate
```

**Live stack** for the e2e run (WSL mirror `~/recx`, in this order):
1. Run the gate.
2. Copy `apps/web/.env.local` into the mirror once (the sync never copies it).
3. Start `corepack pnpm@9.15.9 --filter @recx/web dev` on :3000, `corepack pnpm@9.15.9 scheduler:dev`, and `corepack pnpm@9.15.9 --filter @recx/judge-worker dev`. The mirror's worker `.env.local` needs:
   - `RECX_NODE_ID=dev-judge-1`
   - `RECX_DRIVER=isolate`
   - `RECX_SLOTS=8`
   - `RECX_QUEUES=judge-practice,judge-run,judge-rejudge`
   - `RECX_DEV_ALLOW_UNHARDENED_HOST=1`
   - `RECX_CACHE_DIR=/var/tmp/recjudge-blobs`
4. Run migrations and the seed.
5. From Windows:
```powershell
cd apps/web; $env:E2E_JUDGE="1"; npx playwright test --project=a11y --project=keyboard --project=rbac --project=authoring
```

**RUNBOOK §3 rows for Phase 4**, filled in only from real runs:
1. Windows four gates.
2. Linux through `linux-gate.sh`.
3. `services-tests`, with counts for frozen-children, problem-publish and student-exposure.
4. `isolate-integration`, including seed-golden N/N.
5. The rbac-matrix unit counts.
6. The authoring e2e on the live stack (node `dev-judge-1`, 8 slots, with `judge-rejudge`).
7. rbac + a11y + keyboard.
8. CI: "NOT RUN" unless the code was pushed.

Also update RUNBOOK §1.6, `e2e/README.md`, `CONVENTIONS.md` (the sensitive-path naming) and the CI e2e job (`--project=rbac`).

## 7. Timing and flakiness risks

- **Validation can hang silently.** Validation jobs run on the REJUDGE lane. Its cap is `floor(0.2 × slots)` (`allocator.ts:108-111`), so a worker with fewer than 5 slots that also serves other lanes never runs them. The spec must time out after 5 minutes with a hint naming `RECX_SLOTS` and `RECX_QUEUES`.
- **The gate and the live stack can't overlap.** `linux-gate.sh` refuses to start while any `next-server` runs in WSL, and a dev server in the mirror shares `.next` with `next build`.
- **Gate length.** `pnpm test` runs twice (plain, then with services), and the golden suite adds about 2–4 minutes. Stop the dev worker during the isolate step to avoid CPU contention: a solution near its limit can flip to TLE. Models run at the CPU ceiling and wrong references at derived limits with wide margins, so verdicts are stable.
- **Parallel database tests.** Web database files run in parallel. New tests must use unique tags, upsert `LanguageConfig` by catalog key, and never delete across the board.
- **Concurrent sessions.** The concurrency test needs the `AsyncLocalStorage` session; a shared `state.user` races under `Promise.all`.
- **First compile under `next dev`.** New admin routes can take tens of seconds on first load; warm them in global-setup.
- **Leftover e2e data.** A crashed authoring run leaves a published problem in the dev `recx` database. Retire it by hand from `/admin/problems`; other specs pick problems by name and are unaffected.
- **In-flight caps.** Each student can have 2 submissions in flight. Separate accounts per spec avoid hitting this.

## 8. Interaction with other streams

| Area | Interaction |
|---|---|
| `schema.prisma` | Any new version-child model must be added to `FROZEN_CHILD_MODELS`, get a trigger in its migration, and get a factory in `frozen-children.test.ts`; §4.1 A fails otherwise. Retiring must write `Problem.status` only. If the enum gains `APPROVED`, it changes only on drafts. |
| `frozen.ts` | It needs a single owner, because the schema stream will add children to the same set. |
| Shared `index.ts` | This stream doesn't touch it. |
| Guards / capabilities | `guards.ts` is unchanged. `capabilities.ts` belongs to the RBAC stream and must export the shape in §4.4. `/super` must be its own tree with its own layout, not nested under `app/admin`. The admin layout (`layout.tsx:9`) is unchanged. If a stream opens an admin page to TA_MENTOR, it changes the layout and the bindings. |
| Authoring stream | Must follow the sensitive-path names in §4.3, the `publishProblemVersion` contract, and the UI contract. The `validation-rules.ts` extraction touches `validation.ts`, so coordinate edits. |
| Content / seed stream | New seeds (the 3 IN_PLACE_MUTATION and 3 CUSTOM_CHECKER problems) are picked up automatically, but they must: carry an AC reference in every enabled language, refresh `seed-golden.json`, and map new `AuthoredProblem` fields in `golden.ts`. |
| CI | The judge-integration job picks up the new isolate file with no change. |

## 9. Open questions (narrower reading chosen; record in `docs/OPEN-QUESTIONS.md`)

1. **"Enabled language"** means `LANGUAGE_CATALOG[k].enabledByDefault` (today cpp20 and py312), not the live `LanguageConfig.enabled` toggles.
2. **"Golden file"** means the committed manifest (test digests plus each reference's expected verdict). Deliberately-wrong references are checked too, mirroring the publish check.
3. **"STUDENT-reachable"** means pages, layouts and route handlers outside `admin`, `super` and `api/judge`, plus every action whose guard admits STUDENT. Staff paths are protected by guards, which the matrix test proves.
4. **"Shows the version it was judged against"** means the submission page shows the pinned revision number and title. A full as-judged statement on that page is not built.
5. **Pending super-admin capabilities** (ratings, integrity overturn, calendar and MEDICAL leave) stay `it.todo` until their phases.
6. **`grantJudgeQuotaOverride`** (`admin-judge.ts:318`) is super-admin only but matches none of the 12 capabilities. Either fold it into "PlatformSetting writes" or decide it otherwise.
7. **Publish conflicts are reported, never retried,** and `expectedProblemVersion` is required.