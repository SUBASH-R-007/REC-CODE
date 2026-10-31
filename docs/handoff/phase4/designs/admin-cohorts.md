# Phase 4 design: the admin tree (non-authoring) and AdminScope

Nothing in the repo was changed; I only read files. Line references are to the current tree.

---

## 0. Decisions on the tensions (narrower reading in each case; every one goes into OPEN-QUESTIONS, see §12)

**(a) What `/admin/students/import` imports.** It imports an LMS roster export. It copies identities that already exist in the LMS and never creates a new one.
- Columns: `lmsUserId, collegeId, email, firstName, lastName, batchYear, departmentCode, section`.
- A row without `lmsUserId` is rejected (`MISSING_LMS_ID`).
- Rows are matched on `lmsUserId`, `collegeId` and `email`. The import never sets or changes `role`, `status` or `passwordHash`.
- Students missing from the file are counted and shown, but never changed. Deactivation is a super-admin and Phase 8 matter.
- A roll-number change (same `lmsUserId`, different `collegeId`) is rejected as `ROLL_NUMBER_CHANGED` and left to the super-admin.
- The flow is a dry-run preview stored in `RosterImport`, then a separate commit. The commit recomputes the diff and refuses if its `diffSha256` differs from what the admin was shown.
- **Imported accounts have `passwordHash = null`, so they cannot sign in until LMS OIDC ships in Phase 10.** This needs a decision (§12, item 1).

**(b) `/admin/discuss`.** I do not create it. Discussion is deferred to Phase 11+ together with TA_MENTOR moderation ("do not half-build"). Phase 3 already hid the Discussion tab rather than show it dead, and the nav test (§8) forbids dead links.

**(c) Sheets and tracks.** `/admin/sheets` edits `StudyPlan` rows with `kind = SHEET`, which students see at `/sheets`. `/admin/tracks` edits `kind = TRACK`, seen at `/learn`. Both use one component set and one action module, following `PLAN_KINDS` (components/plans/kinds.ts:19). There are no new plan models.
- Plans are college-wide content: no audience targeting and no AdminScope on the content itself. Enrolment and progress figures shown in admin are scoped.
- There is no delete; "unpublish" takes its place, because the enrolment cascade would delete student rows.
- The slug cannot change after creation.

**(d) Accommodation.** I add the full model from spec line 515 now, plus a status workflow, so Phase 6 can use it without changes.
- An ADMIN requests; only a SUPER_ADMIN approves (`requireSuperAdmin`).
- Approved terms cannot be edited: a change is a new request that supersedes the old one. A database trigger enforces this.
- `kinds` (a disability label) and `reason` appear only on `/admin/accommodations/[id]`. They never go into audit metadata, the list views or any reviewer projection.
- `ProctorEventKind` is declared now (the 24 kinds listed verbatim on spec line 437) so `exemptSignals` is typed.

**(e) Announcements.**
- New `Announcement` model. Publishing writes one `Notification` per student (kind `"announcement"`, with a new `Notification.announcementId`) for students who are in scope, in the audience, and ACTIVE or SOFT_RESTRICTED.
- Students see it in the existing bell and `/notifications`, plus a new dashboard banner that shows live announcements whose notification is still unread. "Dismiss" uses the existing `markNotificationRead`.
- Plain text only, no scheduling, and the text cannot change after publishing.

**(f) Cohorts.** Derived from `User.(batchYear, departmentCode, section)`, which the LMS owns. There is no `Cohort` model. The existing index `[batchYear, departmentCode, section]` serves it. The URL key is `2027.CSE.A`, or `2027.CSE.-` when there is no section.

**(g) Reports.** Built only from User, UserStats, XpBucket, UserProblemStatus, ActivityDay and StudyPlanEnrollment, always joined to User through the scope helper. Never from XpEvent; `tests/repo/xp-ledger.test.ts` already enforces that.
- Reports count ACTIVE and SOFT_RESTRICTED students only.
- There is no export in Phase 4, because a PII export is a super-admin action that needs a PrivilegedOperation.

**Account status.** An ADMIN has no status mutation anywhere in `/admin`.
- `/admin/students/[id]` shows the status with the line "Account status changes are made by a super-admin."
- A SUPER_ADMIN viewer gets a link to the super stream's user page instead.
- Nothing in this stream needs a PrivilegedOperation, because there are no bulk status changes here.

**AdminScope semantics.**
- Each `AdminScope` row grants student visibility to one ADMIN by department and/or batch (no section). A null in a dimension means every value; a row with both null is college-wide.
- An ADMIN with no active row sees no students: it fails closed.
- SUPER_ADMIN is never scoped.
- Every helper also adds `role = STUDENT`, so staff accounts never appear in admin student queries.

---

## 1. Prisma additions (`packages/db/prisma/schema.prisma`)

