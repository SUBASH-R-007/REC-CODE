# Phase 4 design: super-admin governance stream

## 0. Key decisions

- **Where the capability constant lives:** `apps/web/src/lib/auth/capabilities.ts`. `guards.ts:61` already points there. The entries name web server-action files, so the constant cannot go in `packages/shared`, which the judge-worker imports. The module is pure data: it has no `server-only` import and only type-imports `Role` from `@recx/db`, so tests and `tests/repo` can read it.
- **Capabilities from later phases:** ratings (Phase 5), integrity overturn (Phase 6) and calendar/MEDICAL leave (Phase 8) are declared with `arrives: { phase, models }` and an empty action list. A test fails as soon as one of those models appears in `schema.prisma` and the capability is still not wired. Nothing is stubbed.
- **Read-only impersonation:** enforced inside `requireActionUser()`. `requireActionRole` and `requireSuperAdmin` both go through it, as do both mutating route handlers (`/api/drafts`, `/api/activity`). I did not put the check in `runAction`, because route handlers don't use it and it can't tell reads from writes. A static test and a runtime sweep prove that every action calls its guard first.
- **Impersonation state:** stored as a pointer on the super-admin's own `Session` row. `getCurrentUser()` returns the target user with an extra optional `impersonation` field. Existing mocks that return a plain `User` keep working (`notes-actions.db.test.ts:25`, `shell-data.db.test.ts:28`).
- **Email:** a transactional `EmailOutbox` table, drained by the scheduler. Transports are `smtp`, `log` (refused in production) and `disabled`. In production without SMTP, rows stay `PENDING` and `/super` shows a danger alert. Break-glass also always writes in-app `Notification` rows.
- **Audit append moves into `@recx/db`.** This resolves the "move audit into a shared server-only package" item at `OPEN-QUESTIONS.md:298-300`. The scheduler can then audit impersonation expiry, privileged-operation expiry and failed security emails. The `@/lib/audit` API stays the same, so other streams are not affected.

---

## 1. Files

### Create (`apps/web/src`)

- `lib/auth/capabilities.ts`
- `lib/auth/impersonation.ts`
- `lib/flags.ts`
- `lib/outbox.ts`
- `lib/accounts/status.ts` (pure)
- `lib/privileged/payloads.ts`
- `lib/privileged/policy.ts` (pure)
- `lib/privileged/operations.ts`
- `lib/privileged/executors/bulk-status.ts`
- `lib/privileged/executors/global-rejudge.ts`
- `lib/privileged/executors/submission-purge.ts`
- `lib/privileged/executors/problem-delete.ts`
- `lib/privileged/executors/pii-export.ts`
- `lib/judge/rejudge.ts`
- `lib/judge/node-token.ts`
- Server actions in `server/actions/`:
  - `super-users.ts`
  - `super-roles.ts`
  - `super-settings.ts`
  - `super-flags.ts`
  - `super-branding.ts`
  - `super-judge.ts`
  - `super-audit.ts`
  - `super-impersonate.ts`
  - `super-xp.ts`
  - `super-problems.ts`
  - `super-data.ts`
  - `super-integrations.ts`
  - `privileged.ts`
- Queries: `server/queries/super-dashboard.ts`, `super-users.ts`, `super-audit.ts`, `super-jobs.ts`, `super-data.ts`
- Routes in `app/super/`:
  - `layout.tsx`, `error.tsx`, `page.tsx`
  - `users/page.tsx`, `roles/page.tsx`
  - `settings/branding/page.tsx`, `settings/policy/page.tsx`, `settings/judge/page.tsx`, `settings/integrations/page.tsx`
  - `audit/page.tsx`, `impersonate/page.tsx`, `flags/page.tsx`, `jobs/page.tsx`, `data/page.tsx`
  - `data/exports/[id]/route.ts`
- Components in `components/super/`:
  - `super-shell.tsx`, `super-strip.tsx`, `nav.ts`
  - Client leaves: `status-dialog.tsx`, `bulk-status-form.tsx`, `role-form.tsx`, `scope-form.tsx`, `branding-form.tsx`, `xp-rules-form.tsx`, `legal-hold-form.tsx`, `flag-toggle.tsx`, `rotate-token-button.tsx`, `impersonate-form.tsx`, `operation-card.tsx`, `audit-verify-button.tsx`, `pii-export-form.tsx`, `purge-form.tsx`, `xp-ledger.tsx`
- `components/impersonation/impersonation-banner.tsx`

### Create (elsewhere)

- `packages/shared/src/governance.ts`
- `packages/db/src/audit-chain.ts` (moved from web) and `packages/db/src/audit.ts`
- Scheduler: `apps/scheduler/src/mail.ts`, `outbox.ts`, `governance.ts`, `job-status.ts`
- Migration `packages/db/prisma/migrations/<ts>_phase4_governance/` (the orchestrator assigns the timestamp)
- Tests (section 9)

### Modify

| File | Change |
|---|---|
| `schema.prisma` | Additions in section 2 |
| `packages/db/package.json` | Exports `"./audit"`, `"./audit-chain"` |
| `packages/shared/src/index.ts` | Add `export * from "./governance";` |
| `lib/auth/session.ts` | `getCurrentUser` return type; `destroySession` ends a live impersonation; `currentSessionId()` |
| `lib/auth/guards.ts` | `requireActionUser` read-only check; new `requireImpersonator()` |
| `lib/errors.ts` | `ImpersonationReadOnlyError` and its message constant |
| `lib/audit.ts` | Delegates to `@recx/db/audit`; adds `auditMany` |
| `lib/audit-chain.ts` | Re-exports from `@recx/db/audit-chain` |
| `server/actions/auth.ts` | `logout()` attributes to the impersonator |
| `server/actions/admin-judge.ts:135-187` | Reset moves to `lib/judge/rejudge.ts` |
| `scripts/judge-node.ts:72-73` | Uses `generateNodeToken()` |
| `components/admin/admin-shell.tsx:59` | `/super` link when `role === SUPER_ADMIN` |
| `app/layout.tsx:77` | `<ImpersonationBanner/>` before `<ToastProvider>` |
| `apps/scheduler/src/main.ts:121-148`, `config.ts`, `classify.ts:166-172` | Shared retention key/schema, outbox + governance jobs, job status |
| `apps/scheduler/package.json` | Add `nodemailer` and `@types/nodemailer` (new dependency, needs approval) |
| Docs | `OPEN-QUESTIONS`, `SECURITY` §8/new §, `RUNBOOK`, `ARCHITECTURE`, `.env.example` (`MAIL_TRANSPORT`, `SMTP_URL`, `MAIL_FROM`) |

---

## 2. Prisma additions

