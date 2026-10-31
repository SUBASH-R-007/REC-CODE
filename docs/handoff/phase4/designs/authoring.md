# Phase 4, Stream: problem authoring and content pipeline (design)

This is a read-only design. Nothing in the repo was edited. All citations are relative to `C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-CODE`.

## 0. What already exists, and the gaps that matter

**Reuse as-is:**
- Validation pipeline: `summarizeValidation` `apps/web/src/lib/judge/validation.ts:139`, `startValidation` :476, `advanceValidation` :535.
- Optimistic publish: `publishVersion` :637-712. The flip is guarded by `Problem.version` at :672-688.
- `cloneVersionAsDraft` :723-834.
- Content-addressed blobs: `ensureTestBlob` `lib/testdata/blobs.ts:87`, `readBlobBytes` :70.
- Write-once store `lib/testdata/store.ts:17`, keys `lib/testdata/keys.ts:58`.
- Guards `lib/auth/guards.ts:37,55,62`, `runAction` `lib/errors.ts:81`, `audit` `lib/audit.ts:23`, `requestIpHash` `lib/ip.ts:27`, `isSameOrigin` `lib/help/same-origin.ts:11`, `AutoRefresh` `components/admin/auto-refresh.tsx:14`, `renderMarkdown` `lib/markdown.ts:94`.

**Done-when items that are already partly covered:**
- **Concurrent publish.** Covered at library level, two drafts racing: `apps/web/test/judge-pipeline.db.test.ts:645-708`. Not yet covered: the action path, the same draft twice, and publish racing retire.
- **Frozen fences.** `packages/db/src/frozen.ts` guards every child model (:19-27). The DB triggers are in the init migration (:516-573), phase2 :153-158 and phase3 :563-568. `packages/db/test/frozen-version.test.ts` covers ProblemVersion, TestCase, StarterCode and ReferenceSolution, through both the guard and the trigger.
  - Missing:
    - Subtask, ProblemLanguageLimit (only an incidental check at judge-pipeline.db.test.ts:699), Hint and Editorial, through both fences.
    - `createManyAndReturn` and `updateManyAndReturn`.
    - Nested writes through `problem.update({ versions: { update } })`. The guard skips these because the model is "Problem"; the trigger catches them, but nothing tests it.
  - Unfenced holes:
    - **Born-frozen versions.** `problemVersion.create({ frozenAt })` is allowed (frozen.ts:95-96), and the database accepts the INSERT.
    - **`TestBlob` is mutable.** There is no trigger. Updating one blob's `inline` would rewrite a published hidden test.

**Latent bugs Phase 4 would expose (fix them in this stream):**
1. **Stale or immutable draft bundles.** Drafts get a bundle at clone time (`validation.ts:832`) and in the seed (`seed.ts:540,562`). `ensureVersionBundle` returns early whenever `bundleKey` is set (:600). So once tests become editable in the UI, a draft either publishes a stale bundle or, if rewritten, throws `ImmutableKeyError`.
2. **Validation runs are not tied to the content they judged.** `loadState` (:357-363) takes the newest run per reference solution. Editing tests or solutions after a COMPLETE round leaves the version "publishable".
3. **`publishVersion` gates are incomplete.** It does not check approval, RETIRED or the comparator, and it audits at NORMAL (:694).
4. **`zstdCompressSync` blocks the web event loop** on large test sets (`bundle.ts:79-88`).
5. **`FrozenVersionError` is not an `AppError`,** so `runAction` masks it as "Something went wrong" (`errors.ts:85-94`).
6. **`src/lib/auth/capabilities.ts` and `PrivilegedOperation` do not exist yet.** `guards.ts:61` refers to a file that isn't there; both belong to another stream (§10).

## 1. Decisions

- **Where APPROVED lives.** The spec's `ProblemStatus` enum stays unchanged (schema.prisma:45). `ProblemVersion.status` carries the version lifecycle DRAFT → IN_REVIEW → PUBLISHED (frozen).
  - **APPROVED** = `status = IN_REVIEW AND approvedAt IS NOT NULL`. The approval columns freeze with the version on publish, so they record who approved what students see.
  - **RETIRED** exists only on `Problem.status`, because a frozen version cannot be written.
  - **SUPERSEDED** (a frozen version that is no longer live) is derived.
  - One pure function, `reviewStageOf()`, maps all of this to `DRAFT | IN_REVIEW | APPROVED | PUBLISHED | SUPERSEDED | RETIRED`.
  - The spec's "ProblemDraft" is a ProblemVersion with `frozenAt IS NULL`. There is no separate table.
- **Edits only in DRAFT,** through one chokepoint, `touchDraft()`, which uses optimistic concurrency on a new `editSeq` column. To edit something under review, the author withdraws it to DRAFT, which clears any approval.
- **Validation is tied to content.** A new `judgeSeq` column is bumped only by edits that change judging. `ValidationRun.judgeSeq` snapshots it, and only runs whose seq matches the current one count. Statement-only edits do not invalidate validation.
- **Approval gate.** The approver must not be the creator, the last editor or the submitter. Validation must be publishable (COMPLETE, no blockers) and `versionContentIssues` must contain no errors.
- **Publish gate.** All of: APPROVED, problem not RETIRED, no content-issue errors, validation publishable, and the optimistic flip of `Problem.version`.
- **Bundles are written once, after the freeze.** The bundle is computed before the transaction, its keys and sha are set in the same UPDATE that freezes the version, and the store `put` runs after commit. Drafts never write bundles, and a test-set fingerprint check catches a race. If the put fails, a repair command (`ensurePublishedBundle`) recomputes the deterministic bytes.
- **One open draft per problem** in the UI and import, enforced under `pg_advisory_xact_lock(hashtext('problem:'||id))`. The library still allows more, which the existing tests rely on.
- **Delete scope.**
  - "Delete a version" means a never-published (unfrozen) revision with no Submission or RunRequest. Frozen versions are never deleted; retire instead.
  - "Delete a problem" means a never-published problem with no references.
  - Both are SUPER_ADMIN only and need an approved `PrivilegedOperation`.
- **Import transport.**
  - The UI takes a zip, sent as a raw `application/zip` body to a route handler. A server action is not used because its 1 MB default would have to be raised globally.
  - The body is streamed to a private spool file with a byte cap and sha256, then processed in `after()`. Each problem directory is read into memory one at a time and is never unpacked to disk.
  - Each row is its own transaction, and a `ProblemImportRow` is written after every entry.
  - Re-uploading the same archive is always safe (rows already imported come back UNCHANGED), so "resume" just means re-upload.
  - The CLI imports a directory or a zip through the same library.

## 2. Prisma changes (`packages/db/prisma/schema.prisma`)

