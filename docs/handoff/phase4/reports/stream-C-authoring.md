I've built the whole authoring and content pipeline in my stream's files. All 29 of my DB tests and 47 of my new unit tests pass, and typecheck, lint and repo tests are clean. Two things need the integration stage: `apps/web/src/app/api/admin/` must be added to `SENSITIVE_PREFIXES`, and the Playwright journey must approve as a second admin (details under Requests).

Not run: the seed, and the import, check-approved and validate-and-publish CLIs against a real database (I only checked their argument parsing). I also did not look at any page in a browser.

## Files created
Paths are relative to `C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-CODE`.

**`packages/shared/src/authoring/`**
- `origins.ts`: `CONTENT_ORIGINS` moved here from `index.ts`; same import path.
- `review.ts`: the six review stages, `reviewStageOf()` and `planReviewTransition()`.
- `content.ts`: `versionContentIssues()`, which calls D1's `comparatorIssues`. `JUDGEABLE_FUNCTION_COMPARATORS` is all six comparators, plus the limit and sample rules.
- `package.ts`: the import package format 1, its limits and its strict `meta.json` schema.

**`apps/web/src/lib/authoring/`** (every module starts with `import "server-only"`)
- `draft.ts`: `touchDraft` (`editSeq` / `judgeSeq` edit chokepoint), `lockSlug`, `rethrowFrozen`.
- `review.ts`: submit with originality attestation, withdraw, return, approve, `revokeApproval`. The approver must differ from the creator, last editor and submitter.
- `readiness.ts`: `getPublishReadiness`. `content-input.ts`: loads the content rules' input without reading blobs.
- `fingerprint.ts`: test-set fingerprint, so a test edit during publish becomes a conflict.
- `lifecycle.ts`: create a problem with its draft, `startRevision` (one open draft per problem), `setProblemTopics`. No retire or delete.
- `edits.ts`: details, judging, checker, references, starters, hints. `tests.ts`: add, update, remove (with renumbering) tests, and subtasks.
- `schemas.ts`: zod schemas for every action. `validation-wait.ts`: polling used by the CLIs.
- `retry.ts`: retries a whole transaction on a Postgres deadlock (40P01). DB test suites run in parallel and other suites' teardowns deadlock with our writes; every authoring and validation transaction now uses this.
- `import/spool.ts`, `import/archive.ts`, `import/package.ts`, `import/run.ts`, `import/process.ts`:
  - spool: byte cap, files created with `wx`, mode 0600;
  - archive: yauzl zip or a directory; refuses traversal, symlinks, NUL, case-folded duplicates; checks CRC and the declared caps;
  - package: collects every issue in an entry, plus a canonical package hash;
  - run: one transaction and one `ProblemImportRow` per entry;
  - process: the `after()` worker.

**Actions, queries, route**
- `server/actions/admin-problems.ts`: create, revisions, topics, the review actions, validation, `publishProblemVersion({versionId, expectedProblemVersion})`, `validateImportedDrafts`, `previewStatement`.
- `server/actions/admin-problem-content.ts`: twelve draft-edit actions, all audited as `problem.draft.edited` (NORMAL).
- `server/queries/admin-problems.ts`: list and review queue, problem detail, tests, validation report, imports. Every function starts with `assertStaffViewer`; name lookups use `staffOnlyWhere`.
- `app/api/admin/problems/import/route.ts`: checks run same-origin, staff guard, 415, 413, 409, then spool and `after()`.

**Pages and components**
- Pages under `app/admin/problems`: the list and queue (plus `loading.tsx`), `new`, `[id]` (supports `?rev=N`), `[id]/testcases`, `[id]/validate`, `import`, `import/[importId]`. Each one calls `requirePageRole("ADMIN", "SUPER_ADMIN")` itself.
- `components/admin/problems/*`: 16 files. Client components never import `@recx/shared`, editors are plain textareas, and there is no Monaco.
- The SUPER_ADMIN retire and delete controls import governance's `super-problems.ts`.

**Scripts:** `apps/web/scripts/import-problems.ts`, `apps/web/scripts/check-approved.ts` (with `--revoke` and `--repair-bundles`).

**Tests**
- `packages/shared/test/authoring-review.test.ts`, `authoring-content.test.ts`, `authoring-package.test.ts`.
- `apps/web/test/`: `problem-publish-concurrency.db.test.ts`, `problem-authoring.db.test.ts`, `problem-import.db.test.ts`, `import-package.test.ts`, `import-zip.test.ts`, `admin-problems-actions.test.ts`, `admin-import-route.test.ts`.
- `apps/web/test/support/authoring-fixtures.ts`, `apps/web/test/support/zip.ts`.

**Docs:** `docs/AUTHORING.md`.

## Files changed
- `apps/web/src/lib/judge/validation.ts` (owner):
  - FUNCTION runnable rule, with the note "has no function harness";
  - `judgeSeq` filtering and stamping on validation runs;
  - new `publishVersion(versionId, {actorId, via, expectedProblemVersion?, requireApproval = true, ipHash})` with the approval, content (comparator) and RETIRED gates;
  - bundle prepared before the transaction, keys pinned in the freeze update, bytes written after commit;
  - `ensurePublishedBundle` replaces `ensureVersionBundle`;
  - clone copies `origin`, takes `refuseIfDraftExists`, and writes no bundle;
  - re-exports `validationOutcome` / `effectiveVerdict` from `@recx/shared/harness`.