No `@@map`. Actor IDs are plain `String` columns, following the existing pattern (`PlatformSetting.updatedById`, `JudgeQuotaOverride.grantedById`), so `User` only gains one relation.

```prisma
enum PrivilegedOperationKind {
  BULK_STATUS_CHANGE
  SUBMISSION_PURGE
  GLOBAL_REJUDGE
  PII_EXPORT
  PROBLEM_DELETE
  VERSION_DELETE
}
// RATING_RECOMPUTE is added by Phase 5 (ALTER TYPE ADD VALUE).

enum PrivilegedOperationStatus {
  PENDING
  APPROVED
  EXECUTING
  EXECUTED
  FAILED
  REJECTED
  CANCELLED
  EXPIRED
}

enum ImpersonationEndReason {
  ENDED
  EXPIRED
  SIGNED_OUT
  REVOKED
}

enum OutboxStatus {
  PENDING
  SENDING
  SENT
  FAILED
}

/// Department/batch scope of an ADMIN. null = all departments / all batches.
/// Folded into admin student queries by the admin-surface stream. Granted and
/// revoked only by SUPER_ADMIN. Duplicates are refused in the grant action
/// under an advisory lock (no nullable unique, so the migrate-diff drift
/// check stays clean).
model AdminScope {
  id             String   @id @default(cuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id])
  departmentCode String?
  batchYear      Int?
  grantedById    String
  reason         String
  createdAt      DateTime @default(now())

  @@index([userId])
}

/// Two-person approval: requester ≠ approver (CHECK), 24 h expiry (CHECK).
/// Break-glass self-approval is SECURITY-audited and emailed to every
/// super-admin. Request fields are immutable (trigger); the approver
/// approves payloadSha256.
model PrivilegedOperation {
  id                     String                    @id @default(cuid())
  kind                   PrivilegedOperationKind
  status                 PrivilegedOperationStatus @default(PENDING)
  payload                Json
  payloadSha256          String
  summary                String
  affectedCount          Int
  reason                 String
  requestedById          String
  requestedAt            DateTime                  @default(now())
  expiresAt              DateTime
  decidedById            String?
  decidedAt              DateTime?
  decisionNote           String?
  breakGlass             Boolean                   @default(false)
  executionStartedAt     DateTime?
  executedAt             DateTime?
  result                 Json?
  error                  String?
  /// PII_EXPORT: download window and counter. The file is never stored.
  artifactAvailableUntil DateTime?
  artifactDownloads      Int                       @default(0)

  @@index([status, expiresAt])
  @@index([requestedById, requestedAt(sort: Desc)])
  @@index([kind, requestedAt(sort: Desc)])
}

/// Read-only view as another user. At most 15 minutes, reason mandatory,
/// audited on start and on end.
model ImpersonationSession {
  id             String                  @id @default(cuid())
  impersonatorId String
  targetUserId   String
  reason         String
  startedAt      DateTime                @default(now())
  expiresAt      DateTime
  endedAt        DateTime?
  endReason      ImpersonationEndReason?
  session        Session?

  @@index([impersonatorId, startedAt(sort: Desc)])
  @@index([targetUserId, startedAt(sort: Desc)])
  @@index([endedAt, expiresAt])
}

/// Transactional outbox for security email, drained by apps/scheduler.
/// The address is resolved from User at send time and never logged.
model EmailOutbox {
  id            String       @id @default(cuid())
  kind          String
  toUserId      String
  subject       String
  bodyText      String       @db.Text
  status        OutboxStatus @default(PENDING)
  attempts      Int          @default(0)
  nextAttemptAt DateTime     @default(now())
  lockedUntil   DateTime?
  lastError     String?
  transport     String?
  entityType    String?
  entityId      String?
  createdAt     DateTime     @default(now())
  sentAt        DateTime?

  @@index([status, nextAttemptAt])
  @@index([entityType, entityId])
}

/// Upserted after every scheduler job tick (never in --dry-run). Read by /super/jobs.
model SchedulerJobStatus {
  job                 String    @id
  instance            String
  lastStartedAt       DateTime
  lastFinishedAt      DateTime?
  lastOk              Boolean
  lastError           String?
  lastReport          Json      @default("{}")
  consecutiveFailures Int       @default(0)
  updatedAt           DateTime  @updatedAt
}
```

Changes to existing models:

- `User`: add `adminScopes AdminScope[]`.
- `Session`:
  ```prisma
  impersonationId String?               @unique
  impersonation   ImpersonationSession? @relation(fields: [impersonationId], references: [id], onDelete: SetNull)
  ```

Hand-written SQL to append to the migration:

```sql
ALTER TABLE "PrivilegedOperation"
  ADD CONSTRAINT "PrivilegedOperation_two_person"
    CHECK ("decidedById" IS NULL OR "breakGlass" = ("decidedById" = "requestedById")),
  ADD CONSTRAINT "PrivilegedOperation_expiry"
    CHECK ("expiresAt" <= "requestedAt" + interval '24 hours');

ALTER TABLE "ImpersonationSession"
  ADD CONSTRAINT "ImpersonationSession_box"
    CHECK ("expiresAt" <= "startedAt" + interval '15 minutes'),
  ADD CONSTRAINT "ImpersonationSession_not_self"
    CHECK ("impersonatorId" <> "targetUserId");

CREATE OR REPLACE FUNCTION recx_refuse_privileged_request_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PrivilegedOperation % cannot be deleted', OLD."id";
  END IF;
  IF (NEW."kind", NEW."payload", NEW."payloadSha256", NEW."summary", NEW."affectedCount",
      NEW."reason", NEW."requestedById", NEW."requestedAt", NEW."expiresAt")
     IS DISTINCT FROM
     (OLD."kind", OLD."payload", OLD."payloadSha256", OLD."summary", OLD."affectedCount",
      OLD."reason", OLD."requestedById", OLD."requestedAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'PrivilegedOperation % request fields are immutable', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "PrivilegedOperation_request_immutable"
  BEFORE UPDATE OR DELETE ON "PrivilegedOperation"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_privileged_request_change();
```

---

## 3. Shared modules and exact exports

### `packages/shared/src/governance.ts`

Cross-process constants only: no I/O and no Prisma.