```prisma
enum AccommodationKind {
  SCREEN_READER
  MAGNIFIER
  SPEECH_INPUT
  EXTRA_TIME
  BREAKS
  SEPARATE_ROOM
}

enum AccommodationStatus {
  REQUESTED
  APPROVED
  REJECTED
  WITHDRAWN
  REVOKED
  SUPERSEDED
}

/// Mirror of PROCTOR_EVENT_KINDS in @recx/shared (parity test). Declared in
/// Phase 4 so Accommodation.exemptSignals is typed; ProctorEvent is Phase 6.
enum ProctorEventKind {
  FOCUS_LOSS
  FULLSCREEN_EXIT
  EXTERNAL_PASTE
  INTERNAL_PASTE
  PROGRAMMATIC_INSERT
  COPY
  CUT
  CONTEXT_MENU
  CADENCE_BURST
  IDLE_GAP
  FIRST_KEYSTROKE
  WINDOW_RESIZE
  MULTI_MONITOR
  DEVTOOLS_HEURISTIC
  AUTOMATION_HINT
  NETWORK_DROP
  HEARTBEAT_GAP
  IP_CHANGED
  UA_CHANGED
  SEQUENCE_GAP
  CONCURRENT_SESSION
  SUBMISSION_RATE_ANOMALY
  CLIENT_SCRIPT_ERROR
  INVIGILATOR_NOTE
}

enum RosterImportStatus {
  PREVIEWED
  COMMITTED
  EXPIRED
}

enum AnnouncementTone {
  INFO
  IMPORTANT
}

/// Student visibility granted to one ADMIN: department and/or batch. A null
/// dimension = every value; both null = college-wide. No active row = no
/// student access (fail closed). SUPER_ADMIN is never scoped. Written only by
/// SUPER_ADMIN (role/scope management), audited. Folded into every admin
/// student query by scopedStudentWhere(); tests/repo/admin-scope.test.ts is the fence.
model AdminScope {
  id             String    @id @default(cuid())
  adminId        String
  admin          User      @relation(fields: [adminId], references: [id])
  departmentCode String?
  batchYear      Int?
  reason         String
  grantedById    String
  createdAt      DateTime  @default(now())
  revokedAt      DateTime?
  revokedById    String?

  @@index([adminId, revokedAt])
}

/// Super-admin approval only, with expiry and full audit. Phase 6 reads the
/// APPROVED row (validUntil > now) at attempt start. `kinds` is a disability
/// label: shown only on /admin/accommodations/[id] (ADMIN/SUPER) and to the
/// student — never to a reviewer or invigilator, never in audit metadata.
/// Granted terms are immutable (trigger); a change is a new superseding request.
model Accommodation {
  id                     String              @id @default(cuid())
  userId                 String
  user                   User                @relation(fields: [userId], references: [id])
  status                 AccommodationStatus @default(REQUESTED)
  kinds                  AccommodationKind[]
  exemptSignals          ProctorEventKind[]  @default([])
  /// 0–100 (33 ≈ the standard 20 min/hour). CHECK in migration.
  extraTimePercent       Int                 @default(0)
  extraTimeMinutes       Int                 @default(0)
  allowBreaks            Boolean             @default(false)
  breakMinutes           Int                 @default(0)
  /// 100–200. CHECK in migration.
  fontScalePercent       Int                 @default(100)
  allowScribe            Boolean             @default(false)
  highContrast           Boolean             @default(false)
  reason                 String              @db.Text
  /// No upload in Phase 4: documents stay with the accessibility office.
  documentFileId         String?
  validUntil             DateTime
  requestedById          String
  requestedAt            DateTime            @default(now())
  approvedBySuperAdminId String?
  grantedAt              DateTime?
  decidedById            String?
  decidedAt              DateTime?
  decisionNote           String?
  revokedById            String?
  revokedAt              DateTime?
  supersedesId           String?             @unique
  supersedes             Accommodation?      @relation("AccommodationSupersedes", fields: [supersedesId], references: [id])
  supersededBy           Accommodation?      @relation("AccommodationSupersedes")
  updatedAt              DateTime            @updatedAt

  @@index([userId, status])
  @@index([status, validUntil])
}

/// Dry-run roster import. `rows` (PII) is nulled on commit, discard or expiry.
model RosterImport {
  id            String             @id @default(cuid())
  status        RosterImportStatus @default(PREVIEWED)
  createdById   String
  fileName      String
  fileSha256    String
  rowCount      Int
  /// Validated RosterRow[]; NULL after commit/discard/expiry.
  rows          Json?
  /// Outcome counts {create, update, link, unchanged, skipped, rejected}.
  counts        Json
  /// sha256 of the canonical plan shown at preview (informational; commit compares to the form's hash).
  diffSha256    String
  /// After commit: [{line, outcome, userId?, changedFields?}] — ids and field names only.
  results       Json?
  resultsSha256 String?
  expiresAt     DateTime
  committedAt   DateTime?
  createdAt     DateTime           @default(now())

  @@index([createdById, createdAt(sort: Desc)])
  @@index([status, expiresAt])
}

/// Plain-text staff announcement. Publishing fans out one Notification per
/// in-scope ACTIVE/SOFT_RESTRICTED student in the audience; text is then immutable.
model Announcement {
  id                     String           @id @default(cuid())
  title                  String
  body                   String           @db.Text
  tone                   AnnouncementTone @default(INFO)
  /// Same-origin path only (safeNotificationHref).
  link                   String?
  /// Audience; null = every value of that dimension (must be covered by the author's scope).
  audienceBatchYear      Int?
  audienceDepartmentCode String?
  audienceSection        String?
  /// Banner stops after this; notifications stay in history.
  endsAt                 DateTime
  publishedAt            DateTime?
  publishedById          String?
  archivedAt             DateTime?
  archivedById           String?
  recipientCount         Int              @default(0)
  createdById            String
  createdAt              DateTime         @default(now())
  updatedAt              DateTime         @updatedAt
  notifications          Notification[]

  @@index([publishedAt(sort: Desc)])
}
```

**Changes to existing models**
- `User` (schema.prisma:204): add back-relations `adminScopes AdminScope[]` and `accommodations Accommodation[]`. Actor ids stay plain strings with no relation, following the existing `Problem.createdById` and `JudgeQuotaOverride.grantedById`.
- `Notification` (:985): add `announcementId String?`, `announcement Announcement? @relation(fields: [announcementId], references: [id])`, and `@@index([announcementId, readAt])`.
- `StudyPlan` (:903): add `seedManaged Boolean @default(false)`, `createdById String?` and `updatedById String?`.

**Migration `2026101100xxxx_phase4_admin_scope`** (generated, then hand-edited with):
```sql
CREATE UNIQUE INDEX "AdminScope_active_grant_key" ON "AdminScope" ("adminId","departmentCode","batchYear")
  NULLS NOT DISTINCT WHERE "revokedAt" IS NULL;
ALTER TABLE "Accommodation"
  ADD CONSTRAINT "Accommodation_extra_time_percent_check" CHECK ("extraTimePercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "Accommodation_extra_time_minutes_check" CHECK ("extraTimeMinutes" BETWEEN 0 AND 240),
  ADD CONSTRAINT "Accommodation_breaks_check" CHECK ("breakMinutes" BETWEEN 0 AND 120 AND ("allowBreaks" OR "breakMinutes" = 0)),
  ADD CONSTRAINT "Accommodation_font_scale_check" CHECK ("fontScalePercent" BETWEEN 100 AND 200),
  ADD CONSTRAINT "Accommodation_kinds_nonempty_check" CHECK (cardinality("kinds") > 0),
  ADD CONSTRAINT "Accommodation_granted_check" CHECK ("status" NOT IN ('APPROVED','REVOKED','SUPERSEDED')
      OR ("approvedBySuperAdminId" IS NOT NULL AND "grantedAt" IS NOT NULL));
CREATE UNIQUE INDEX "Accommodation_one_approved_per_user" ON "Accommodation" ("userId") WHERE "status" = 'APPROVED';
CREATE UNIQUE INDEX "Accommodation_one_open_request_per_user" ON "Accommodation" ("userId") WHERE "status" = 'REQUESTED';
-- recx_refuse_granted_accommodation_terms(): BEFORE UPDATE, if OLD."grantedAt" IS NOT NULL and any of
-- (userId,kinds,exemptSignals,extraTimePercent,extraTimeMinutes,allowBreaks,breakMinutes,fontScalePercent,
--  allowScribe,highContrast,reason,validUntil) IS DISTINCT FROM OLD → RAISE ... USING ERRCODE='check_violation'
-- (same shape as recx_refuse_frozen_version_write in 20261009210810_init:519). Plus BEFORE DELETE → RAISE.
ALTER TABLE "Announcement"
  ADD CONSTRAINT "Announcement_section_needs_cohort_check" CHECK ("audienceSection" IS NULL
      OR ("audienceBatchYear" IS NOT NULL AND "audienceDepartmentCode" IS NOT NULL)),
  ADD CONSTRAINT "Announcement_title_len_check" CHECK (char_length("title") BETWEEN 1 AND 120),
  ADD CONSTRAINT "Announcement_body_len_check" CHECK (char_length("body") BETWEEN 1 AND 2000);
UPDATE "StudyPlan" SET "seedManaged" = true WHERE "slug" IN ('rec-starter-sheet','arrays-hashing-basics');
```