Put these in a new section, "── Problem authoring (Phase 4) ──". Use plain-string actor ids, with no new `User` back-relations, to keep away from other streams' edits to User.

```prisma
/// Where a revision's content came from. Mirror of CONTENT_ORIGINS in @recx/shared/authoring.
enum ContentOrigin {
  FACULTY
  SENIOR_STUDENT
  AI_ASSISTED
}

enum ProblemReviewAction {
  SUBMITTED
  WITHDRAWN
  RETURNED
  APPROVED
  APPROVAL_REVOKED
}

enum ProblemImportStatus {
  PROCESSING
  DONE
  FAILED
}

enum ProblemImportRowStatus {
  CREATED
  NEW_REVISION
  UNCHANGED
  FAILED
}
```

Add to `model ProblemVersion` (schema.prisma:390-435):

```prisma
  origin               ContentOrigin   @default(FACULTY)
  /// Optimistic concurrency for draft edits; every content edit increments it.
  editSeq              Int             @default(0)
  /// Incremented by edits that change judging (tests, subtasks, reference
  /// solutions, limits, io/compare/scoring, signature, checker). ValidationRun
  /// records it; runs of an older seq no longer count.
  judgeSeq             Int             @default(0)
  lastEditedById       String?
  updatedAt            DateTime        @default(now()) @updatedAt
  submittedForReviewAt DateTime?
  submittedById        String?
  /// APPROVED = status IN_REVIEW with approvedAt set. Frozen with the version on publish.
  approvedAt           DateTime?
  approvedById         String?
  /// sha256 of the canonical import package this revision was created from (import idempotency).
  importSha256         String?
  reviews              ProblemReview[]
```

Add to `model ValidationRun` (:1019): `judgeSeq Int @default(0)`.

New models:

```prisma
/// Review history of a draft revision. Not version content, so it is never frozen.
model ProblemReview {
  id               String              @id @default(cuid())
  problemVersionId String
  problemVersion   ProblemVersion      @relation(fields: [problemVersionId], references: [id], onDelete: Cascade)
  action           ProblemReviewAction
  actorId          String?
  comment          String?             @db.Text
  /// SUBMITTED only: the submitter attested the content is originally authored.
  attestedOriginal Boolean             @default(false)
  createdAt        DateTime            @default(now())

  @@index([problemVersionId, createdAt])
}

model ProblemImport {
  id            String              @id @default(cuid())
  uploadedById  String
  fileName      String
  sizeBytes     BigInt
  archiveSha256 String
  /// "upload" | "cli:<operator>"
  via           String
  status        ProblemImportStatus @default(PROCESSING)
  total         Int                 @default(0)
  created       Int                 @default(0)
  revised       Int                 @default(0)
  unchanged     Int                 @default(0)
  failed        Int                 @default(0)
  /// Whole-archive failure (not a zip, over a cap, interrupted). Per-entry failures live on rows.
  error         String?
  startedAt     DateTime            @default(now())
  finishedAt    DateTime?
  rows          ProblemImportRow[]

  @@index([uploadedById, startedAt(sort: Desc)])
}

/// One problem directory of an import. Written as soon as that entry commits or fails.
model ProblemImportRow {
  id               String                 @id @default(cuid())
  importId         String
  import           ProblemImport          @relation(fields: [importId], references: [id], onDelete: Cascade)
  entry            String
  slug             String?
  status           ProblemImportRowStatus
  problemId        String?
  problemVersionId String?
  revision         Int?
  packageSha256    String?
  /// [{path, message}] — every problem found in the entry, not only the first.
  errors           Json                   @default("[]")
  warnings         Json                   @default("[]")
  createdAt        DateTime               @default(now())

  @@unique([importId, entry])
}
```

The **migration** `packages/db/prisma/migrations/2026101100xxxx_phase4_problem_authoring/migration.sql` is generated SQL plus this hand-written part:

```sql
ALTER TABLE "ProblemVersion" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP; -- fast default, no row rewrite, no trigger fired
ALTER TABLE "ProblemVersion" ADD CONSTRAINT "ProblemVersion_approval_state"
  CHECK ("approvedAt" IS NULL OR "status" IN ('IN_REVIEW','PUBLISHED'));

-- Publish is the only way a version becomes frozen: never INSERT a frozen row.
CREATE OR REPLACE FUNCTION recx_refuse_born_frozen_version() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ProblemVersion % cannot be created frozen; publish freezes it', NEW."id" USING ERRCODE = 'check_violation';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "ProblemVersion_born_frozen_guard" BEFORE INSERT ON "public"."ProblemVersion"
  FOR EACH ROW WHEN (NEW."frozenAt" IS NOT NULL) EXECUTE FUNCTION recx_refuse_born_frozen_version();

-- Blob bytes are pinned by sha256: content columns never change (a no-op ON CONFLICT update is allowed).
CREATE OR REPLACE FUNCTION recx_refuse_test_blob_change() RETURNS trigger AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."sizeBytes" IS DISTINCT FROM OLD."sizeBytes"
     OR NEW."inline" IS DISTINCT FROM OLD."inline" OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey" THEN
    RAISE EXCEPTION 'TestBlob % is immutable', OLD."sha256" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "TestBlob_immutable" BEFORE UPDATE ON "public"."TestBlob"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_test_blob_change();
```

Index policy: only the FK and unique indexes above, because these are small admin tables. No index is added to ProblemVersion; the review queue scans at most ~3,600 rows.

A "live pointer must be a frozen version of the same problem" trigger is **deliberately not added**. Phase 3 fixtures point `liveVersionId` at unfrozen versions (`apps/web/test/drafts-server.db.test.ts:105`, help/notes/plans/shell/seed-plans db tests, `apps/scheduler/test/daily-challenge.db.test.ts`). It goes on the open-questions list.

`packages/db/src/frozen.ts:94-97`: a ProblemVersion `create`, `createMany` or `createManyAndReturn` whose data has `frozenAt != null` now throws `FrozenVersionError("A revision is frozen by publishing it, never created frozen.")`.

## 3. Shared contracts: `packages/shared/src/authoring/` (new subpath)

Add `"./authoring": "./src/authoring/index.ts"` to `packages/shared/package.json` exports. `src/index.ts` is **not** touched, which avoids conflicts with other streams. Everything here is pure: no I/O and no crypto.