```ts
export const RETENTION_SETTING_KEY = "retention";
export const retentionSettingSchema = z.object({
  legalHold: z.boolean().optional(),
  legalHoldReason: z.string().max(500).optional(),
  legalHoldChangedAt: z.string().datetime().optional(),
  legalHoldChangedById: z.string().max(64).optional(),
}).passthrough();               // keeps the scheduler's current semantics (classify.ts:172)
export type RetentionSetting = z.infer<typeof retentionSettingSchema>;

export const FLAGS_SETTING_KEY = "flags";
export const FEATURE_FLAGS = {
  impersonation:          { default: true, label: "Impersonation", description: "Super-admins may start a read-only, 15-minute impersonation." },
  breakGlassSelfApproval: { default: true, label: "Break-glass self-approval", description: "A super-admin may self-approve a privileged operation; SECURITY-audited and emailed to every super-admin." },
} as const;
export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;
export const featureFlagsSettingSchema = z.record(z.string(), z.boolean());
export function effectiveFeatureFlags(value: unknown): Readonly<Record<FeatureFlagKey, boolean>>; // unknown keys ignored, invalid → defaults

export const IMPERSONATION_MAX_MS = 15 * 60_000;
export const IMPERSONATION_REASON_MIN = 20;
export const PRIVILEGED_APPROVAL_TTL_MS = 24 * 3_600_000;
export const PRIVILEGED_EXECUTION_STALE_MS = 15 * 60_000;
export const BULK_STATUS_DIRECT_MAX = 25;
export const BULK_STATUS_MAX = 5_000;
export const GLOBAL_REJUDGE_MAX = 25_000;
export const PII_EXPORT_WINDOW_MS = 24 * 3_600_000;
export const PII_EXPORT_MAX_DOWNLOADS = 3;
export const SECURITY_EMAIL_KIND_PREFIX = "security.";
export const SCHEDULER_JOB_NAMES = ["reconciler", "dailyChallenge", "leaderboardFreeze", "outbox", "governance"] as const;
export type SchedulerJobName = (typeof SCHEDULER_JOB_NAMES)[number];
```

`apps/scheduler/src/classify.ts:166-172` then re-exports `RETENTION_SETTING_KEY` and uses `retentionSettingSchema` from `@recx/shared`, so there is one source.

### `packages/db/src/audit-chain.ts` and `audit.ts`

`audit-chain.ts` is moved verbatim from `apps/web/src/lib/audit-chain.ts`, plus one addition:

```ts
export function createChainVerifier(day: string): {
  push(row: ChainEntry & { prevHash: string; hash: string }): boolean;
  readonly count: number;
  readonly firstBadIndex: number;        // -1 when intact
  readonly terminalHash: string;
};
```

`audit.ts`:

```ts
export interface AuditEntryInput {
  actorId: string | null; action: string; entityType: string;
  entityId?: string | null; targetUserId?: string | null;
  sensitivity?: AuditSensitivity; metadata?: Prisma.InputJsonValue; ipHash?: string | null;
}
/** One transaction, one advisory lock per chainDay, createMany. Throws; callers decide. */
export async function appendAuditEntries(client: Db, entries: readonly AuditEntryInput[]): Promise<void>;
```

In the web app, `lib/audit.ts` keeps `audit(entry): Promise<void>` (never throws) and adds `auditMany(entries): Promise<void>`. Metadata rule: ISO strings only, never `Date` objects. `canonicalJson` hashes a `Date` as `{}`, which would make the jsonb round-trip fail verification; a test covers this.

### `apps/web/src/lib/auth/capabilities.ts`

```ts
import type { PrivilegedOperationKind, Role } from "@recx/db";

export const ROLES = ["STUDENT", "TA_MENTOR", "ADMIN", "PLACEMENT_OFFICER", "SUPER_ADMIN"] as const satisfies readonly Role[];
export type ActionRef = `${string}#${string}`;                      // "<src/server/actions file>#<export>"
export type RouteRef  = `app/${string}/route.ts#${"GET" | "POST"}`;
export type PageRef   = `app/${string}/page.tsx`;

export interface Capability<K extends string = string> {
  readonly key: K; readonly label: string; readonly roles: readonly Role[];
  readonly actions: readonly ActionRef[]; readonly routes?: readonly RouteRef[]; readonly pages?: readonly PageRef[];
  readonly privileged?: readonly PrivilegedOperationKind[];
  readonly arrives?: { readonly phase: 5 | 6 | 8; readonly models: readonly string[] };
}

export const SUPER_ADMIN_CAPABILITY_KEYS = [
  "roles.manage", "settings.write", "accounts.status", "problems.lifecycle", "ratings.manage",
  "integrity.overturn", "audit.readFull", "users.impersonate", "judge.rotateKeys", "pii.export",
  "calendar.manage", "xp.void",
] as const;
export type SuperAdminCapabilityKey = (typeof SUPER_ADMIN_CAPABILITY_KEYS)[number];

/** THE twelve SUPER_ADMIN-exclusive capabilities (spec Phase 4). */
export const SUPER_ADMIN_CAPABILITIES: readonly Capability<SuperAdminCapabilityKey>[] = [
  { key: "roles.manage",       actions: ["super-roles#setUserRole", "super-roles#grantAdminScope", "super-roles#revokeAdminScope"], pages: ["app/super/roles/page.tsx"] },
  { key: "settings.write",     actions: ["xp-settings#updateXpRules", "super-settings#setLegalHold", "super-flags#setFeatureFlag", "super-branding#saveBrandTheme"],
                               pages: ["app/super/settings/policy/page.tsx", "app/super/flags/page.tsx", "app/super/settings/branding/page.tsx"] },
  { key: "accounts.status",    actions: ["super-users#setAccountStatus", "super-users#bulkSetAccountStatus", "super-users#requestBulkStatusChange"],
                               privileged: ["BULK_STATUS_CHANGE"], pages: ["app/super/users/page.tsx"] },
  { key: "problems.lifecycle", actions: ["super-problems#retireProblem", "super-problems#requestProblemDeletion", "super-problems#requestVersionDeletion", "super-judge#requestGlobalRejudge"],
                               privileged: ["PROBLEM_DELETE", "VERSION_DELETE", "GLOBAL_REJUDGE"] },
  { key: "ratings.manage",     actions: [], arrives: { phase: 5, models: ["Contest", "RatingChange"] } },
  { key: "integrity.overturn", actions: [], arrives: { phase: 6, models: ["IntegrityFlag"] } },
  { key: "audit.readFull",     actions: ["super-audit#verifyAuditChainDay"], pages: ["app/super/audit/page.tsx"] },
  { key: "users.impersonate",  actions: ["super-impersonate#startImpersonation"], pages: ["app/super/impersonate/page.tsx"] },
  { key: "judge.rotateKeys",   actions: ["super-judge#rotateJudgeNodeToken"], pages: ["app/super/settings/judge/page.tsx"] },
  { key: "pii.export",         actions: ["super-data#requestPiiExport"], routes: ["app/super/data/exports/[id]/route.ts#GET"],
                               privileged: ["PII_EXPORT"], pages: ["app/super/data/page.tsx"] },
  { key: "calendar.manage",    actions: [], arrives: { phase: 8, models: ["CalendarDay", "LeaveException"] } },
  { key: "xp.void",            actions: ["super-xp#voidXpEvent"], pages: ["app/super/users/page.tsx"] },
].map(c => ({ ...c, roles: ["SUPER_ADMIN"] }))  /* deep-frozen; labels omitted here */;