---

## 2. Shared package (`packages/shared/src`)

- **`proctor.ts`**:
  - `export const PROCTOR_EVENT_KINDS = [...24 kinds above...] as const;`
  - `export type ProctorEventKind = (typeof PROCTOR_EVENT_KINDS)[number];`
  - `export const proctorEventKindSchema = z.enum(PROCTOR_EVENT_KINDS);`
- **`accommodation.ts`**:
  - `ACCOMMODATION_KINDS` (6, as const) and `type AccommodationKind`.
  - `ACCOMMODATION_LIMITS = { extraTimePercent:{min:0,max:100}, extraTimeMinutes:{min:0,max:240}, breakMinutes:{min:0,max:120}, fontScalePercent:{min:100,max:200}, maxValidityDays:400 } as const`.
  - `accommodationTermsSchema`, a zod object `{kinds, exemptSignals, extraTimePercent, extraTimeMinutes, allowBreaks, breakMinutes, fontScalePercent, allowScribe, highContrast, validUntil: z.coerce.date()}`. Its `superRefine` rules: kinds non-empty and unique; EXTRA_TIME in kinds if and only if `extraTimePercent > 0` or `extraTimeMinutes > 0`; BREAKS if and only if `allowBreaks`; `!allowBreaks` implies `breakMinutes === 0`; exemptSignals unique; `validUntil` in the future and no more than `maxValidityDays` ahead.
  - `type AccommodationTerms = z.infer<...>`.
  - `suggestedExemptSignals(kinds: readonly AccommodationKind[]): ProctorEventKind[]`. SCREEN_READER gives FOCUS_LOSS and FULLSCREEN_EXIT (spec line 517). MAGNIFIER gives FULLSCREEN_EXIT. SPEECH_INPUT gives CADENCE_BURST and PROGRAMMATIC_INSERT, which is an inference. These only pre-fill the form; the super-admin confirms them.
  - `interface ReviewerAccommodationView { readonly exemptSignals: readonly ProctorEventKind[] }` and `reviewerAccommodationView(t: Pick<AccommodationTerms,"exemptSignals">): ReviewerAccommodationView`. This is the only projection Phase 6 reviewers get.
  - `accommodatedDurationSec(durationSec: number, t: Pick<AccommodationTerms,"extraTimePercent"|"extraTimeMinutes">): number`, computed as `floor(durationSec × (1 + p/100)) + minutes × 60`. Phase 6 applies `min(…, closesAt)`.
- **`roster.ts`**:
  - `ROSTER_COLUMNS` (8, as const).
  - `ROSTER_IMPORT_LIMITS = { maxRows: 5000, maxBytes: 900 * 1024 } as const`. This stays under Next's default 1 MB server-action body, so `next.config.ts` needs no change.
  - `rosterRowSchema` (zod):
    - `lmsUserId` 1–64 characters `/^[A-Za-z0-9_.:-]+$/`, required.
    - `collegeId` trimmed `/^[A-Za-z0-9]{4,32}$/`.
    - `email` lowercased, at most 254 characters.
    - `firstName` 1–80, `lastName` 0–80.
    - `batchYear` int 2000–2100.
    - `departmentCode` uppercased `/^[A-Z]{2,10}$/`.
    - `section` uppercased `/^[A-Z0-9]{1,4}$/` or null.
  - `type RosterRow`.
- **`index.ts`**: append `export * from "./proctor"; export * from "./accommodation"; export * from "./roster";`.
- **`packages/db/test/enum-parity.test.ts`**: add the pairs `PROCTOR_EVENT_KINDS` / `ProctorEventKind` and `ACCOMMODATION_KINDS` / `AccommodationKind`.

---

## 3. The AdminScope helper (one module plus its loader)

**`apps/web/src/lib/auth/scope-where.ts`** is pure, has no `server-only` marker, and is unit-tested:
```ts
import { Prisma, type Role } from "@recx/db";
export interface ScopeGrant { readonly departmentCode: string | null; readonly batchYear: number | null }
declare const SCOPE: unique symbol;
export type StudentScope = { readonly [SCOPE]: true; readonly actorId: string } &
  ({ readonly kind: "ALL" } | { readonly kind: "GRANTS"; readonly grants: readonly ScopeGrant[] });
declare const SCOPED_ID: unique symbol;
export type ScopedStudentId = string & { readonly [SCOPED_ID]: true };
export const ACTIVE_STUDENT_STATUSES = ["ACTIVE", "SOFT_RESTRICTED"] as const;
/** SUPER_ADMIN → ALL; ADMIN → GRANTS (a both-null grant collapses to ALL); any other role throws ForbiddenError. */
export function buildStudentScope(actor: { id: string; role: Role }, grants: readonly ScopeGrant[]): StudentScope;
/** { AND: [{ role: "STUDENT" }, <OR of grants | {} for ALL | { id: { in: [] } } for none>, extra ?? {}] } — never spread it. */
export function scopedStudentWhere(scope: StudentScope, extra?: Prisma.UserWhereInput): Prisma.UserWhereInput;
/** Parameterised `("u"."role"='STUDENT'::"Role" AND (…grants…))`; FALSE for no grants; alias checked against /^[a-z_][a-z0-9_]*$/. */
export function scopedStudentSql(scope: StudentScope, alias?: string): Prisma.Sql;
/** { AND: [{ role: { not: "STUDENT" } }, extra] } — staff name lookups (grantor/author names). */
export function staffOnlyWhere(extra: Prisma.UserWhereInput): Prisma.UserWhereInput;
/** Grant g covers c iff (g.dept === null || (c.dept !== null && g.dept === c.dept)) and the same for batch. A null in c means "all". */
export function scopeCovers(scope: StudentScope, cohort: { departmentCode: string | null; batchYear: number | null }): boolean;
export function isEmptyScope(scope: StudentScope): boolean;
export function describeScope(scope: StudentScope): string; // "Whole college", "CSE · all batches; ECE 2027", "No student access"
```