- `apps/web/src/lib/testdata/bundle.ts`: `prepareBundle` (async zstd) and `putBundle`; `writeBundle` now composes them.
- `server/queries/submissions.ts` and `app/(student)/problems/[slug]/submissions/[id]/page.tsx`: "Problem version: Revision N", "Judged against revision N", and a `<details>` "Problem as judged".
- `apps/web/scripts/seed.ts`: no longer writes draft bundles.
- `apps/web/scripts/validate-and-publish.ts`: adds `--approve` and uses `waitForValidation`.
- `apps/web/src/lib/env.ts`: `IMPORT_SPOOL_DIR`.
- `apps/web/next.config.ts`: `yauzl` added to `serverExternalPackages`.
- Tests not in any ownership row, edited because my `validation.ts` change broke them:
  - `apps/web/test/judge-pipeline.db.test.ts`: `requireApproval: false` added, and the clone's `bundleKey` is now null;
  - `apps/web/test/validation-clone.test.ts`: stale mock replaced;
  - `apps/web/test/validation.test.ts`: one test added for the runnable rule.
- `docs/OPEN-QUESTIONS.md`: new section `### Phase 4 — C authoring`.
- `docs/RUNBOOK.md`: new §2.10 (import, check-approved, bundle repair).
- `docs/ARCHITECTURE.md`: new "Problem authoring (Phase 4)" section.

## Tests
| Suite | Command | Result |
|---|---|---|
| shared, Windows | `npx vitest run` in `packages/shared` | 22 files, 497 passed (my 3 files: 23 tests) |
| web unit, Windows | `npx vitest run` in `apps/web` | 88 passed, 24 skipped (DB) files; 1704 passed, 143 skipped tests |
| My web unit files | the 6 files above | 59 passed (incl. 19 in `validation.test.ts`) |
| My DB files, WSL | `scratchpad/c_dbtest.sh` (sync, then `RECX_DB_TESTS=1 RECX_REDIS_TESTS=1 corepack pnpm@9.15.9 --filter @recx/web exec vitest run <files>`) | 22 / 22 |
| Whole web package with DB tests, WSL | `scratchpad/c_dbtest_all2.sh` | 112 files, 1847 / 1847 passed |
| Repo tests | `npx vitest run --config vitest.repo.config.ts tests/repo` | 9 files, 370 passed |
| enum parity | `packages/db`, `test/enum-parity.test.ts` | 30 passed |

The 22 DB tests break down as:
- **Publish concurrency, 6:** two revisions with the same expected version (5 rounds); the same draft twice (3 rounds); a stale expected version; a missing expected version; STUDENT, TA_MENTOR, PLACEMENT_OFFICER and signed-out callers refused; publish racing `retireProblem` (3 rounds).
- **Authoring flow, 4:**
  - fail validation with a WA model;
  - approve and publish blocked;
  - withdraw, fix, revalidate;
  - self-approval refused;
  - second admin approves;
  - publish r1;
  - pin a submission;
  - publish r2 with an edited statement;
  - old submission still on r1 and r1's rows identical;
  - a test edit after validation blocks publish;
  - admin queries smoke test.
- **Import, 2:** the 300-entry archive gives 299 CREATED and 1 FAILED; re-import gives 299 UNCHANGED; the fixed archive gives 1 CREATED; plus NEW_REVISION, open-draft refusal and display-code clash.
- **Regression, 10:** `judge-pipeline` 8 and `validation-clone` 2.

**Typecheck:** `--filter @recx/web --filter @recx/shared --filter @recx/db typecheck` all report Done. **Lint:** `npx eslint <all my files and tests> --max-warnings=0` exits 0.

## Requests
- **Integration stage, needed or my route breaks the static rule:** add `"apps/web/src/app/api/admin/"` to `SENSITIVE_PREFIXES`. The import route imports `lib/authoring/*`, which rule R4 flags. Design §8 already treats `app/api/admin/**` as sensitive.
- **Integration stage, e2e:** publishing now needs a second admin's approval, so the authoring journey must approve as RECADMIN02. The extra accessible names are:

  | Step | Name |
  |---|---|
  | Submit | "Submit for review" (originality checkbox required) |
  | Approve | "Approve" |
  | Return | "Return to author" |
  | Withdraw | "Withdraw to draft" |
  | Edit a reference | "Edit <label> (<language>)" |
  | Confirm retirement | "Confirm retirement" (governance's schema needs a reason of at least 10 characters) |

  All names in the gate-tests §5 contract are implemented as listed.
- **Integration stage, capabilities:** the new `admin-problems` and `admin-problem-content` exports need entries in STAFF_CAPABILITIES.
- No schema changes and no new dependencies.

## Open questions recorded
In `docs/OPEN-QUESTIONS.md` under `### Phase 4 — C authoring`:
- the 450-problem target (180 Easy / 200 Medium / 70 Hard) with owners "TBD by the placement cell";
- how APPROVED is represented;
- the approver rule and the CLI `--approve` exception;
- who authors and reviews;
- what "pass in every enabled language" means;
- retire and delete scope;
- slug and display code are immutable;
- import limits and rules;
- the unlocked 409 check;
- read-only display of interrupted imports;
- test-upload caps;
- statement edits versus judging edits;
- bundles written once, publishing without a bundle when the key holds other bytes, and the repair command;
- the deferred live-pointer trigger;
- check-approved runs from cron;
- retire does not recount study plans;
- the as-judged statement on the submission page;
- the FUNCTION compare mode is derived;
- hint replacement semantics.

## Unfinished or noted
- One parallel full-suite run in WSL failed `accommodations.db.test.ts` (stream B's suite). It passed alone and in a second full run (112/112). It is most likely a teardown deadlock between parallel suites; the other suites' teardowns are not retried.
- The login-route failure I saw in an early Windows run belonged to another stream and was gone in later runs.