```ts
// authoring/index.ts re-exports:
export const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const PROBLEM_STATUSES = ["DRAFT", "IN_REVIEW", "PUBLISHED", "RETIRED"] as const;
export const CONTENT_ORIGINS = ["FACULTY", "SENIOR_STUDENT", "AI_ASSISTED"] as const;
export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];

// review.ts
export const REVIEW_STAGES = ["DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED", "SUPERSEDED", "RETIRED"] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];
export const REVIEW_ACTIONS = ["SUBMIT", "WITHDRAW", "RETURN", "APPROVE", "REVOKE", "PUBLISH", "RETIRE"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
export function reviewStageOf(
  v: { id: string; status: (typeof PROBLEM_STATUSES)[number]; approvedAt: Date | string | null; frozenAt: Date | string | null },
  p: { status: (typeof PROBLEM_STATUSES)[number]; liveVersionId: string | null },
): ReviewStage;
export function planReviewTransition(stage: ReviewStage, action: ReviewAction):
  | { ok: true; next: ReviewStage } | { ok: false; reason: string };
// SUBMIT DRAFT→IN_REVIEW; WITHDRAW/RETURN IN_REVIEW|APPROVED→DRAFT; APPROVE IN_REVIEW→APPROVED;
// REVOKE APPROVED→IN_REVIEW; PUBLISH APPROVED→PUBLISHED; RETIRE PUBLISHED→RETIRED.

// content.ts — the "declared comparator" and structural publish rules
export const AUTHORABLE_COMPARE_MODES = ["EXACT", "TOKEN", "FLOAT", "CHECKER"] as const; // INTERACTIVE is deferred
/** Comparators this judge fleet applies. The FUNCTION-harness stream extends this; parity-tested against the worker. */
export const JUDGEABLE_FUNCTION_COMPARATORS: readonly FunctionComparator[] = ["EXACT", "IN_PLACE_MUTATION", "FLOAT_TOLERANCE", "CUSTOM_CHECKER"];
export const REFERENCE_EXPECTED_VERDICTS = ["AC", "WA", "TLE", "MLE", "RE"] as const;
export const CPP_MODEL_LANGUAGES = ["cpp17", "cpp20"] as const; // validation.ts:43 imports this instead of its own copy
export type ContentIssueCode =
  | "COMPARATOR_MISSING" | "COMPARATOR_NOT_JUDGEABLE" | "SIGNATURE_INVALID" | "SIGNATURE_ON_STDIN"
  | "CHECKER_MISSING" | "CHECKER_UNUSED" | "LIMIT_OUT_OF_RANGE" | "NO_SAMPLE" | "NO_HIDDEN_TEST"
  | "SAMPLE_NOT_INLINE" | "TEST_INDEX_GAP" | "SUBTASK_TABLE" | "STATEMENT_EMPTY" | "NO_CPP_MODEL";
export interface ContentIssue { code: ContentIssueCode; severity: "error" | "warning"; message: string }
export interface VersionContentInput {
  ioMode: IoMode; compareMode: CompareMode; floatEpsilon: number | null; functionSignature: unknown;
  checkerSha256: string | null; testlibId: string | null; scoringMode: ScoringMode;
  timeLimitMs: number; memoryLimitKb: number; statementMd: string;
  tests: Array<{ index: number; isSample: boolean; subtaskIndex: number | null; points: number | null; inputBytes: number; outputBytes: number; sampleInlineable: boolean }>;
  subtasks: Array<{ index: number; points: number; dependsOn: number[] }>;
  references: Array<{ language: string; expectedVerdict: Verdict }>;
}
export function versionContentIssues(v: VersionContentInput): ContentIssue[];
// Errors: STDIN compareMode ∉ AUTHORABLE; FUNCTION without a parsing signature (functionSignatureSchema)
// or with comparator ∉ JUDGEABLE; CHECKER/CUSTOM_CHECKER without checkerSha256+testlibId;
// TL ∉ [LIMITS.cpuTime.floorMs, ceilingMs]; memory > LIMITS.memory.ceilingKb (the "no >15 s / >1 GB" rule);
// no sample; no hidden test; a sample over LIMITS.inlineBlobBytes or not UTF-8 (the workspace shows only
// inline samples, problems.ts:333-337); index gaps; SUBTASK table inconsistent; empty statement.
// Warning (an error at publish via validation): NO_CPP_MODEL.

// package.ts — bulk-import format 1
export const PROBLEM_PACKAGE_FORMAT = 1;
export const PACKAGE_FILES = { meta: "meta.json", statement: "statement.md", editorial: "editorial.md",
  checker: "checker.cpp", testsDir: "testcases", solutionsDir: "solutions", startersDir: "starters", hintsDir: "hints" } as const;
export const TEST_FILE_PATTERN = /^testcases\/(\d{3})\.(in|out)$/;       // contiguous from 000
export const IMPORT_LIMITS = deepFreeze({
  archiveBytes: 256 * 1024 * 1024, entries: 500, archiveFiles: 50_000, filesPerEntry: 2_100,
  fileBytes: 64 * 1024 * 1024, entryBytes: 512 * 1024 * 1024, totalUncompressedBytes: 4 * 1024 ** 3,
  tests: 1_000, statementBytes: 64 * 1024, editorialBytes: 64 * 1024, hintBytes: 8 * 1024,
  checkerBytes: 256 * 1024, pathChars: 200,
});
export const problemSlugSchema: z.ZodString;      // /^[a-z0-9]+(?:-[a-z0-9]+)*$/, ≤100 (same rule as submit-schema.ts:29)
export const displayCodeSchema: z.ZodString;      // /^REC-\d{4}$/
export const packagePathSchema: z.ZodString;      // relative, "/"-separated, no "..", no leading "/", no "\\", no NUL
export const problemPackageMetaSchema: z.ZodType<ProblemPackageMeta>;  // .strict()
export type ProblemPackageMeta = {
  format: 1; slug: string; displayCode: string; title: string; difficulty: Difficulty;
  topics: Topic[];                 // 1..4, primary first
  origin: ContentOrigin; constraints: string[];
  ioMode: IoMode; functionSignature: FunctionSignature | null;
  compareMode: (typeof AUTHORABLE_COMPARE_MODES)[number];   // REQUIRED, no default: the declared comparator
  floatEpsilon: number | null; scoringMode: ScoringMode; stopOnFirstFailure: boolean;
  timeLimitMs: number; memoryLimitKb: number;
  samples: number[];               // test indexes
  points?: Record<string, number>; // PER_TEST
  subtasks: Array<{ index: number; points: number; aggregation: SubtaskAggregation; dependsOn: number[]; tests: number[] }>;
  solutions: Array<{ file: string; language: LanguageKey; expected: (typeof REFERENCE_EXPECTED_VERDICTS)[number]; label: string }>;
  starters: Partial<Record<LanguageKey, string>>;
  checker: string | null;
};
// superRefine: FUNCTION ⇔ signature; CHECKER or CUSTOM_CHECKER ⇔ checker; SUBTASK ⇔ subtasks covering every test once,
// with dependsOn only on lower indexes.
```