**`apps/web/src/lib/auth/scope.ts`** is `server-only` and holds the loaders and guards. It uses `requirePageRole`/`requireActionRole` (guards.ts:37, :55) and does not edit guards.ts.
```ts
export const loadStudentScope: (user: Pick<User, "id" | "role">) => Promise<StudentScope>; // React cache(); reads AdminScope {adminId, revokedAt: null}
export async function requireAdminScopePage(): Promise<{ user: User; scope: StudentScope }>;   // requirePageRole("ADMIN","SUPER_ADMIN") + load
export async function requireAdminScopeAction(): Promise<{ user: User; scope: StudentScope }>; // requireActionRole("ADMIN","SUPER_ADMIN") + load
export interface ScopedStudent { scopedId: ScopedStudentId; collegeId: string; lmsUserId: string | null; firstName: string;
  lastName: string; email: string; status: AccountStatus; batchYear: number | null; departmentCode: string | null; section: string | null }
/** findFirst({ where: scopedStudentWhere(scope, { id }) }); missing or out of scope → NotFoundError("That student was not found.") (no enumeration). */
export async function requireScopedStudent(scope: StudentScope, userId: string, client?: Db | DbTx): Promise<ScopedStudent>;
export async function requireScopedStudentPage(scope: StudentScope, userId: string): Promise<ScopedStudent>; // notFound() instead
export async function listScopedStudentIds(client: Db | DbTx, scope: StudentScope, where?: Prisma.UserWhereInput): Promise<ScopedStudentId[]>;
```
Only these two files may cast `as ScopedStudentId` or `as StudentScope` or call `buildStudentScope(`. Tests are exempt. Per-student admin query functions take `ScopedStudent` or `ScopedStudentId`, so passing a raw id is a `pnpm typecheck` error.

**Usage rules** (enforced in §4):
- Relation models filter with `user: scopedStudentWhere(scope)` as a property.
- `User` queries use `where: scopedStudentWhere(scope, {...filters})`.
- Raw SQL interpolates `${scopedStudentSql(scope, "u")}` against a joined `"User" u`.

---

## 4. The query-shape fence: `tests/repo/admin-scope.test.ts`

This follows the xp-ledger test pattern: `findFiles`, `lexSource`, `lineAt` and `readRepoFile` from `tests/repo/support/repo.ts`, with flag and no-flag self-tests for every rule. It runs in `pnpm test` through `vitest.repo.config.ts`, so it is part of the gate.

**Admin-reachable files.** These are files under:
- `apps/web/src/app/admin/**`
- `apps/web/src/components/admin/**`
- `apps/web/src/lib/admin/**`
- `apps/web/src/server/actions/admin-*.ts`
- `apps/web/src/server/queries/admin-*.ts`

Plus any `apps/web/src` file that imports `@/lib/auth/scope`, and any file containing `requireActionRole(`, `requirePageRole(` or `requireSuperAdmin(` together with a `"ADMIN"` or `"SUPER_ADMIN"` literal. The string scan matters because admin-judge.ts spreads `ADMIN_ROLES`. Imports of `@/server/**` and `@/lib/admin/**` from those files are followed transitively.

**STUDENT_MODELS** is computed by parsing schema.prisma: every model with a `userId` field or a relation to `User`, minus `NON_STUDENT = { AdminScope }`. The test fails if a model is in neither list, so Phase 5+ models are picked up automatically.

**Rules**
1. **R1.** Every `(db|tx|client).<studentModel>.(find*|count|aggregate|groupBy|updateMany|deleteMany)(…)` call has, in its balanced argument text, `scopedStudentWhere(` or `staffOnlyWhere(` (the latter only on `user`).
2. **R2.** Every `$queryRaw` or `$executeRaw` template whose body names a STUDENT_MODELS table contains `${scopedStudentSql(`.
3. **R3.** No `$queryRawUnsafe` or `$executeRawUnsafe` in admin-reachable files.
4. **R4.** Single-row writes (`update`, `delete`, `create`, `createMany`, `upsert`) on student models must have the identifier `scopedId` in their argument text, or a `where` containing `scopedStudentWhere(`.
5. **R5.** These models may not be read from admin-reachable files at all: `note`, `codeDraft`, `submissionSource`, `auditLog`. Notes and drafts are private to the student, and full audit read is super-only.
6. **R6.** No spread of `...scopedStudentWhere(` or `...staffOnlyWhere(`, so later keys cannot override the scope.
7. **R7.** `as ScopedStudentId`, `as StudentScope` and `buildStudentScope(` appear only in `lib/auth/scope*.ts`.
8. **R8.** Every `app/admin/**/page.tsx` calls `requireAdminScopePage(`. Every exported `async function` in `server/actions/admin-*.ts` calls one of `requireAdminScopeAction(`, `requireSuperAdmin(` or `requireActionRole(`.
9. **R9.** `app/admin/**` and `components/admin/**` do not import `@/lib/db`. Data access goes through the query and action modules only.
10. **R10.** Repo-wide: no `user.delete(` or `user.deleteMany(` anywhere in `apps/web/src`, because a student is never hard-deleted.

**Exemptions** live in the test file as an exact-count list `{ file, call, count, reason }`. A new call in an exempt file breaks the count.
- `server/queries/admin-judge.ts` `submission.findMany/count` (4 calls): fleet stuck and failed lists that now select no identity.
- `server/queries/admin-judge.ts` raw SQL over `"Submission"`, `"RunRequest"` and `"ValidationRun"` (5 templates): fleet telemetry aggregates with no per-student rows.
- `lib/admin/roster.ts` `user.createMany` (1 call): the LMS roster copy, where the target cohort is checked by `scopeCovers` in `planRosterImport`.

---

## 5. Pages and guards

Every page calls `const { user, scope } = await requireAdminScopePage()`. The layout keeps `requirePageRole("ADMIN","SUPER_ADMIN")` (app/admin/layout.tsx:9). Every page exports `metadata`, and params are `Promise<…>`.

| Route | File (apps/web/src/app/admin/…) | Reads (query module) |
|---|---|---|
| `/admin` | `page.tsx` (replaces the redirect at page.tsx:7) | `getAdminOverview(scope, now)`. Shows students in scope, students active this week (`lastActiveAt ≥ campus Monday`), solves this week (WEEK XpBucket sum), zero-solve count, top 8 cohorts, "needs attention" (inactive ≥14 days, pending accommodation requests, last own import, live announcements). Empty state if `isEmptyScope`. |
| `/admin/students` | `students/page.tsx` | `listStudents(scope, filters)`. The searchParams `q, batch, dept, section, status, inactive, after` are parsed by `lib/admin/student-filters.ts`. `q` matches an exact roll number or email, or a name prefix (no trigram at 5k rows). Keyset on `collegeId`, 50 per page. |
| `/admin/students/[id]` | `students/[id]/page.tsx`, `not-found.tsx` | `requireScopedStudentPage` then `getStudentDetail(student)`. Shows identity ("Managed in REC Learning"), status plus the super-admin notice or link, UserStats, the last 20 submissions (metadata only), enrolments, "Accommodation on file: yes/no" (no kinds), a judge-override flag and the "Sign out everywhere" button. |
| `/admin/students/import` | `students/import/page.tsx` | Upload form (`useActionState`), format help and recent imports (own; SUPER sees all). |
| `/admin/students/import/[importId]` | `…/[importId]/page.tsx` | `getImportPreview(user, scope, id)` recomputes the plan from the stored rows at every render and shows the diff by outcome, the hidden `diffSha256`, and Commit and Discard buttons. |
| `/admin/cohorts` | `cohorts/page.tsx` | `listCohorts(scope, now)`: `user.groupBy` on the cohort and status columns plus active-7-days counts. Links to students and reports filtered by cohort. |
| `/admin/sheets`, `/new`, `/[id]` | `sheets/…` | `listPlansForAdmin("SHEET", scope)` and `getPlanForEdit(id)`. The kind on the row must match the route, otherwise `notFound()`. |
| `/admin/tracks`, `/new`, `/[id]` | `tracks/…` | The same with `"TRACK"`. |
| `/admin/reports` | `reports/page.tsx` | `getCohortReport(scope, { cohort?, weeks: 8 }, now)`. A `cohort` param not covered by the scope is ignored. |
| `/admin/announcements`, `/new`, `/[id]` | `announcements/…` | `listAnnouncements(scope)` (audience covered by scope) and read counts from scoped `notification.count`. |
| `/admin/accommodations`, `/new?student=<id>`, `/[id]` | `accommodations/…` | `listAccommodations(scope, status?)`: status, validity and a terms summary, no kinds. The detail page shows kinds and reason; approve, reject and revoke appear only for SUPER and are enforced server-side. |
| `/admin/judge` | `judge/page.tsx` (retrofit) | `loadJudgeHealth(scope)`. |
| `/admin/discuss` | **not created** | — |