export const STAFF_CAPABILITIES = [
  { key: "judge.operate", roles: ["ADMIN", "SUPER_ADMIN"],
    actions: ["admin-judge#setJudgeNodeStatus", "admin-judge#rejudgeSubmission", "admin-judge#setLanguageEnabled"] },
] as const;  // the admin and authoring streams append their entries here

/** Super-only actions that are not one of the twelve (each still guarded by requireSuperAdmin). */
export const SUPER_ADMIN_SUPPORTING_ACTIONS: readonly ActionRef[] = [
  "admin-judge#grantJudgeQuotaOverride", "privileged#approvePrivilegedOperation", "privileged#selfApprovePrivilegedOperation",
  "privileged#rejectPrivilegedOperation", "privileged#cancelPrivilegedOperation", "super-data#requestSubmissionPurge",
  "super-branding#previewBrandTheme", "super-integrations#sendTestEmail",
];

export const CAPABILITIES: readonly Capability[];
export type CapabilityKey = SuperAdminCapabilityKey | (typeof STAFF_CAPABILITIES)[number]["key"];
export function roleHas(role: Role, key: CapabilityKey): boolean;
export function capabilityMatrix(): Readonly<Record<Role, readonly CapabilityKey[]>>;
```

### Other web library signatures

```ts
// lib/errors.ts
export const IMPERSONATION_READ_ONLY_MESSAGE = "You are viewing as another user (read-only). End the impersonation to make changes.";
export class ImpersonationReadOnlyError extends ForbiddenError {}

// lib/auth/session.ts
export interface ImpersonationContext {
  id: string; sessionId: string; reason: string; startedAt: Date; expiresAt: Date;
  impersonator: Pick<User, "id" | "firstName" | "lastName" | "role">;
}
export type CurrentUser = User & { readonly impersonation?: ImpersonationContext };
export const getCurrentUser: () => Promise<CurrentUser | null>;   // still cache()d
export async function currentSessionId(): Promise<string | null>;

// lib/auth/guards.ts
export async function requireImpersonator(): Promise<{ actorId: string; impersonation: ImpersonationContext }>;
// requireActionUser now throws ImpersonationReadOnlyError when user.impersonation is set.

// lib/auth/impersonation.ts
export async function beginImpersonation(i: { sessionId: string; impersonatorId: string; targetUserId: string; reason: string; now: Date }): Promise<{ id: string; expiresAt: Date }>;
export async function closeImpersonation(i: { impersonationId: string; reason: ImpersonationEndReason; actorId: string | null }): Promise<boolean>; // conditional on endedAt IS NULL; audits only when this call closed it
export async function closeImpersonationsOf(userId: string, reason: ImpersonationEndReason): Promise<number>;

// lib/flags.ts
export const getFeatureFlags: () => Promise<Readonly<Record<FeatureFlagKey, boolean>>>;
export async function isFeatureEnabled(key: FeatureFlagKey): Promise<boolean>;

// lib/outbox.ts
export async function activeSuperAdminIds(tx: DbTx): Promise<string[]>;
export async function enqueueEmail(tx: DbTx, i: { kind: string; toUserIds: readonly string[]; subject: string; bodyText: string; entityType?: string; entityId?: string }): Promise<number>;

// lib/accounts/status.ts (pure)
export function planStatusChange(to: AccountStatus, ctx: { actorId: string; target: { id: string; role: Role; status: AccountStatus }; activeSuperAdmins: number })
  : { ok: true; from: AccountStatus; endsSessions: boolean; sensitivity: AuditSensitivity } | { ok: false; reason: string };
export function planRoleChange(to: Role, ctx: { actorId: string; target: { id: string; role: Role; status: AccountStatus }; activeSuperAdmins: number })
  : { ok: true; dropsScopes: boolean } | { ok: false; reason: string };

// lib/privileged/payloads.ts
export const userFilterSchema;        // { roles?, statuses?, batchYear?, departmentCode?, section? } strict
export const PII_EXPORT_COLUMNS = ["collegeId", "firstName", "lastName", "email", "departmentCode", "batchYear", "section", "role", "status", "createdAt", "lastActiveAt"] as const;
export const privilegedPayloadSchemas: {
  BULK_STATUS_CHANGE: { userIds: string[] /* 26..5000 */; toStatus: AccountStatus };
  SUBMISSION_PURGE:   { userId: string; before: string /* yyyy-mm-dd */; includeAccepted: boolean };
  GLOBAL_REJUDGE:     { problemId: string; problemVersionId: string | null; languages: string[]; verdicts: Verdict[] };
  PII_EXPORT:         { filter: UserFilter; columns: PiiExportColumn[] };
  PROBLEM_DELETE:     { problemId: string };
  VERSION_DELETE:     { problemVersionId: string };
}; // zod schemas; shapes shown as their inferred types
export type PrivilegedPayload<K extends PrivilegedOperationKind>;
export function parsePrivilegedPayload<K extends PrivilegedOperationKind>(kind: K, value: unknown): PrivilegedPayload<K>;
export function payloadDigest(payload: unknown): string;   // sha256(canonicalJson(payload))

// lib/privileged/policy.ts (pure)
export function effectiveStatus(op: { status: PrivilegedOperationStatus; expiresAt: Date }, now: Date): PrivilegedOperationStatus;
export function canApprove(op, actorId: string, sha: string, now: Date): DecisionCheck;
export function canSelfApprove(op, actorId: string, sha: string, now: Date, breakGlassEnabled: boolean): DecisionCheck;
export function canReject(op, actorId: string, now: Date): DecisionCheck;
export function canCancel(op, actorId: string, now: Date): DecisionCheck;
export function bulkStatusRoute(count: number): "direct" | "privileged" | "too-large";

// lib/privileged/operations.ts
export async function createPrivilegedOperation<K extends PrivilegedOperationKind>(i: {
  kind: K; payload: PrivilegedPayload<K>; summary: string; affectedCount: number; reason: string; actor: User;
}): Promise<{ id: string; expiresAt: Date }>;
export async function executePrivilegedOperation(id: string, actor: User): Promise<{ status: "EXECUTED" | "FAILED"; error: string | null }>;
export const PRIVILEGED_EXECUTORS: { [K in PrivilegedOperationKind]: (op: { id: string; payload: PrivilegedPayload<K>; decidedAt: Date }, actor: User) => Promise<Prisma.InputJsonObject> };