Add `CONTENT_ORIGINS` to `packages/db/test/enum-parity.test.ts`.

## 4. Web library (`apps/web/src/lib/authoring/`, all `import "server-only"`)

**`draft.ts`** is the single edit chokepoint:
```ts
export type EditKind = "content" | "judging";
export interface DraftHead { versionId: string; problemId: string; revision: number; editSeq: number; judgeSeq: number }
export function lockProblem(tx: DbTx, problemId: string): Promise<unknown>; // pg_advisory_xact_lock(hashtext('problem:'||id))
export async function touchDraft(tx: DbTx, i: { versionId: string; expectedEditSeq: number; actorId: string; kind: EditKind }): Promise<DraftHead>;
//  lockVersion(tx, id) (validation.ts:282, now exported) → updateMany where {id, frozenAt:null, status:"DRAFT", editSeq:expected}
//  data {editSeq:+1, lastEditedById, ...(judging ? {judgeSeq:+1, bundleKey:null, manifestSha256:null} : {})}.
//  count 0 → NotFoundError | ConflictError("published and frozen — start a new revision")
//           | ConflictError("in review — withdraw it to edit") | ConflictError("changed by someone else — reload").
//  judging → cancel QUEUED/JUDGING ValidationRuns of the version (same update as validation.ts:488-491).
export function rethrowFrozen(e: unknown): never; // FrozenVersionError → ConflictError
```

**`review.ts`.** Each function runs `lockVersion`, then an `updateMany` guarded on the current state (0 rows → ConflictError), then writes a `ProblemReview` row, then calls `audit`.
```ts
export async function submitVersionForReview(i: { versionId: string; expectedEditSeq: number; actorId: string; attestedOriginal: true }): Promise<void>;
//   needs no error-severity content issues; sets submittedForReviewAt/By; Problem.status DRAFT→IN_REVIEW if never published.
export async function withdrawVersion(i: { versionId: string; actorId: string }): Promise<void>;            // clears approval and submission
export async function returnVersion(i: { versionId: string; actorId: string; comment: string }): Promise<void>;
export async function approveVersion(i: { versionId: string; actorId: string | null; via: string; comment?: string }): Promise<void>;
//   actor ∉ {createdById, submittedById, lastEditedById} (except CLI operator approval with actorId null);
//   getValidationStatusTx(tx).publishable && no content errors.
export async function revokeApproval(i: { versionId: string; reason: string; via: string }): Promise<void>; // APPROVED→IN_REVIEW
```

**`readiness.ts`:**
```ts
export async function loadVersionContentInput(client: Db | DbTx, versionId: string): Promise<VersionContentInput>;
export interface PublishReadiness { stage: ReviewStage; approved: boolean; contentIssues: ContentIssue[];
  validation: ValidationStatus; problemVersion: number; publishable: boolean; blockers: string[] }
export async function getPublishReadiness(versionId: string): Promise<PublishReadiness>;
```

**`lifecycle.ts`:**
```ts
export async function createProblemWithDraft(i: CreateProblemInput, actorId: string): Promise<{ problemId: string; versionId: string }>;
export async function startRevision(problemId: string, actorId: string): Promise<{ versionId: string; revision: number; existing: boolean }>;
//   returns the existing open draft if there is one; refuses RETIRED; otherwise cloneVersionAsDraft(live, {refuseIfDraftExists:true}).
export async function retireProblem(i: { problemId: string; expectedProblemVersion: number; reason: string }, actorId: string): Promise<void>;
//   updateMany where {id, status:"PUBLISHED", version:expected} → {status:"RETIRED", version:+1}; 0 → ConflictError.
export async function deleteDraftVersion(tx: DbTx, versionId: string): Promise<{ problemId: string; revision: number }>;
//   unfrozen, 0 Submission/RunRequest, not the problem's only version; deletes ValidationRun, children, ProblemReview (cascade), version.
export async function deleteUnpublishedProblem(tx: DbTx, problemId: string): Promise<{ slug: string; versions: number }>;
//   liveVersionId null, no frozen version, no Submission/RunRequest/CodeDraft/Bookmark/Note/StudyPlanItem/DailyChallenge
//   rows → refuses and lists them otherwise; deletes tags, ProblemStat, versions, problem.
```

**`tests.ts`:**
```ts
export async function addDraftTests(i: { versionId: string; expectedEditSeq: number; actorId: string;
  tests: Array<{ input: Buffer; output: Buffer; isSample: boolean; subtaskIndex: number | null; points: number | null }> }): Promise<{ indexes: number[] }>;
//   ensureTestBlob (blobs.ts:87) runs before the tx; the rows are appended inside touchDraft(kind:"judging").
export async function updateDraftTest(i: { versionId: string; expectedEditSeq: number; actorId: string; index: number; isSample: boolean; subtaskIndex: number | null; points: number | null }): Promise<void>;
export async function removeDraftTests(i: { versionId: string; expectedEditSeq: number; actorId: string; indexes: number[] }): Promise<void>; // renumbers 0..n-1 via an offset pass
export async function setDraftSubtasks(i: { versionId: string; expectedEditSeq: number; actorId: string; subtasks: SubtaskInput[] }): Promise<void>;
export function testSetFingerprint(rows: ReadonlyArray<{ index: number; isSample: boolean; subtaskIndex: number | null; points: number | null; inputSha256: string; outputSha256: string }>): string;
```

**`schemas.ts`:** the zod input schemas for every action below, built on the shared field schemas.

**`import/`** (yauzl, pure JS; apps/web may not use child_process):
```ts
// import/spool.ts
export async function spoolRequestBody(req: Request, o: { maxBytes: number; dir: string }): Promise<{ path: string; sizeBytes: number; sha256: string }>;
//   writes with flag "wx", mode 0o600; counts while streaming → AppError 413; content-length pre-check.
// import/archive.ts
export interface ProblemArchive { entries: string[]; read(entry: string): Promise<PackageFiles>; close(): Promise<void> }
export class ArchiveError extends AppError {}
export async function openZipArchive(path: string): Promise<ProblemArchive>;
//   yauzl.open(lazyEntries, validateEntrySizes, strictFileNames); refuses symlink entries (external attrs S_IFLNK),
//   absolute paths, "..", backslashes, NUL, case-folded duplicates; enforces IMPORT_LIMITS on declared AND actually
//   inflated bytes; unwraps one wrapping folder; groups by top-level directory.
export async function openDirectoryArchive(root: string): Promise<ProblemArchive>; // CLI only: lstat, refuses symlinks
// import/package.ts
export type PackageFiles = ReadonlyMap<string, Buffer>;
export interface PackageIssue { path: string; message: string }
export type ParsedPackage =
  | { ok: true; pkg: ProblemPackage; packageSha256: string; warnings: PackageIssue[] }
  | { ok: false; errors: PackageIssue[]; warnings: PackageIssue[] };
export function parseProblemPackage(entry: string, files: PackageFiles): ParsedPackage; // collects ALL issues
//   packageSha256 = sha256(canonical JSON {meta (sorted keys), files: [[path, sha256]...] sorted}) — zip metadata excluded.
// import/run.ts
export async function runProblemImport(importId: string, archive: ProblemArchive, actorId: string): Promise<void>;
export async function importOnePackage(entry: string, files: PackageFiles, ctx: { importId: string; actorId: string }): Promise<ImportRowResult>;
```