---

## 6. Server actions

Every action uses `"use server"`, zod and `runAction` (errors.ts:81; it re-throws `NEXT_REDIRECT`, :69). Every audit call uses `audit()` (audit.ts:23) with `ipHash: await requestIpHash()`. Reasons use the `reasonSchema` pattern (admin-judge.ts:30) and `ReasonDialog` (components/admin/reason-dialog.tsx).

**`server/actions/admin-roster.ts`**

| Action | Guard | Behaviour | Audit (sensitivity) |
|---|---|---|---|
| `previewRosterImport(prev, formData): Promise<ActionResult<{importId}>>` | `requireAdminScopeAction` | Checks the file (≤ maxBytes, `.csv`), parses (`parseRosterCsv`), validates rows and plans (dry run). Writes only a `RosterImport` with a 60-minute expiry. Rate limit `hitRateLimit("admin-bulk:"+id, {limit:10, windowMs:60_000})`. Lazily expires stale previews. Redirects to the preview page. | `roster.import.previewed` (NORMAL), with `{importId, fileSha256, rowCount, counts}` |
| `commitRosterImport({importId, diffSha256})` | `requireAdminScopeAction`; own import or SUPER | One transaction, 60 s timeout. Takes `pg_advisory_xact_lock(hashtext('roster-import'))`, reloads matches, re-plans and refuses if `sha256(plan) !== diffSha256` ("The data changed since your preview — review the new diff"). Applies creates (`passwordHash null`, `role STUDENT`, `status ACTIVE`, generated handle), updates and links. Refreshes XpBucket cohort columns for open periods only (ALL_TIME, current MONTH and WEEK, using `isoWeekKey`/`campusDay` from shared) with `user: scopedStudentWhere`. Sets COMMITTED, `rows = DbNull`, results and resultsSha256. Same rate limit. | `roster.import.committed` (SENSITIVE), with `{importId, counts, resultsSha256, scope: describeScope}`. Plus `student.cohort.changed` (NORMAL) per moved student, with `targetUserId` and `{from, to, importId}`. |
| `discardRosterImport({importId})` | same | Sets EXPIRED and `rows = DbNull`. | `roster.import.discarded` (NORMAL) |

**`server/actions/admin-students.ts`**

| Action | Guard | Behaviour | Audit |
|---|---|---|---|
| `forceSignOutStudent({userId, reason})` | `requireAdminScopeAction` then `requireScopedStudent` | `destroyAllSessions(student.scopedId)` (session.ts:59) | `student.sessions.revoked` (SENSITIVE), with `targetUserId` and `{reason}` |

**`server/actions/admin-plans.ts`.** All use `requireAdminScopeAction`. Every write runs in a transaction that first locks the plan row (`SELECT … FOR UPDATE`) and refuses if `seedManaged` ("Detach from the seed first"). `kind` always comes from the row. Every write calls `revalidatePath` on the admin path plus `PLAN_KINDS[kind].basePath`. All audits are NORMAL with `entityType: "StudyPlan"`.

| Action | Notes |
|---|---|
| `createStudyPlan({kind, slug, title, description, sortOrder})` | Slug validated against the `isPlanSlug` rules (kinds.ts:42); redirects to the plan; audit `plan.created` |
| `updateStudyPlan({planId, title, description, sortOrder})` | Slug cannot change; audit `plan.updated` |
| `setStudyPlanPublished({planId, published})` | Publishing needs `itemsTotal > 0`; audit `plan.published` / `plan.unpublished` |
| `detachPlanFromSeed({planId, reason})` | Sets `seedManaged = false`; audit `plan.detached_from_seed` |
| `addPlanSection`, `renamePlanSection`, `movePlanSection({sectionId, direction})`, `deletePlanSection` | Delete cascades items, then `recountStudyPlan`; audit `plan.section.*` |
| `addPlanItems({planId, sectionId, problemCodes: string[≤50]})` | Only `status PUBLISHED` with `liveVersionId` set; duplicates reported, not errors; `recountStudyPlan`; audit `plan.items.added` |
| `movePlanItem({itemId, sectionId, position})`, `removePlanItem({itemId})` | `recountStudyPlan`; audit `plan.item.moved` / `plan.item.removed` |

**`server/actions/admin-announcements.ts`.** All use `requireAdminScopeAction`, and the audience must satisfy `scopeCovers(scope, audience)`, otherwise `ForbiddenError("That audience is outside your scope.")`.

| Action | Behaviour | Audit |
|---|---|---|
| `saveAnnouncementDraft({id?, title, body, tone, link?, audience, endsAt})` | Only while `publishedAt` is null. `link` must pass `safeNotificationHref` (notifications/model.ts:34). `endsAt` is in the future, at most 30 days. | `announcement.draft_saved` (NORMAL) |
| `publishAnnouncement({id})` | Transaction with `FOR UPDATE`; scope re-checked. Recipients = `listScopedStudentIds(tx, scope, {AND:[audienceWhere(a), {status:{in:ACTIVE_STUDENT_STATUSES}}]})`. `notification.createMany` in chunks of 1,000 with `{userId: scopedId, kind:"announcement", title, body, link, announcementId}`. Sets `publishedAt`, `recipientCount`. Bulk rate limit. `revalidatePath("/", "layout")`. | `announcement.published` (SENSITIVE), with `{recipientCount, audience, tone}` |
| `archiveAnnouncement({id})` | Sets `archivedAt`, which hides the banner. | `announcement.archived` (NORMAL) |