// lib/judge/rejudge.ts
export const REJUDGE_RESET_DATA;     // the object now at admin-judge.ts:161-186, minus queuedAt
export async function resetForRejudge(tx: DbTx, ids: readonly string[], now: Date): Promise<number>;

// lib/judge/node-token.ts
export function generateNodeToken(): { token: string; tokenHash: string };   // randomBytes(32) base64url + hashNodeToken (node-auth.ts:86)
```

---

## 4. Impersonation

### How the session is represented

`startImpersonation` runs one transaction:

1. Create the `ImpersonationSession` row with `expiresAt = now + 15 min`.
2. Set `Session.impersonationId` on the caller's session (`currentSessionId()`).

It then audits `impersonation.started` (SECURITY, `targetUserId`, reason, `expiresAt`) and calls `redirect(homeForRole(target.role))`.

### What `getCurrentUser()` does (`session.ts:64`)

It includes `impersonation` in the session lookup. When the pointer is set and the row has not ended, it also checks the following:

- `now < expiresAt`
- the impersonator is still `SUPER_ADMIN` and `ACTIVE`
- the `impersonation` flag is on
- the target's status is in `SIGN_IN_STATUSES` (`session.ts:17`)

If all hold, it loads the target and returns `{ ...target, impersonation }`. Otherwise it calls `closeImpersonation` (EXPIRED or REVOKED), clears the pointer and returns the super-admin.

### Read-only enforcement

1. **Guards.** `requireActionUser()` throws `ImpersonationReadOnlyError` (403). That covers every server action, `/api/drafts` (`route.ts:52`), `/api/activity` (`route.ts:49`), and the `/super` export route (which uses `requireSuperAdmin`).
2. **Page guards.** These return the target user, so `/super` and `/admin` redirect to the target's home while impersonating.
3. **Sign-out.** `destroySession()` closes a live impersonation (SIGNED_OUT, audited) before it deletes the session row. `logout()` (`auth.ts:150`) attributes `auth.logout` to `impersonation.impersonator.id`.
4. **The only action that works during impersonation** is `endImpersonation(_?: FormData): Promise<void>`. Its first statement is `await requireImpersonator()`. It closes the impersonation (ENDED, audited SECURITY) and redirects to `/super/impersonate`. It needs no JavaScript.
5. **Expiry with no further requests.** The scheduler's `GovernanceSweepJob` closes the row (EXPIRED) and writes the end audit through `@recx/db/audit`. Close is a conditional update on `endedAt IS NULL`, so exactly one path writes the end audit.

### Rules for starting

- The `impersonation` flag must be on.
- The target must not be the caller and must not be a `SUPER_ADMIN`.
- The target's status must be ACTIVE or SOFT_RESTRICTED.
- Reason: at least 20 and at most 500 characters.
- One live impersonation per session.
- No extension. Starting again needs a new reason and a new audit row.

### Banner

`components/impersonation/impersonation-banner.tsx` is a server component rendered in `app/layout.tsx`, so it shows on every surface. It is a full-width `role="region" aria-label="Impersonation"` block styled `border-b-2 border-danger bg-danger-subtle text-danger`. It shows the target's `publicName`, roll number, the end time (HH:mm IST), the reason, and a `<form action={endImpersonation}>` button.

---

## 5. Privileged operations, break-glass and the outbox

### Request

Per-kind request actions:

- `requestBulkStatusChange`
- `requestSubmissionPurge`
- `requestGlobalRejudge`
- `requestPiiExport`
- `requestProblemDeletion`
- `requestVersionDeletion`

Each one, in order:

1. Calls `requireSuperAdmin()` first.
2. Applies a rate limit of 10 per minute through `hitRateLimit` (`rate-limit.ts:111`), matching the spec's limit on admin bulk operations.
3. Resolves the target set at request time (for example, a user filter becomes an ID list), so the approver approves an exact set.
4. Calls `createPrivilegedOperation`: status `PENDING`, `expiresAt = +24 h`, in-app `Notification` (`privileged.pending`, link `/super`) to every other active super-admin, audit `privileged.requested`.

### Decide (`server/actions/privileged.ts`)

- **`approvePrivilegedOperation({ id, payloadSha256, note? })`**
  - Refused when the approver is the requester, the operation is not PENDING, it has expired, or the hash does not match.
  - Conditional update `PENDING → APPROVED`. The DB clock compares `expiresAt > now()`.
  - Then `executePrivilegedOperation`: claims `APPROVED → EXECUTING`, runs the executor, ends `EXECUTED` or `FAILED`. Execution is synchronous with caps.
- **`selfApprovePrivilegedOperation({ id, payloadSha256, justification })`** (break-glass)
  - The actor must be the requester; justification at least 20 characters; the `breakGlassSelfApproval` flag must be on.
  - One transaction: set `APPROVED` with `breakGlass = true`, `enqueueEmail` to every ACTIVE SUPER_ADMIN (kind `security.break_glass`; body contains summary, justification and a link to `{APP_URL}/super`), and `Notification` rows.
  - After commit: audit `privileged.break_glass` (SECURITY), then execute.
- **`rejectPrivilegedOperation({ id, note })`**: approver ≠ requester.
- **`cancelPrivilegedOperation({ id })`**: requester only; `decidedById` stays null.

### Executors

All are idempotent and work in batches of 500 transactions.

- **BULK_STATUS_CHANGE.** Runs `planStatusChange` per user. Closes impersonations of DISABLED or ARCHIVED users and calls `destroyAllSessions` (`session.ts:59`). Writes one `account.status_changed` audit row per user with `auditMany` (`targetUserId` index).
- **GLOBAL_REJUDGE.** Selects with `FOR UPDATE SKIP LOCKED` where `problemId = $p` (plus optional version, language and verdict filters), `status IN ('DONE','INTERNAL_ERROR')` and `queuedAt < decidedAt`, then calls `resetForRejudge`.
  - The scheduler's reconciler dispatches the rows; the REJUDGE lane ceiling protects other lanes.
  - It uses the existing `[problemId, verdict, createdAt]` index. No new Submission index.
  - Each batch writes a `judge.rejudge` audit row with `scope: "global"` and compact previous verdicts.
- **SUBMISSION_PURGE.** For PRACTICE submissions of one user before a date: sets `SubmissionSource.source = ''`, sets `archivedAt`, and deletes the `SubmissionTestDetail` rows. Verdict rows are kept. Refused under legal hold.
- **PROBLEM_DELETE / VERSION_DELETE.** One transaction. Allowed only for a version that was never frozen and is not live, or a problem with no frozen version and no student-linked rows (Submission, RunRequest, UserProblemStatus, Bookmark, Note, CodeDraft, StudyPlanItem, DailyChallenge). Frozen versions cannot be deleted at all because the DB trigger in `init` (`ProblemVersion_frozen_guard`) refuses it; the action says "retire instead". A foreign-key error from a table this list does not know about fails the whole operation, so nothing is partly deleted.
- **PII_EXPORT.** Sets `artifactAvailableUntil = now + 24 h`. The CSV is produced by `GET app/super/data/exports/[id]/route.ts`:
  - `requireSuperAdmin`; requester only; status EXECUTED; inside the window.
  - Conditional `artifactDownloads < 3` increment.
  - Cursor-streamed CSV with formula-injection escaping and `no-store`.
  - Audit `pii.export.downloaded` (SECURITY) on each download.

### Outbox drain (scheduler)

- Claim up to 20 rows with `FOR UPDATE SKIP LOCKED` where `PENDING ∧ nextAttemptAt ≤ now()`, or `SENDING ∧ lockedUntil < now()`. Set `SENDING`, `lockedUntil = +2 min`, `attempts + 1`.
- Send, then mark `SENT`; on error back off exponentially.
- After 8 attempts mark `FAILED`. For `security.*` kinds also audit `email.delivery_failed` (SECURITY, actor null).
- With the `disabled` transport nothing is claimed; `/super` shows a danger alert ("N security emails undelivered — no mail transport").

---

## 6. Pages and guards

`app/super/layout.tsx` calls `requireSuperAdminPage()` (`guards.ts:44`) and renders `<SuperShell>`. That shell has its own header, a sidebar for the 12 routes in `nav.ts`, and a persistent sticky strip:

```tsx
<p role="note" className="sticky top-14 z-10 border-b border-danger/30 bg-danger-subtle px-4 py-1.5 text-center text-sm font-semibold text-danger">
  {SUPER_STRIP_TEXT /* "Super-admin — all actions are audited" */}