Per-row rule, decided under `lockProblem(slug)`:

| Slug state | Result |
|---|---|
| Unknown | **CREATED**: Problem DRAFT, r1 DRAFT, ProblemTag rows |
| Open draft with the same `importSha256` | **UNCHANGED** |
| Open draft with other content | **FAILED** "revision rN is an open draft; finish or delete it first" |
| No draft, live `importSha256` equal | **UNCHANGED** |
| No draft, live content differs | **NEW_REVISION**: r(max+1) DRAFT from the package. Differing topics only produce a warning. |
| RETIRED, or `displayCode` mismatched or taken | **FAILED** |

How a row is processed:
- Blobs go in first, outside the transaction, with `ensureTestBlob`. They are content-addressed, so this is idempotent. The checker is a TestBlob too, with `testlibId = TESTLIB_ID`. **No bundle is written.**
- Each row has its own try/catch. A failure writes a FAILED row (unexpected errors get a reference id) and the loop continues. That is the "one bad entry cannot discard 300" property.
- The ProblemImport counters use `{increment: 1}`. The import is marked DONE at the end, the spool file is unlinked in `finally`, and a PROCESSING import older than 30 minutes is marked FAILED ("interrupted — re-upload").
- A missing C++ model is only a warning at import. Publish blocks it.

**Changes to existing web code:**
- **`lib/judge/validation.ts`:**
  - Export `lockVersion` (:282) and add `getValidationStatusTx(tx, versionId)`.
  - `loadState` (:339) selects `judgeSeq`, `status` and `approvedAt`, and filters runs with `{ problemVersionId, judgeSeq }`. `startValidation` and `advanceValidation` stamp `judgeSeq` on the runs they create (:494, :549).
  - `publishVersion(versionId, { actorId, via, expectedProblemVersion?, requireApproval = true })` gets, inside the transaction: RETIRED → BLOCKED; not APPROVED → BLOCKED; content-issue errors → BLOCKED; the bundle produced by `prepareVersionBundle` is checked against `testSetFingerprint` (mismatch → CONFLICT); `bundleKey` and `manifestSha256` are set in the freeze UPDATE (:667). After commit it calls `putPreparedBundle`; a failure there is logged and audited as `problem.bundle.write_failed`. The audit level becomes `sensitivity: "SENSITIVE"`.
  - `ensureVersionBundle` becomes `ensurePublishedBundle(versionId)`, which handles frozen versions only, recomputes and puts, and is used for repair.
  - `cloneVersionAsDraft` copies `origin`; does not copy approval, submission or `importSha256`; accepts `refuseIfDraftExists` under `lockProblem`; and **removes the call at :832**.