**`server/actions/admin-accommodations.ts`.** Audit metadata never contains `kinds`, `reason` or `decisionNote`. It carries only `{accommodationId, from, to, validUntil, extraTimePercent, extraTimeMinutes, exemptSignals, supersedesId}`.

| Action | Guard | Notes | Audit |
|---|---|---|---|
| `requestAccommodation({userId, terms, reason, supersedesId?, approveNow?})` | `requireAdminScopeAction` then `requireScopedStudent` | Validates terms with `accommodationTermsSchema`. `approveNow` is honoured only when the actor is SUPER_ADMIN (creates APPROVED and supersedes in the same transaction); otherwise it creates REQUESTED. | `accommodation.requested` or `.approved` (SENSITIVE) |
| `withdrawAccommodation({id})` | Scope action; the requester, or SUPER | Only while REQUESTED. | `accommodation.withdrawn` (SENSITIVE) |
| `approveAccommodation({id, note?})` | **`requireSuperAdmin`** then `loadStudentScope` | Transaction. REQUESTED only, `validUntil > now`. With `supersedesId`, the old row goes APPROVED→SUPERSEDED. Without it, an existing APPROVED row means refusal. | `accommodation.approved` (SENSITIVE) |
| `rejectAccommodation({id, note})` | **`requireSuperAdmin`** | Note at least 5 characters. | `accommodation.rejected` (SENSITIVE) |
| `revokeAccommodation({id, reason})` | **`requireSuperAdmin`** | APPROVED→REVOKED. | `accommodation.revoked` (SENSITIVE) |

**Retrofit `server/actions/admin-judge.ts`:**
- `rejudgeSubmission` (:128) loads the scope and adds an in-scope check (`tx.submission.findFirst({ where: { id, user: scopedStudentWhere(scope) } })`) after the `FOR UPDATE`. An out-of-scope submission gives NotFound.
- `grantJudgeQuotaOverride` (:327) becomes `db.user.findFirst({ where: scopedStudentWhere(scope, { collegeId: { equals, mode: "insensitive" } }) })`. SUPER has scope ALL, so behaviour is unchanged apart from staff being excluded.

---

## 7. Library and query modules (new)