</p>
```

Every page also calls `requireSuperAdminPage()` itself (the layout alone is not RBAC) and exports `metadata`. The service worker already bypasses `/super` (`sw-routes.ts:30`). No super page ships Monaco.

| Route | Reads | Mutations |
|---|---|---|
| `/super` | Pending approvals (actionable by me / requested by me), live impersonations, undelivered security email, today's chain status, scheduler health, legal hold | Operation cards: approve / break-glass / reject / cancel |
| `/super/users` | Exact roll-number/email match plus cohort, status and role filters; keyset by `collegeId`, 50 per page. `?user=<id>` panel: status history (AuditLog `[targetUserId, createdAt]`) and last 50 XpEvents (listed, never summed) | `setAccountStatus`, `bulkSetAccountStatus` (≤25), `requestBulkStatusChange` (>25), `voidXpEvent`, impersonate link |
| `/super/roles` | Staff and their AdminScopes | `setUserRole`, `grantAdminScope`, `revokeAdminScope` |
| `/super/settings/branding` | Current PlatformTheme; `PRESETS` (`presets.ts:21`) | `previewBrandTheme` (`deriveTheme`, `derive.ts:476`; `REQUIRED_PAIRS`/`evaluatePalette`, `contrast.ts:16/64`; `simulate`), `saveBrandTheme` (upsert, `paletteVersion + 1`, `revalidateBrand()`, `theme.ts:60`) |
| `/super/settings/policy` | Effective XP rules (`effectiveXpRules`, xp.ts:89); retention schedule read-only (`LIMITS.detail.retentionDays`, RunRequest TTL) | `updateXpRules` (exists, `xp-settings.ts:23`), `setLegalHold` |
| `/super/settings/judge` | LanguageConfig plus `languageRuntimeSchema` (protocol.ts:121) for `fallbackMultiplier` / `fallbackExtraMs`; nodes | Existing `setLanguageEnabled` (`admin-judge.ts:233`); `rotateJudgeNodeToken` (token shown once in a Dialog); `requestGlobalRejudge` |
| `/super/settings/integrations` | Mail transport and last send (from `SchedulerJobStatus['outbox'].lastReport`), test-data driver, Redis ping. Never credentials | `sendTestEmail` |
| `/super/audit` | Filters by day (`[chainDay, id]`), sensitivity, or target; actor and action filters only within a day; keyset by id desc; terminal hash per day; banner "tamper-evident, not tamper-resistant" | `verifyAuditChainDay` |
| `/super/impersonate` | Exact-match user lookup; history | `startImpersonation` |
| `/super/flags` | `FEATURE_FLAGS` with effective values | `setFeatureFlag` |
| `/super/jobs` | `loadQueueDepths` (`admin-judge.ts:177`), `loadStuckSubmissions` (:382), SchedulerJobStatus (stale after 3 × `RECONCILER_INTERVAL_MS`), outbox counts and oldest pending, EXECUTING/FAILED operations; `AutoRefresh` | none |
| `/super/data` | Data operations of my kinds | `requestPiiExport`, `requestSubmissionPurge`, download link |

---

## 7. Server actions and audit sensitivity

Every action below calls `requireSuperAdmin()` as its first statement inside `runAction`, except `endImpersonation`, which calls `requireImpersonator()` and is not wrapped. Every action validates its input with zod and captures `ipHash` via `requestIpHash`.

| Action | Audit action | Sensitivity |
|---|---|---|
| `setAccountStatus({userId,toStatus,reason})` | `account.status_changed` | SECURITY if from/to ∈ {DISABLED, ARCHIVED} or the target is staff; otherwise SENSITIVE |
| `bulkSetAccountStatus({userIds≤25,toStatus,reason})` | `account.status_changed` ×N + `account.status_bulk` | as above / SENSITIVE |
| `requestBulkStatusChange`, `requestGlobalRejudge`, `requestProblemDeletion`, `requestVersionDeletion`, `requestSubmissionPurge` | `privileged.requested` | SENSITIVE |
| `requestPiiExport` | `privileged.requested` | SECURITY |
| `setUserRole({userId,role,reason})` (not self; keeps ≥1 ACTIVE super-admin; leaving ADMIN drops scopes) | `account.role_changed` | SECURITY |
| `grantAdminScope` / `revokeAdminScope` | `admin_scope.granted` / `.revoked` | SENSITIVE |
| `setLegalHold({enabled,reason})` | `settings.retention.legal_hold` | SECURITY |
| `setFeatureFlag({key,enabled,reason})` | `settings.flag_changed` | SECURITY |
| `saveBrandTheme({theme,reason})` | `settings.brand.updated` | SENSITIVE |
| `previewBrandTheme(theme)` | none (read) | — |
| `rotateJudgeNodeToken({nodeId,reason})` → `{nodeId, token}` | `judge.node.token_rotated` (`via:"ui"`; never the token) | SECURITY |
| `retireProblem({problemId,reason})` (conditional on `status=PUBLISHED, version`) | `problem.retired` | SENSITIVE |
| `verifyAuditChainDay({day})` | `audit.chain_verified` / `audit.chain_break_detected` | NORMAL / SECURITY |
| `startImpersonation` / `endImpersonation` | `impersonation.started` / `.ended` | SECURITY |
| `voidXpEvent({eventId,reason})` | `xp.voided` | SENSITIVE |
| `approve` / `selfApprove` / `reject` / `cancel` | `privileged.approved` / `privileged.break_glass` / `.rejected` / `.cancelled` | SECURITY / SECURITY / SENSITIVE / NORMAL |
| Operation execution | `privileged.executed` / `.failed` plus the effect rows | SENSITIVE (SECURITY for PII_EXPORT) |
| `sendTestEmail()` | `integrations.test_email` | NORMAL |

How `voidXpEvent` works:

- Takes `pg_advisory_xact_lock(hashtext('user:'||userId))`, the same lock as finalise.
- Inserts a `REVERSAL` row with `idempotencyKey "void:{eventId}"` and `skipDuplicates`; a duplicate means "already voided".
- Decrements `XpBucket.xp` for `bucketKeys(event.occurredAt)` (`rules.ts:213`) with `updateMany` and decrements `UserStats.xpTotal`.
- Never touches solved counters or frozen `LeaderboardSnapshot` rows.

---

## 8. Scheduler

- **`config.ts`:**
  - `MAIL_TRANSPORT`: `smtp | log | disabled`. Defaults to `log` in development and `disabled` otherwise; `log` is refused in production.
  - `SMTP_URL`: required when the transport is `smtp`.
  - `MAIL_FROM`.
- **`mail.ts`:** `type MailTransportName`, `interface MailTransport { name; send({to,subject,text}) }`, `createMailTransport(cfg, log)`. Logs never contain the address.
- **`outbox.ts`:** `OUTBOX_BATCH = 20`, `OUTBOX_MAX_ATTEMPTS = 8`, `outboxBackoffMs(attempts)`, `class OutboxDrainJob { tick(now): Promise<OutboxReport> }`.
- **`governance.ts`:** `class GovernanceSweepJob { tick(now) }`. It:
  - expires PENDING operations past `expiresAt` (audit `privileged.expired`, NORMAL);
  - fails operations stuck in EXECUTING for more than 15 minutes (audit `privileged.failed`);
  - closes lapsed impersonations (audit `impersonation.ended`, EXPIRED, SECURITY).
  
  Pure classifier: `classifyPrivilegedOperation(row, now)`.
- **`job-status.ts`:** `recordJobStatus(db, job: SchedulerJobName, outcome, dryRun)`.
- **`main.ts`:** the tick runs `outbox` and `governance` after `leaderboardFreeze`, each isolated in its own try/catch like the existing jobs, and records status per job. Dry-run writes nothing.

---

## 9. Tests

The Phase 4 gate item for this stream is "the role × capability matrix test passes". Tests 1–4 prove it, together with read-only impersonation.

1. **`apps/web/test/capabilities.test.ts`** (static, TypeScript compiler API parse via `ts.createSourceFile`):
   - exactly the 12 keys, each with `roles = ["SUPER_ADMIN"]`;
   - live entries have at least one action or route; `arrives` entries have none, and their `models` must not exist in `schema.prisma` (the test fails when Phase 5/6/8 lands without wiring);
   - every `ActionRef` resolves to an exported async function in a `"use server"` file;
   - inside each one, `return runAction(async () => { <first statement> }, "<exportName>")`, where the first statement awaits `requireSuperAdmin()`;
   - route refs call `requireSuperAdmin(` before any `db.`; page refs call `requireSuperAdminPage(`;
   - reverse completeness: every function in `server/actions` that calls `requireSuperAdmin` appears in some capability or in `SUPER_ADMIN_SUPPORTING_ACTIONS`.
2. **`apps/web/test/capability-matrix.test.ts`** (runtime, real guards):
   - `vi.mock("@/lib/auth/guards", …)` wraps the real implementations in spies; `@/lib/auth/session` returns an actor per role; `@/lib/db` is a Proxy that records access and throws.
   - For each `ROLES` × `CAPABILITIES` action called with `{}`: if `!roleHas` the result is `{ok:false, error: ForbiddenError message}`, the DB is untouched and audit is not called. If `roleHas`, the guard spy fires before any DB access and the result is not Forbidden.
   - With an impersonating SUPER_ADMIN, every action returns `IMPERSONATION_READ_ONLY_MESSAGE`.
3. **`tests/repo/action-guards.test.ts`**:
   - every exported function in `apps/web/src/server/actions/*.ts` starts its `runAction` body with `requireActionUser | requireActionRole | requireSuperAdmin`;
   - allowlist: `auth#login`, `auth#logout`, and `super-impersonate#endImpersonation` (which must start with `requireImpersonator`);
   - every non-judge `app/api/**/route.ts` that exports POST/PUT/PATCH/DELETE calls an action guard;
   - every `app/super/**/route.ts` calls `requireSuperAdmin`;
   - includes self-test fixtures.
4. **`apps/web/test/impersonation-read-only.test.ts`**: `import.meta.glob("../src/server/actions/*.ts")`, call every export except the allowlist, expect the read-only error with the DB proxy untouched; `POST /api/drafts` and `/api/activity` return 403.
5. **Impersonation:**
   - `impersonation.test.ts`: reason minimum, 15-minute expiry, self/super/inactive targets refused, flag off refused, start/end audits, `getCurrentUser` returns the target, expiry → EXPIRED, logout → SIGNED_OUT.
   - `impersonation.db.test.ts`: session pointer, CHECK constraints, concurrent end plus sweep produce exactly one end audit.
6. **Privileged operations:**
   - `privileged-policy.test.ts` (pure): requester ≠ approver, 24 h, break-glass only for the requester, status machine, `bulkStatusRoute` at 25/26/5,000/5,001, digest stability.
   - `privileged.db.test.ts`:
     - a second super-admin approves and the operation executes; self-approve without break-glass is refused;
     - raw SQL setting `decidedById = requestedById` with `breakGlass = false` violates the CHECK;
     - the trigger refuses payload changes and deletes; an expired operation is refused;
     - two concurrent approvals → one succeeds;
     - break-glass writes a SECURITY audit, one `EmailOutbox` row and one `Notification` per ACTIVE super-admin.
7. **Super shell:**
   - `super-strip.test.tsx`: `renderToStaticMarkup(SuperShell)` contains exactly "Super-admin — all actions are audited" with `bg-danger-subtle` and `text-danger`.
   - Static check that `app/super/layout.tsx` and every `app/super/**/page.tsx` call `requireSuperAdminPage()`.
   - `super-nav.test.ts`: the 12 routes exist and every href has a page (same pattern as `shell-nav.test.ts`).
8. **Feature tests:**
   - `account-status.test.ts`: self change refused, last super-admin protected, `endsSessions`.
   - `xp-void.db.test.ts`: REVERSAL with `reversesEventId`, all three buckets decremented, second void refused, original row unchanged.
   - `rotate-token.test.ts`: the new token matches via `nodeTokenMatches` (`node-auth.ts:91`), the old one does not, and no audit metadata contains the token.
   - `branding-actions.test.ts`: a failing palette is refused, rec-purple is canonical, `revalidateBrand` is called, audit is written.
   - `pii-export-route.test.ts`: requester only, window, max 3 downloads, formula escaping, audit per download.
9. **Audit:**
   - `audit-verify.test.ts`: `createChainVerifier` agrees with `verifyChain`; tampered metadata is detected.
   - `audit-verify.db.test.ts`: rows written by `audit()`/`auditMany()` verify after the jsonb round-trip.
10. **Setting writes:** `tests/repo/platform-setting-writes.test.ts` — `platformSetting.*` and `platformTheme.*` writes in `apps/web/src` only appear in `xp-settings`, `super-settings`, `super-flags` and `super-branding`.
11. **Optional:** `tests/repo/render-read-only.test.ts` — no `(db|tx).x.(create|update|upsert|delete…)` or `$executeRaw` in `app/**/{page,layout}.tsx`, `server/queries/**` or `components/**`.
12. **Scheduler:**
    - `outbox.test.ts` (backoff, give-up) and `outbox.db.test.ts` (SKIP LOCKED claim, lease recovery, failure audit);
    - `mail-config.test.ts` (log refused in production);
    - `governance.db.test.ts`;
    - `classify.test.ts` still passes with the shared schema.
13. **Shared:** `packages/shared/test/governance.test.ts` — flag defaults and invalid values; retention schema accepts the old `{legalHold:true}` and the new fields.

`forbidden-words.test.ts` covers all new files and docs automatically. Manual check for `RUNBOOK.md`: two super-admins request and approve a 30-user DISABLED change; break-glass with `MAIL_TRANSPORT=log`; impersonate a student, confirm a draft save is refused, then end; read the audit rows.

---

## 10. Interactions with other streams

- **`schema.prisma`:**
  - Owner needed for `AdminScope`. I propose this stream defines it; the admin-surface stream owns `adminScopeWhere(user)` and the query folding.
  - I touch `Session` (two lines) and `User` (`adminScopes`).
  - Migrations need one timestamp order across streams, assigned by the orchestrator.
- **`packages/shared/src/index.ts`:** one export line.
- **Auth (`guards.ts`, `session.ts`, `errors.ts`, `auth.ts`):** this stream owns the changes. API stays compatible: `getCurrentUser` gains an optional field. Other streams must not add guards elsewhere, and new actions must start with a guard (the repo test enforces it).
- **Admin layout (`admin-shell.tsx:59`):** the admin stream also extends `NAV`. Merge both: add the `/super` entry only for `SUPER_ADMIN`. `homeForRole` stays `/admin`.
- **Authoring stream:**
  - Must not ship an ADMIN-level retire, delete or discard-version action. Their UI may call `super-problems#retireProblem` and the deletion requests (shown to super-admins, guarded server-side).
  - Any new child table of Problem/ProblemVersion must be added to the deletion executor's list.
  - Their `ProblemStatus` additions (APPROVED) don't conflict.
- **Admin students / import stream:** a roster import must never change the status of more than 25 users directly. The narrower reading is that the import never changes status at all. Status changes live only in `/super/users` in Phase 4; `/admin/students` shows status read-only.
- **Judge / transparency stream:** `admin-judge.ts` reset is refactored into `lib/judge/rejudge.ts`. Language multiplier display can share `languageRuntimeSchema` parsing.
- **`lib/audit.ts` / `audit-chain.ts`:** keep their exports and re-export from `@recx/db`. Rule for every stream: no `Date` objects in audit metadata.
- **Seed:** a second super-admin for development (`SEED_SECOND_SUPER_ADMIN`) is optional, to avoid conflicts in `seed.ts`.

---

## 11. Open questions for `docs/OPEN-QUESTIONS.md`

Each is the narrower reading, implemented as described above.

1. Ratings, integrity overturn, and calendar/MEDICAL leave are declared as `arrives` in Phases 5/6/8, enforced by the models-absent test. `RATING_RECOMPUTE` is added to the enum in Phase 5.
2. **Email:** outbox plus SMTP; `log` transport in development only; production without SMTP holds rows visibly and the in-app notifications always go out. `nodemailer` is a new dependency.
3. **Impersonation:** no SUPER_ADMIN or inactive targets; the target is not notified; read-only also blocks harmless student writes (drafts, hint reveals); the banner can push the full-bleed workspace down by its own height.
4. Only never-frozen, unreferenced problems and versions can be deleted. Frozen versions are retired instead (the DB trigger refuses deletes). Test blobs and bundles are left as orphans.
5. Submission purge covers one student's PRACTICE sources and test details before a date. Verdict rows are kept; contest and assessment sources are never purged; refused under legal hold.
6. PII export is generated at download time and never stored: requester only, 24 h, 3 downloads, minimised column set.
7. Retention durations are read-only. Only legal hold is editable.
8. All manual status changes (including GRADUATED and SOFT_RESTRICTED) are super-only in Phase 4. `AccountStatusEvent` is deferred to Phase 8; audit rows are the record until then.
9. Role changes to or from SUPER_ADMIN are single super-admin plus a SECURITY audit; they are not on the spec's two-person list.
10. Both the requester and the approver must be SUPER_ADMIN.
11. The flags registry is closed and only registers the two governance kill switches.
12. Integrations is a read-only status page plus a test email.
13. Audit append moves to `@recx/db` so the scheduler can audit.
14. Voiding XP does not rewrite frozen snapshots or un-solve problems.
15. No `ThemePreset` table; presets stay in code.
16. Global rejudge scope is one problem (optionally one version, languages, verdicts), capped at 25,000. A language-wide rejudge across problems would need a new Submission index and is deferred.
17. Retiring a problem hides it from the catalog and workspace (`judge.ts:61`, `queries/problems.ts:84`). Check that students can still open their old submission pages for it. Restoring a retired problem is not built.