- **`lib/testdata/bundle.ts`:** split `writeBundle` (:125) into `prepareBundle(input): Promise<PreparedBundle>`, which uses async `zlib.zstdCompress` on the libuv pool instead of the sync call at :85, and `putBundle(prepared, store)`. `writeBundle` stays as the composition of the two.
- **`lib/errors.ts`:** add `ConflictError extends AppError` with status 409.
- **`lib/env.ts`:** add `IMPORT_SPOOL_DIR: z.string().optional()`, defaulting to `os.tmpdir()/recx-imports`.
- **`server/queries/submissions.ts:124-150`:** `getSubmissionDetail` also returns `pinned: { revision, statementHtml }` (the pinned version's `statementMd` through `renderMarkdown`) and `liveRevision`. The page at `app/(student)/problems/[slug]/submissions/[id]/page.tsx` renders "Judged against revision N" plus a `<details>` titled "Problem as judged". This is how an older submission keeps showing the version it was judged against after a statement edit.
- **`scripts/seed.ts`:** `seedAuthoredProblem` stops writing draft bundles (:540, :562). Two-sum r1's published path (:361, :434) is unchanged.
- **`apps/web/package.json`:** add `yauzl@3.2.0` and `@types/yauzl@2.10.3`. **`next.config.ts`:** add `"yauzl"` to `serverExternalPackages`.

## 5. Server actions (`"use server"`, `runAction`, guard first, zod, `audit` with `requestIpHash`)

**`apps/web/src/server/actions/admin-problems.ts`.** ADMIN covers ADMIN and SUPER_ADMIN, via `requireActionRole("ADMIN","SUPER_ADMIN")`. SUPER means `requireSuperAdmin()`.

| Export | Role | Audit action / sensitivity |
|---|---|---|
| `createProblem` | ADMIN | `problem.created` / NORMAL |
| `startRevision` ("Edit problem") | ADMIN | `problem.revision.created` / NORMAL (inside clone) |
| `setProblemTopics` | ADMIN | `problem.topics.changed` / NORMAL |
| `submitForReview` (`attestOriginal: z.literal(true)`) | ADMIN | `problem.review.submitted` / NORMAL |
| `withdrawFromReview` | ADMIN | `problem.review.withdrawn` / NORMAL |
| `returnToDraft` (comment ≥ 5 chars) | ADMIN | `problem.review.returned` / NORMAL |
| `approveVersion` | ADMIN | `problem.review.approved` / **SENSITIVE** |
| `startProblemValidation` | ADMIN | `problem.validation.started` / NORMAL (in lib) |
| `refreshValidation` (advance + redispatch) | ADMIN | none (idempotent) |
| `publishProblemVersion({versionId, expectedProblemVersion})` | ADMIN | `problem.published` / **SENSITIVE** |
| `validateImportedDrafts({importId})` | ADMIN | `problem.validation.started` per version |
| `previewStatement({markdown})` | ADMIN | none |
| `retireProblem({problemId, expectedProblemVersion, reason})` | **SUPER** | `problem.retired` / **SENSITIVE** |
| `requestProblemDeletion({target:"VERSION"\|"PROBLEM", id, reason})` | **SUPER** | via `requestPrivilegedOperation` / SENSITIVE |
| `deleteProblemVersion({versionId, operationId})` | **SUPER** + PrivilegedOperation | `problem.version.deleted` / **SECURITY** |
| `deleteProblem({problemId, operationId})` | **SUPER** + PrivilegedOperation | `problem.deleted` / **SECURITY** |

How results map to errors:
- A `publishProblemVersion` CONFLICT result becomes `ConflictError` ("changed concurrently — reload").
- BLOCKED becomes `ValidationError("Publishing is blocked: <first blocker> (+N more — see the validation report)")`.

**`apps/web/src/server/actions/admin-problem-content.ts`.** All ADMIN; all take `expectedEditSeq`; all go through `touchDraft`; all audit `problem.draft.edited` at NORMAL with `{versionId, section, editSeq}`. Only `addDraftTests` takes FormData, capped at ≤ 1 MB by the Next server-action default.

| Export | Edit kind |
|---|---|
| `updateDraftDetails` (title, difficulty, statementMd, constraints, origin) | content |
| `updateDraftJudging` (ioMode, functionSignature, compareMode, floatEpsilon, scoringMode, stopOnFirstFailure, timeLimitMs, memoryLimitKb) | judging |
| `setDraftChecker` (source or null) | judging |
| `addDraftTests` | judging |
| `updateDraftTest` | judging |
| `removeDraftTests` | judging |
| `setDraftSubtasks` | judging |
| `upsertReferenceSolution` (language, label, expectedVerdict ∈ REFERENCE_EXPECTED_VERDICTS, source ≤ `LIMITS.source.defaultBytes`) | judging |
| `removeReferenceSolution` (deletes its draft ValidationRuns first; FK is restrict) | judging |
| `upsertStarterCode` | content |
| `removeStarterCode` | content |
| `setDraftHelp` (hints[1..3], editorialMd) | content |

**Route handler** `apps/web/src/app/api/admin/problems/import/route.ts`. It uses `runtime="nodejs"` and `dynamic="force-dynamic"`. `POST` runs these checks in order:
1. `isSameOrigin`, else 403.
2. `requireActionRole("ADMIN","SUPER_ADMIN")`.
3. `content-type: application/zip`, else 415.
4. `content-length` > `IMPORT_LIMITS.archiveBytes`, else 413.
5. An active PROCESSING import by this user, else 409.

It then calls `spoolRequestBody`, creates the `ProblemImport` row, and audits `problem.import.started` at NORMAL. Next comes `after(() => runProblemImport(...))`, which audits `problem.import.completed` at NORMAL with counters and up to 500 version ids. It responds `202 {importId}`. The file name arrives in `x-recx-file-name`, URI-encoded, ≤ 200 characters.

## 6. Pages (each calls `requirePageRole("ADMIN","SUPER_ADMIN")` itself as well as `admin/layout.tsx:9`)

- **`app/admin/problems/page.tsx`** (+ `loading.tsx`): the list and review queue. Filters: `?stage=` (any `REVIEW_STAGES` value), `q` (trigram on `Problem.title`), difficulty. Page size 50. Shows queue counts and links to `/new` and `/import`.
- **`app/admin/problems/new/page.tsx`:** create form: slug, displayCode (suggested), title, difficulty, ioMode, an explicit compareMode select, origin.
- **`app/admin/problems/[id]/page.tsx`:**
  - Revisions with a `StageBadge` (icon + text, never colour alone) and review history with comments.
  - The editable open draft, in sections: Details, Statement (with preview), Judging (structured signature editor), Reference solutions, Starter code, Hints & editorial, Topics. Editors are plain monospace `Textarea` (`size-budgets.json` keeps `/admin/` free of Monaco).
  - Lifecycle buttons. Retire and Request deletion are rendered only for SUPER_ADMIN; the actions guard regardless.
  - `?rev=N` shows any revision read-only.
- **`app/admin/problems/[id]/testcases/page.tsx`:** test table (index, sample, subtask, points, sizes, sha prefix, first 1 KiB preview via `store.stream`, staff only), upload form, subtask editor.
- **`app/admin/problems/[id]/validate/page.tsx`:** the clear report.
  - Blockers from `getPublishReadiness`.
  - A per-reference-solution table: expected vs actual verdict, MATCHED/MISMATCHED, measured ms, the first failing test index, a per-test verdict strip from `ValidationRun.testResults`, compile output.
  - Derived `ProblemLanguageLimit` rows, content issues, approval state.
  - A Publish button that carries a hidden `expectedProblemVersion`.
  - `AutoRefresh` while runs are pending.
- **`app/admin/problems/import/page.tsx`:** client `import-form.tsx` does `fetch` POST, then `router.push`.
- **`app/admin/problems/import/[importId]/page.tsx`:** counters and the per-row table (failed rows first, errors with file paths). `AutoRefresh` while processing. A "Validate imported drafts" button.
- **`server/queries/admin-problems.ts`** (server-only; every function starts with `assertStaffViewer(viewer)`): `listAdminProblems`, `getAdminProblem`, `getDraftTests`, `getValidationReport`, `getImport`, `listMyImports`.
- **Client leaf components** go under `components/admin/problems/*`.
- **`components/admin/admin-shell.tsx:14`:** add `{ href: "/admin/problems", label: "Problems" }`.

## 7. CLI scripts (`apps/web/scripts`, `--conditions=react-server`, audited as `via: "cli:<operator>"`)

- **`import-problems.ts <dir|zip> --as <collegeId>`:** uses the same `runProblemImport` with `openDirectoryArchive` or `openZipArchive`.
- **`validate-and-publish.ts`:** add `--approve`, an operator approval recorded with `approvedById` null. Without it, publishing an unapproved draft is blocked with the message. Extract the poll loop (:147-169) into `waitForValidation(versionId, {timeoutMs, onPhase})` in `lib/authoring/validation-wait.ts`.
- **`check-approved.ts [--revoke] [--timeout-min=N]`:** the CI-style enforcement for APPROVED versions stored in the database. For every APPROVED version it re-runs or advances validation until COMPLETE, then exits 1 listing every version whose reference solutions do not all match in every enabled language. `--revoke` calls `revokeApproval` (`problem.review.approval_revoked`). Run it after any toolchain or language change (RUNBOOK).

## 8. Tests that prove the Done-when items

**"A frozen ProblemVersion and its children reject writes."** Extend `packages/db/test/frozen-version.test.ts`:
- Subtask, ProblemLanguageLimit, Hint and Editorial: create, update and delete refused under a frozen version, through both the guard and raw SQL. Extend the `GUARDED` teardown list (:41-46) with those four triggers.
- `createManyAndReturn` and `updateManyAndReturn` refused.
- A nested `problem.update({ data: { versions: { update: { where: {id: v1}, data: {title} } } } })` refused by the trigger.
- A born-frozen `problemVersion.create({ frozenAt })` refused by the guard (FrozenVersionError) and by raw INSERT (trigger).
- A `TestBlob` content UPDATE refused, and a no-op upsert of an existing sha accepted.
- New columns (`approvedAt`, `editSeq`) are immutable after the freeze.

**"Two concurrent Problem publishes produce one success and one conflict."** New `apps/web/test/problem-publish-concurrency.db.test.ts`, run 10 times each, with fake judge results posted through `finalizeValidation`, as judge-pipeline.db.test does:
- (a) The same approved draft, published by two admins concurrently through the **action**. Guards are mocked per call through AsyncLocalStorage. Expect one `{ok:true}` and one ConflictError.
- (b) Two approved drafts of one problem through the library. Expect one ok, one CONFLICT, the loser still unfrozen, `Problem.version` = v+1, and exactly one `problem.published` audit row.
- (c) Publish racing `retireProblem` with the same `expectedProblemVersion`. Expect exactly one to win.
- (d) A stale `expectedProblemVersion` gives a conflict.
- The existing test at judge-pipeline.db.test.ts:645 gains `requireApproval: false`.

**"No STUDENT-reachable route can return a non-sample test file or a ReferenceSolution.source."** Three layers:
1. **Static fence: `tests/repo/content-leak.test.ts`** (every push, Windows and Linux; new helper `tests/repo/support/module-graph.ts` that resolves `@/` and relative imports and skips `import type`).
   - Sensitive reads in `apps/web/src`, scanned over `lexSource` code:
     - the identifiers `referenceSolution(s)`, `testBlob`, `readBlobBytes(`, `getTestDataStore(`;
     - any `testCase(s)` query object (balanced braces) selecting `input`/`output` without `isSample: true`;
     - raw-SQL literals naming `"ReferenceSolution"`, `"TestBlob"`, `"inline"` or `"storageKey"`.
   - Every hit must be in `SENSITIVE_MODULES`, an allowlist with reasons: `lib/judge/{claim,validation,finalize}.ts`, `lib/testdata/**`, `lib/authoring/**`, `server/queries/admin-problems.ts`, `server/actions/admin-problem*.ts`, `app/api/judge/blob/**`, `app/api/admin/**`.
   - **Student entries** = every `page|layout|route|loading|error|not-found|template|default` under `src/app`, except `admin/**`, `super/**`, `api/judge/**` and `api/admin/**`, plus `middleware.ts`. Their transitive closure must contain no sensitive module. Today it holds: validation.ts is reached only via finalize, which is reached only from `api/judge/*`.
   - Every `"use server"` file whose closure reaches a sensitive module must call `requireActionRole("ADMIN","SUPER_ADMIN")` or `requireSuperAdmin()` as the first statement inside the `runAction` callback of **every** export.
   - Every `route.ts` under `api/admin/**` calls a staff guard before reading the body.
   - Every sensitive module begins with `import "server-only"`, except `lib/testdata/{blobs,keys,tar,bundle}`, which the seed imports.
   - Self-tests use flagged and clean snippets, as in xp-ledger.test.ts.
2. **Runtime probe: `apps/web/test/content-leak.db.test.ts`** (RECX_DB_TESTS=1).
   - Fixture:
     - A published problem with hidden tests holding the canaries `LEAK-IN-${tag}` and `LEAK-OUT-${tag}`. One hidden test is over 64 KB and lives in the fake store.
     - Reference sources containing `LEAK-REF-${tag}` (AC and WA), and a checker containing `LEAK-CHK-${tag}`.
     - An open draft whose statement contains `LEAK-DRAFT-${tag}`.
     - A student with a submission, a sample run and a custom run.
   - `getCurrentUser` is mocked to return the student.
   - `ROUTE_PROBES` must equal the set of student `route.ts` files enumerated from the filesystem, so a new route fails the test until it gets a probe. Each probe calls every exported method; SSE streams are read until a mocked Redis closes them.
   - `PAGE_PROBES` must equal the set of student `page.tsx` files. Each probe calls that page's loaders (`getProblemWorkspace` for P and the draft slug, `getSubmissionDetail/View`, `getRunView`, help panels, search, dashboard and profile queries), or is explicitly `null` for content-free pages.
   - Every export of every `"use server"` file is called as STUDENT: staff exports must return the Forbidden message; student exports get valid inputs targeting P.
   - `POST /api/admin/problems/import` as STUDENT returns 403.
   - Every result is passed through `JSON.stringify` and must contain no canary.
3. **E2E complement: `apps/web/e2e/content-leak.spec.ts`.** As the student, fetch each student route (HTML and `RSC: 1` flight) plus the admin problem routes, and assert none contains two-sum's distinctive hidden-test lines (`generateTwoSumTests()`), any `TWO_SUM_REFERENCE` source line, or the seeded drafts' statements. Admin routes must redirect.

**The manual flow, automated: `apps/web/test/problem-authoring.db.test.ts`:**
- Create, add tests and solutions with a *wrong* model, validate: STAGE1_FAILED.
- `approveVersion` and `publish` are BLOCKED with "Model solution failed: … produced WA".
- Withdraw, fix, re-validate (old runs are ignored by `judgeSeq`), then submit.
- Self-approval is refused; a second admin approves; publish r1.
- Pin a submission to r1.
- `startRevision`, edit the statement, validate, approve, publish r2.
- `getSubmissionDetail` still returns r1's statement and revision 1, and r1's rows are byte-identical.
- Editing a test after COMPLETE blocks publish until re-validated.
- The bundle is written only after the freeze, from the frozen tests.

The manual run is also performed and recorded in `docs/RUNBOOK.md` with a date.

**Import:**
- `apps/web/test/import-package.test.ts`: collects multiple issues; refuses traversal, symlink and NUL names; non-UTF-8 statement; unpaired test; oversized sample; missing comparator.
- `apps/web/test/import-zip.test.ts`: zips built in-test with `deflateRawSync` and `zlib.crc32`, no new dev dependency. Declared-size lie, caps, duplicate names.
- `apps/web/test/problem-import.db.test.ts`:
  - A 300-entry synthetic archive with entry #150 corrupt gives 299 CREATED and 1 FAILED.
  - Re-upload gives 299 UNCHANGED.
  - Fixing #150 gives 1 CREATED.
  - NEW_REVISION when live exists; FAILED on an open draft or a displayCode clash; blobs deduplicated.
- `apps/web/test/admin-import-route.test.ts`: 403 (cross-site and non-staff), 415, 413, 409.

**Actions:** `apps/web/test/admin-problems-actions.test.ts`, mocked like admin-judge.test.ts:
- Every export refuses STUDENT, TA_MENTOR and PLACEMENT_OFFICER before any database call.
- The SUPER-only exports call `requireSuperAdmin` and refuse ADMIN.
- Audit names and sensitivities match §5.

**Pure logic:**
- `packages/shared/test/authoring-{review,content,package}.test.ts`.
- `apps/judge-worker/test/comparator-parity.test.ts`: `effectiveCompareMode` (plan.ts:152) throws exactly for comparators outside `JUDGEABLE_FUNCTION_COMPARATORS`.

**Existing tests to update:**
- `apps/web/test/validation-clone.test.ts:62-63`: clone no longer writes a bundle.
- `judge-pipeline.db.test.ts:748`: `bundleKey` is null after clone and set after publish.

## 9. Golden-file test (Done-when item next to this stream)

`apps/judge-worker/test/integration/golden-content.isolate.test.ts` runs on the Linux isolate job. For every seeded problem and every reference solution in a language enabled by default, it builds a job (helper in `test/support/jobs.ts`, like `twoSumJob`) and asserts the expected verdict.

A static `seed-content` test additionally asserts that every seeded problem has a model solution in each enabled-by-default language (cpp20 and py312 today).

This needs the authored problem modules (`apps/web/scripts/content/{types,two-sum,bracket-cleanup,study-pairs,handle-maker,lab-power-budget,second-swipe,index}.ts`, which import only `@recx/shared`) moved into a new `packages/content` (`@recx/content`). It would be a judge-worker devDependency; `judge-isolation.test.ts` still passes because the package has no database dependency. `apps/web/scripts/content/index.ts` would re-export from it.

## 10. Cross-stream interactions and conflicts

- **schema.prisma:**
  - I edit the `ProblemVersion` block; the contest and assessment streams will add back-relations there. I edit `ValidationRun` and add 4 enums and 3 models.
  - Migrations need distinct timestamps.
  - The privileged-operations stream's `enum PrivilegedOperationKind` **must include `PROBLEM_DELETE` and `PROBLEM_VERSION_DELETE`**.
- **Privileged-operations contract I consume** (owned by the super-admin stream), file `apps/web/src/lib/privileged.ts`:
  - `requestPrivilegedOperation(input: { kind; targetType; targetId; reason; payload? }, actor: User): Promise<{ id: string }>`
  - `consumePrivilegedOperation(tx: DbTx, input: { operationId; kind; targetId; executorId }): Promise<{ requestedById; approvedById; breakGlass: boolean }>`. It throws unless the operation is APPROVED, unexpired (24 h), the kind and target match, and it has not been executed; it marks the operation EXECUTED in the same transaction.
- **`src/lib/auth/capabilities.ts`** (RBAC stream): capability "retire a published problem, delete a version, global rejudge" must map to `admin-problems#retireProblem`, `#deleteProblemVersion`, `#deleteProblem`, `#requestProblemDeletion` (and their own `globalRejudge`). For the role × capability matrix, these are SUPER_ADMIN only; all other exports in §5 are ADMIN or SUPER_ADMIN; STUDENT, TA_MENTOR and PLACEMENT_OFFICER get nothing. No change to `guards.ts` is needed.
- **`lib/errors.ts` `ConflictError`:** one definition, so coordinate. **`admin-shell.tsx:14` NAV and `admin/page.tsx:18`** (the cohort-dashboard stream owns the redirect): append-only edits.
- **`packages/shared`:** the new `./authoring` subpath keeps `src/index.ts` untouched. The FUNCTION-harness stream owns extending `JUDGEABLE_FUNCTION_COMPARATORS` when SET_EQUAL and ROWS_ANY_ORDER land, and must copy any new ProblemVersion fields in `cloneVersionAsDraft`. Its six seeded IN_PLACE_MUTATION and CUSTOM_CHECKER problems should land in `@recx/content` after the move in §9.
- **`apps/web/package.json` and the lockfile** (`yauzl`), plus `next.config.ts`: likely merge conflicts with the student-import stream. That stream should reuse `spoolRequestBody` (and could move it to `lib/upload/`). `tests/repo/support/module-graph.ts` can be shared with the RBAC stream's static tests.
- **Student surface:** the submission detail page and query change (§4).
- **Sheets stream:** retiring a problem leaves it in study plans. Ideally `retireProblem` calls a `recountPlansForProblem(problemId)` they expose.
- **Judge settings stream:** enabling a language should point admins to `check-approved.ts`; no code dependency.

## 11. Entries for `docs/OPEN-QUESTIONS.md` (narrower readings)

1. **APPROVED** is `status = IN_REVIEW` with `approvedAt` set; `ProblemStatus` is unchanged; RETIRED exists only on Problem.
2. **The reviewer must differ** from the creator, the last editor and the submitter. The only exception is the operator CLI `--approve`.
3. **Only ADMIN and SUPER_ADMIN author and review.** TA_MENTOR and senior-student contributions arrive through an admin-run import, with `origin` and an originality attestation recorded.
4. **"Pass in every enabled language"** means every reference solution in an enabled language gets its expected verdict, with C++ mandatory. It is not read as "every enabled language must have a model" for database-held problems. Seeded content does have to have a model per enabled-by-default language.
5. **Deletion** covers never-published revisions and problems only. There is no un-retire, and publishing a RETIRED problem is refused.
6. **Slug and displayCode** cannot change after creation.
7. **Import limits.**
   - The UI takes zip only; directories go through the CLI.
   - There is no dry run, and validation is not started automatically: 300 imports land on the REJUDGE lane at ≤ 20 %.
   - A single test file is capped at 64 MiB; larger needs a streaming `TestDataStore.put`.
   - An import never overwrites an open draft, and topics are applied only on CREATED.
8. **The test-upload server action is capped at 1 MB;** larger test sets go through import.
9. **Statement-only edits do not invalidate validation** (`editSeq` vs `judgeSeq`).
10. **Storage clean-up is deferred.**
    - Bundles are written once after the freeze.
    - Garbage collection of orphan blobs and import blobs is deferred.
    - Seeded dev drafts that already have bundles may hit `ImmutableKeyError` on repair if their tests were edited.
11. **The DB trigger tying the live pointer to a frozen version is deferred** because of the Phase 3 fixtures; the publish path is the fence.
12. **`check-approved.ts` is an operator or cron command,** not a GitHub job, because APPROVED rows live in the production database.
13. **Retire does not recount study-plan totals** until the sheets stream exposes a hook.

**Docs to write or update:** a new `docs/AUTHORING.md` covering:
- the package format and limits;
- explicitly: no GPU, ML, multi-process or distributed problems, and none over 15 s or 1 GB;
- that all content must be originally authored.

Also add an authoring paragraph to `docs/ARCHITECTURE.md`, and add the import, `check-approved`, bundle-repair and Phase 4 manual-verification entries to `docs/RUNBOOK.md`.