**Pure modules**
- `lib/admin/cohort.ts`: `cohortKeySchema`, `parseCohortParam(raw)`, `formatCohort(c)`, `cohortKey(c)`.
- `lib/admin/student-filters.ts`: `studentFiltersSchema`, `parseStudentFilters(searchParams)`, `filtersToWhere(f): Prisma.UserWhereInput` (passed as `extra`).
- `lib/admin/roster-csv.ts`: `parseRosterCsv(text): { header: string[]; rows: {line:number; cells:Record<string,string>}[]; errors: {line; message}[] }`. RFC 4180 (quotes, CRLF, BOM, embedded newlines), exact header match on `ROSTER_COLUMNS`, row and byte limits. No new dependency.
- `lib/admin/roster-plan.ts`:
  - `type RosterOutcome = CREATE | UPDATE{userId, changes: FieldChange[], link: boolean} | UNCHANGED | SKIPPED{reason: "ACCOUNT_NOT_ACTIVE"} | REJECTED{reason: "INVALID_ROW"|"MISSING_LMS_ID"|"DUPLICATE_IN_FILE"|"KEY_CONFLICT"|"STAFF_ACCOUNT"|"OUTSIDE_SCOPE"|"ROLL_NUMBER_CHANGED"}`.
  - `planRosterImport(rows, matches: ExistingUser[], scope): RosterPlan`. For OUTSIDE_SCOPE, a CREATE needs the new cohort covered; an UPDATE needs both the old and new cohort covered.
  - `rosterPlanSha256(plan)` (canonical JSON sorted by line, including each matched user's `updatedAt`).
  - `proposeHandle(first, last, taken: ReadonlySet<string>)` gives `priya-s`, `priya-s-2`, …, never derived from `collegeId`.
- `lib/admin/announcement-audience.ts`: `audienceSchema`, `audienceWhere(a): Prisma.UserWhereInput`, `audienceCohort(a)`.

**Database-backed modules**
- `lib/admin/roster.ts` (`server-only`): `loadRosterMatches(client, rows)` (three `IN` queries over `scopedStudentWhere(ALL-for-match)`, which is not right as stated; see the note below) and `applyRosterPlan(tx, plan, scope, actorId): RosterResults`.
  - Note on matches: conflicts must be detected even against users outside the admin's scope, without returning their data. Match lookups therefore select only `{id, role, status, lmsUserId, collegeId, email, batchYear, departmentCode, updatedAt}`, and use `staffOnlyWhere` for the staff check plus a scoped query for students. An out-of-scope match yields `OUTSIDE_SCOPE` with no detail.
  - This module has one exact-count fence exemption for the unscoped key lookup, alongside `user.createMany`.
- `lib/plans/recount.ts`: no `server-only` marker, so scripts can import it. `recountStudyPlan(tx: DbTx, planId: string): Promise<{itemsTotal}>`.
  - Sets `StudyPlan.itemsTotal = count(items)`.
  - Then one `UPDATE "StudyPlanEnrollment" e SET itemsTotal, itemsDone = (correlated count of items ⋈ UserProblemStatus SOLVED for e.userId), completedAt = CASE complete THEN COALESCE(e.completedAt, now()) ELSE NULL END WHERE e."planId" = …`.
  - Semantics match scripts/content/study-plans.ts:190-213.
- Admin query modules, all taking `scope`:
  - `server/queries/admin-overview.ts`
  - `admin-students.ts` (`listStudents`, `getStudentDetail(student: ScopedStudent)`)
  - `admin-cohorts.ts`
  - `admin-reports.ts`. Sections, each a scoped `$queryRaw` with `scopedStudentSql`:
    - Per-cohort table: students, active in 7 days, zero-solve, median solved, assisted share, from User ⋈ UserStats.
    - Weekly active students over 8 campus weeks, from ActivityDay ⋈ User.
    - Weekly solves, from WEEK XpBucket ⋈ User.
    - Difficulty split (UserStats).
    - Topic coverage (`jsonb_each_text(topicSolved/topicAssisted)`, labels from `TOPIC_LABEL`).
    - Problems the cohort finds hardest: UserProblemStatus ⋈ User, at least 5 attempters, bottom 15.
    - Plan progress (StudyPlanEnrollment ⋈ User).
    - Streak buckets (UserStats.currentStreak).
  - `admin-plans.ts` (enrolment counts via `studyPlanEnrollment.groupBy({ where: { user: scopedStudentWhere(scope) } })`; problem picker over Problem, not fenced)
  - `admin-announcements.ts`
  - `admin-accommodations.ts`
  - `admin-roster.ts`
- `server/queries/announcements.ts` (student side, viewer's own rows): `getActiveAnnouncements(userId, now)` = `notification.findMany({ where: { userId, readAt: null, announcement: { archivedAt: null, endsAt: { gt: now } } }, orderBy: { createdAt: "desc" }, take: 3 })`. Served by the existing `[userId, readAt, createdAt DESC]` index.

**Retrofit `server/queries/admin-judge.ts`**
- `loadJudgeHealth(scope, now)` (:561). `loadStuckSubmissions(scope, now)` (:382) drops `user` from `stuckSelect` (:328-342), adds `userId`, and resolves identities with `db.user.findMany({ where: scopedStudentWhere(scope, { id: { in } }) })`.
- `StuckSubmissionRow` gains `inScope: boolean`; `collegeId` and `studentName` become `string | null`.
- `activeQuotaOverrides` (:496) adds `user: scopedStudentWhere(scope)`. Grantor names (:515-519) use `staffOnlyWhere({ id: { in: grantorIds } })`.
- `components/admin/stuck-table.tsx` shows "Outside your scope" and no Rejudge button when `!inScope`.

---

## 8. Shell, navigation and components

- **`components/admin/admin-nav.ts`** (new, pure data, modelled on shell/nav.ts): `ADMIN_NAV_GROUPS`:
  - Overview: `/admin` (exact)
  - People: `/admin/students`, `/admin/cohorts`, `/admin/accommodations`
  - Content: `/admin/sheets`, `/admin/tracks`, `/admin/announcements`. The authoring stream inserts `/admin/problems` here.
  - Insight: `/admin/reports`
  - Operations: `/admin/judge`
- **`components/admin/admin-shell.tsx`.** Replace the single top-bar `NAV` (:14, :32) with:
  - a left sidebar at 1024 px and wider (`<nav aria-label="Admin">`, vertical `AdminNavLinks` client leaf with `aria-current`);
  - a no-JS `<details>` menu below 1024 px;
  - a scope chip in the top bar (`describeScope(scope)`). `AdminShell` gets `scope` from the layout, which calls `loadStudentScope(user)`.
  - For SUPER only, a "Super-admin console" link to `/super`. This waits until the super stream's page exists; the nav test enforces it.
- **`app/admin/error.tsx`** (line 15): the copy "while reading the judge's state" becomes "while loading this admin page".
- **New components:**
  - `components/admin/students/{student-table,student-filters,status-notice}.tsx`
  - `roster/{import-form (client), diff-table, commit-form (client)}.tsx`
  - `plans/{plan-index,plan-meta-form (client),section-editor (client),item-picker (client)}.tsx`
  - `announcements/{announcement-form (client),announcement-list}.tsx`
  - `accommodations/{accommodation-form (client),accommodation-list,decision-panel (client)}.tsx`
  - `reports/{bar-table,report-section}.tsx`: CSS-width bars, every figure also a `<table>`, no chart library.
  - No Monaco anywhere; `size-budgets.json` `monacoFree.entryPrefixes: ["/admin/"]` already covers these routes.
- **Student side:**
  - New `components/dashboard/announcement-banner.tsx` (server). It is a `role="region"` with `aria-label="Announcements"`; IMPORTANT uses `bg-warning-subtle text-warning` with an icon and the text "Important" (never colour alone); the body is rendered as text with `whitespace-pre-line`; the link goes through `safeNotificationHref`.
  - Dismiss uses the existing `MarkReadButton` (app/(student)/notifications/read-buttons.tsx:9). I recommend moving it to `components/notifications/read-buttons.tsx` and updating the notifications page import.
  - `app/(student)/dashboard/page.tsx` adds `getActiveAnnouncements(user.id, now)` to its fetch and renders the banner above the first grid (:37).

---

## 9. Seed and content (`apps/web/scripts`)

- **`seed.ts`:**
  - Add `ADMIN_SCOPED` (`RECADMIN02`, role ADMIN, `SEED_ADMIN_PASSWORD`). `SeedUser.role` widens to include `"ADMIN"`.
  - Add an idempotent AdminScope grant `{departmentCode: "CSE", batchYear: null}`.
  - Add two ECE/2026 students (`2116226002001`, `…002`) so the fence is visible by hand.
  - Log lines are updated to match.
- **`scripts/content/study-plans.ts`:**
  - Create sets `seedManaged: true`.
  - `syncPlan` skips any existing row with `seedManaged = false` and logs "detached".
  - The enrolment loop (:190-213) is replaced by `recountStudyPlan(tx, planId)` (relative import of `src/lib/plans/recount`).

---

## 10. Tests that prove this stream's Phase 4 items

| Test | Proves |
|---|---|
| `tests/repo/admin-scope.test.ts` | The fence R1–R10 with self-tests (flag and no-flag snippets per rule), STUDENT_MODELS completeness against schema.prisma, and exact exemption counts. This is the spec's "build-breaking query-shape test". |
| `apps/web/test/admin-scope.test.ts` | `buildStudentScope` (SUPER gives ALL; a both-null grant gives ALL; no grants matches nothing via `id in []`; non-admin throws). `scopedStudentWhere` shapes for dept-only, batch-only, both and multiple grants (OR), always `role STUDENT`, `extra` AND-ed. `scopedStudentSql` text and params; empty gives FALSE; a bad alias throws. `scopeCovers` truth table including null cohorts. `describeScope`. |
| `apps/web/test/admin-scope.db.test.ts` (`RECX_DB_TESTS=1`) | Students in CSE-2027, CSE-2026 and ECE-2027, plus staff. An ADMIN with grant CSE/\* sees only CSE in `listStudents`, `listCohorts` and `getCohortReport`. `requireScopedStudent` on an ECE id gives NotFound. A revoked grant gives nothing. SUPER sees every student and no staff. A duplicate active grant is rejected by the partial unique index. |
| `apps/web/test/roster-csv.test.ts` | Quoting, CRLF, BOM, embedded comma and newline, header mismatch, the 5,000-row and 900 KB limits. |
| `apps/web/test/roster-plan.test.ts` | Every outcome: CREATE, UPDATE (changed fields), LINK, UNCHANGED, SKIPPED, and REJECTED for MISSING_LMS_ID, duplicates, key conflict, staff, OUTSIDE_SCOPE (old cohort and new cohort), ROLL_NUMBER_CHANGED. Hash determinism and sensitivity to `updatedAt`. `proposeHandle` collisions. |
| `apps/web/test/roster-import.db.test.ts` | Preview writes zero User rows (count and `updatedAt` unchanged), so the dry run really is dry. Commit applies exactly the plan. A user changed between preview and commit gives refusal. Expired previews are refused. Rows are null after commit. Created users have `passwordHash` null, role STUDENT and `lmsUserId` set. Only open-period XpBucket rows get the new cohort. |
| `apps/web/test/admin-rbac.test.ts` | Table `ADMIN_ACTION_MATRIX` over every new action plus the retrofitted judge actions. STUDENT, TA_MENTOR and PLACEMENT_OFFICER get ForbiddenError. ADMIN is allowed except approve, reject and revoke accommodation, which call `requireSuperAdmin`. Every successful mutation calls `audit` with the expected action and sensitivity. Accommodation audit metadata never has `kinds` or `reason` keys. This is my rows of the role × capability matrix. |
| `packages/shared/test/accommodation.test.ts` | Schema refinements and bounds; `suggestedExemptSignals(["SCREEN_READER"])` includes FOCUS_LOSS and FULLSCREEN_EXIT; `reviewerAccommodationView` keys are exactly `["exemptSignals"]`; the `accommodatedDurationSec` formula. |
| `apps/web/test/accommodations.db.test.ts` | One APPROVED and one REQUESTED per user (partial indexes). CHECK constraints. The trigger refuses term edits and deletes after grant. Supersede is atomic. |
| `apps/web/test/announcements.test.ts` and `.db.test.ts` | An audience not covered by scope is refused. Fan-out goes only to in-scope ACTIVE/SOFT_RESTRICTED audience members. The dashboard query returns unread live rows only. Archive hides the banner. An off-site link is rejected. |
| `apps/web/test/admin-plans.db.test.ts` | Add and remove recounts the plan and enrolments. Unpublished problems are refused. A `seedManaged` plan is refused until detached. The seed sync skips detached plans. |
| `apps/web/test/admin-nav.test.ts` (extract `implementedRoutes` from test/shell-nav.test.ts:23 into `test/support/routes.ts`) | Every admin nav href has a `page.tsx`, and `/admin/discuss` is not linked. |
| `packages/db/test/enum-parity.test.ts` | ProctorEventKind and AccommodationKind parity. |
| `apps/web/e2e/a11y.spec.ts` (:106) | Add `/admin`, `/admin/students`, `/admin/students/import`, `/admin/reports`, `/admin/accommodations` and `/admin/announcements/new`, with zero serious or critical findings. |
| `apps/web/test/admin-judge.test.ts` | Update the mocks for the scope, and add a case where an out-of-scope rejudge gives NotFound. |

**Manual steps for RUNBOOK**, dated:
1. As RECADMIN02, `/admin/students` shows CSE only, and an ECE id URL gives 404.
2. Import a mixed CSV. The preview rejects the ECE rows and the row without `lmsUserId`. Edit a matched student in the database, and the commit is refused. Re-preview and commit.
3. Publish an announcement to CSE 2027. A student sees the banner and the bell; dismissing clears the banner.
4. RECADMIN02 requests an accommodation and it shows REQUESTED. RECADMIN01 approves it. Check that the audit rows carry no kinds.

---

## 11. Interactions and conflicts with other streams

1. **schema.prisma and migrations.** The authoring stream (ProblemStatus APPROVED, ProblemDraft, …), the super stream (PrivilegedOperation, …) and this stream all edit it. One integrator should merge `schema.prisma` and generate the Phase 4 migrations in sequence. My hand-written SQL (§1) is appended to my migration only. `User` back-relations from several streams must be merged by hand.
2. **AdminScope ownership.** This stream defines the model and every read path. The **super stream writes it** (`/super/roles`, `requireSuperAdmin`, audited SECURITY) and must not redefine the model. It must create rows only for role ADMIN and revoke with `revokedAt` (never delete). It should list department codes from `User.departmentCode`.
3. **`lib/auth/guards.ts`.** I do not edit it. `scope.ts` composes `requirePageRole`, `requireActionRole` and `requireSuperAdmin`. The super stream's `capabilities.ts` (referenced in guards.ts:61):
   - Must not count accommodation approval among the twelve. The spec fixes the list at twelve, and approval is separately "Super-admin approval only" (spec line 515).
   - Its matrix test should still assert that `approveAccommodation`, `rejectAccommodation` and `revokeAccommodation` call `requireSuperAdmin()`.
4. **Status changes.** The student detail page links SUPER viewers to the super stream's user page. That needs agreement on the route: `/super/users/[id]` or `/super/users?q=<collegeId>`. Nothing in this stream changes status, so there is no PrivilegedOperation dependency.
5. **Admin layout and shell.** I own `components/admin/admin-nav.ts` and the new shell. The authoring stream adds a single `/admin/problems` entry. Its pages must also call `requireAdminScopePage()` (fence R8), even though problem content is not scoped. `/super` has its own layout (super stream).
6. **`@recx/shared` `index.ts`.** Three appended export lines; they merge trivially with the FUNCTION-harness exports.
7. **`/admin/judge` (Phase 2 code)** changes behaviour for scoped admins: identities are redacted and rejudge is limited to in-scope students. A stream adding global rejudge (super plus PrivilegedOperation) is unaffected, because SUPER has scope ALL.
8. **`scripts/seed.ts`** is also edited by the authoring stream, which seeds problems. My edits are limited to the users and scope blocks.
9. **`e2e/support/accounts.ts`** gets a scoped admin account, which shared e2e setup uses.

---

## 12. OPEN-QUESTIONS entries to add (Phase 4, admin)

1. **Imported accounts cannot sign in yet.** The roster import copies LMS identities only, and imported accounts have no password until LMS OIDC (Phase 10). Revisit with an interim, audited super-admin password-set flow.
2. **What the import never does.** It never changes role or status, never deactivates students absent from the file, and treats roll-number changes and key conflicts as super-admin work.
3. **`/admin/discuss` is not built.** It ships with Phase 11 discussion and TA_MENTOR moderation.
4. **Cohorts are derived.** They come from LMS-owned User columns; there is no Cohort model.
5. **AdminScope boundaries.**
   - Scope is department and/or batch only; section is not a dimension.
   - No rows means no access.
   - `/admin/judge` fleet aggregates are exempt; identities are redacted outside scope.
   - Rejudge is limited to in-scope students.
6. **Plans.** Sheets and tracks are college-wide content with no audience targeting. There is no delete (unpublish instead), slugs cannot change, and seed-managed plans are read-only until detached. `completedAt` is cleared when a plan grows, which matches the seed sync but differs from `enroll()` (plans.ts:83, COALESCE).
7. **Accommodations.**
   - ADMIN requests and SUPER approves. Requester ≠ approver is not enforced (the spec does not ask for it).
   - Kinds and reason are never written to audit metadata.
   - There is no document upload.
   - The suggested exempt signals for MAGNIFIER and SPEECH_INPUT are inferences.
   - The bounds extraTimeMinutes ≤ 240, breakMinutes ≤ 120 and validity ≤ 400 days are invented.
   - ProctorEventKind is declared now (24 kinds verbatim); whether SNAPSHOT_JUMP is a kind is left to Phase 6.
8. **Announcements.** Plain text, no scheduling, fan-out at publish time only. Students imported later do not receive them, and published text cannot change.
9. **Reports.** ACTIVE and SOFT_RESTRICTED students only. No export, because a PII export is super-only with a PrivilegedOperation.
10. **Admin student detail.**
    - No status changes for ADMIN.
    - Submission metadata only, no source code.
    - Notes and drafts are never readable.
11. **Student search.** Exact roll number or email, or a name prefix. No trigram index at about 5,000 rows.