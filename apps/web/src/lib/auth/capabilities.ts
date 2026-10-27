import type { PrivilegedOperationKind, Role } from "@recx/db";

/**
 * The role × capability map for the WHOLE app, as data. Pure module: no
 * `server-only`, no runtime imports (only types from @recx/db), so tests and
 * tests/repo can read it. The guards themselves live in lib/auth/guards.ts
 * and lib/auth/scope.ts; this file says which guarded server action, route
 * handler and page belongs to which capability, and tests prove it:
 *
 *   - apps/web/test/capabilities.test.ts (static, TypeScript compiler API):
 *     every export of every "use server" file is in exactly one capability
 *     or list; the roles each action's, route's and page's REAL guard admits
 *     (parsed from the guard modules' source) equal the roles its capability
 *     declares; every /admin and /super page and every admin, super and
 *     mutating API route is bound; docs/SECURITY.md carries the table below.
 *   - apps/web/test/capability-matrix.test.ts (runtime, real guards): every
 *     role, plus signed out, calls every bound action, route and page; only
 *     roles that hold the capability get past the guard, a denied one is
 *     refused before any database access, audit or enqueue, and an
 *     impersonating SUPER_ADMIN gets the read-only refusal.
 *
 * Five tiers of capability:
 *   - SUPER_ADMIN_CAPABILITIES: the spec's twelve, SUPER_ADMIN only;
 *   - STAFF_CAPABILITIES: ADMIN and SUPER_ADMIN (requireActionRole /
 *     requireAdminScopeAction; pages requireAdminScopePage / requirePageRole);
 *   - PLACEMENT_CAPABILITIES: PLACEMENT_OFFICER and SUPER_ADMIN
 *     (requirePlacementPage / requirePlacementAction). Cohort analytics and
 *     nothing else — no authoring, moderation, role change or account
 *     status, and no route to a student's private work;
 *   - MENTOR_CAPABILITIES: TA_MENTOR, ADMIN and SUPER_ADMIN
 *     (requireMentorPage / requireMentorAction), limited per student by
 *     lib/auth/mentor-scope.ts, which fails closed;
 *   - SELF_SERVICE_CAPABILITIES: any signed-in user (requireActionUser),
 *     always acting on their own rows.
 * Plus four lists that are not capabilities: SUPER_ADMIN_SUPPORTING_ACTIONS
 * (super-only, not one of the twelve), SUPER_ADMIN_SUPPORTING_PAGES,
 * IMPERSONATOR_ACTIONS (ending an impersonation) and PUBLIC_ACTIONS /
 * PUBLIC_ROUTES (sign-in and sign-out).
 *
 * An ActionRef is "<file in src/server/actions without .ts>#<export>"; a
 * RouteRef and a PageRef are paths under src/.
 */

export const ROLES = ["STUDENT", "TA_MENTOR", "ADMIN", "PLACEMENT_OFFICER", "SUPER_ADMIN"] as const satisfies readonly Role[];

export type ActionRef = `${string}#${string}`;
export type RouteRef = `app/${string}/route.ts#${"GET" | "POST"}`;
export type PageRef = `app/${string}/page.tsx`;

export interface Capability<K extends string = string> {
  readonly key: K;
  readonly label: string;
  readonly roles: readonly Role[];
  readonly actions: readonly ActionRef[];
  readonly routes?: readonly RouteRef[];
  readonly pages?: readonly PageRef[];
  readonly privileged?: readonly PrivilegedOperationKind[];
  /** Declared now, wired in a later phase: no actions until then (a test fails once `models` exist). */
  readonly arrives?: { readonly phase: 5 | 6 | 8 | 11; readonly models: readonly string[] };
}

export const SUPER_ADMIN_CAPABILITY_KEYS = [
  "roles.manage",
  "settings.write",
  "accounts.status",
  "problems.lifecycle",
  "ratings.manage",
  "integrity.overturn",
  "audit.readFull",
  "users.impersonate",
  "judge.rotateKeys",
  "pii.export",
  "calendar.manage",
  "xp.void",
] as const;
export type SuperAdminCapabilityKey = (typeof SUPER_ADMIN_CAPABILITY_KEYS)[number];

const SUPER_ONLY: readonly Role[] = Object.freeze(["SUPER_ADMIN"] as const);
const STAFF: readonly Role[] = Object.freeze(["ADMIN", "SUPER_ADMIN"] as const);
/**
 * Phase 9d. The placement cell, and deliberately NOT ADMIN: an AdminScope is
 * a department-and-batch slice and the cohort dashboard is a whole-college
 * instrument, so admitting every scoped admin would quietly undo the scope.
 */
const PLACEMENT: readonly Role[] = Object.freeze(["PLACEMENT_OFFICER", "SUPER_ADMIN"] as const);
/**
 * Phase 9d. The mentor of record. ADMIN is here because a department admin
 * is already trusted with that department's students and is often the person
 * who has the conversation; the per-mentee check in lib/auth/mentor-scope.ts
 * is what limits what any of them can read, and it fails closed.
 *
 * PLACEMENT_OFFICER is NOT here, and that is the point of the whole
 * arrangement: the at-risk list routes a student AWAY from the analytics
 * surface, so the person it routes to must not be the one reading it.
 */
const MENTOR: readonly Role[] = Object.freeze(["TA_MENTOR", "ADMIN", "SUPER_ADMIN"] as const);
const EVERY_SIGNED_IN_ROLE: readonly Role[] = Object.freeze([...ROLES]);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

/**
 * THE twelve SUPER_ADMIN-exclusive capabilities (spec, Phase 4). Every action
 * listed here calls requireSuperAdmin() as the first statement of its
 * runAction body.
 */
export const SUPER_ADMIN_CAPABILITIES: readonly Capability<SuperAdminCapabilityKey>[] = deepFreeze([
  {
    key: "roles.manage",
    label: "Manage roles and admin scopes",
    roles: SUPER_ONLY,
    actions: ["super-roles#setUserRole", "super-roles#grantAdminScope", "super-roles#revokeAdminScope"],
    pages: ["app/super/roles/page.tsx"],
  },
  {
    key: "settings.write",
    label: "Write platform settings",
    roles: SUPER_ONLY,
    actions: [
      "xp-settings#updateXpRules",
      "super-settings#setLegalHold",
      "super-flags#setFeatureFlag",
      "super-branding#saveBrandTheme",
      // Phase 8b. The inactivity thresholds are settings, not constants —
      // SPEC §5 requires them to be tunable without a deploy. The one that
      // can end in a lockout, setAutoDisableEnabled, audits at SECURITY.
      "super-inactivity#saveInactivityPolicy",
      "super-inactivity#activateInactivityPolicy",
      "super-inactivity#setAutoDisableEnabled",
    ],
    pages: [
      "app/super/settings/policy/page.tsx",
      "app/super/flags/page.tsx",
      "app/super/settings/branding/page.tsx",
      "app/super/settings/inactivity/page.tsx",
    ],
  },
  {
    key: "accounts.status",
    label: "Disable, archive or restore accounts; bulk status changes over 25 accounts",
    roles: SUPER_ONLY,
    actions: ["super-users#setAccountStatus", "super-users#bulkSetAccountStatus", "super-users#requestBulkStatusChange"],
    pages: ["app/super/users/page.tsx"],
    privileged: ["BULK_STATUS_CHANGE"],
  },
  {
    key: "problems.lifecycle",
    label: "Retire a published problem, delete a version, global rejudge",
    roles: SUPER_ONLY,
    actions: [
      "super-problems#retireProblem",
      "super-problems#requestProblemDeletion",
      "super-problems#requestVersionDeletion",
      "super-judge#requestGlobalRejudge",
      // Phase 7d: publishing an aptitude question is the act that makes a
      // cohort scorable on it, which is the class of act this capability
      // already holds.
      "super-aptitude#publishAptitudeQuestion",
    ],
    privileged: ["PROBLEM_DELETE", "VERSION_DELETE", "GLOBAL_REJUDGE"],
  },
  {
    key: "ratings.manage",
    label: "Release, recompute or override ratings",
    roles: SUPER_ONLY,
    actions: ["super-ratings#releaseContestRating"],
  },
  {
    key: "integrity.overturn",
    label: "Overturn an integrity decision",
    // Wired in Phase 6e, when IntegrityFlag arrived. Only ever overturns: a
    // super-admin may not uphold harder than the reviewers already could.
    roles: SUPER_ONLY,
    actions: ["super-integrity#overturnIntegrityDecision"],
    pages: ["app/super/integrity/page.tsx"],
  },
  {
    key: "audit.readFull",
    label: "Read the full audit log",
    roles: SUPER_ONLY,
    actions: ["super-audit#verifyAuditChainDay"],
    pages: ["app/super/audit/page.tsx"],
  },
  {
    key: "users.impersonate",
    label: "Impersonate a user (read-only, 15 minutes)",
    roles: SUPER_ONLY,
    actions: ["super-impersonate#startImpersonation"],
    pages: ["app/super/impersonate/page.tsx"],
  },
  {
    key: "judge.rotateKeys",
    label: "Rotate judge node keys",
    roles: SUPER_ONLY,
    actions: ["super-judge#rotateJudgeNodeToken"],
    pages: ["app/super/settings/judge/page.tsx"],
  },
  {
    key: "pii.export",
    label: "Full PII export",
    roles: SUPER_ONLY,
    actions: ["super-data#requestPiiExport"],
    routes: ["app/super/data/exports/[id]/route.ts#GET"],
    pages: ["app/super/data/page.tsx"],
    privileged: ["PII_EXPORT"],
  },
  {
    key: "calendar.manage",
    label: "Edit the academic calendar and approve MEDICAL leave",
    roles: SUPER_ONLY,
    /**
     * Wired in Phase 8a, in the same slice its two models appear — the
     * capability test fails the moment CalendarDay and LeaveException exist
     * with an empty action list, which is the right way round: a model that
     * can be written by nobody-knows-whom is the thing to refuse.
     *
     * These rows decide whether a student's fortnight away counts against
     * them, so the power to write them is the power to restrict an account at
     * one remove. That is why it is SUPER_ADMIN and not staff.
     */
    actions: [
      "super-calendar#upsertCalendarDay",
      "super-calendar#markCalendarRange",
      "super-calendar#decideLeaveException",
    ],
    pages: ["app/super/calendar/page.tsx"],
  },
  {
    key: "xp.void",
    label: "Void XP",
    roles: SUPER_ONLY,
    actions: ["super-xp#voidXpEvent"],
    pages: ["app/super/users/page.tsx"],
  },
] as const satisfies readonly Capability<SuperAdminCapabilityKey>[]);

/**
 * SUPER_ADMIN-only actions that are not one of the twelve. Each is still
 * guarded by requireSuperAdmin() first (same static test). Accommodation
 * approve/reject/revoke are super-only by the admin design, not by the
 * spec's list of twelve.
 */
export const SUPER_ADMIN_SUPPORTING_ACTIONS: readonly ActionRef[] = Object.freeze([
  "admin-judge#grantJudgeQuotaOverride",
  "admin-accommodations#approveAccommodation",
  "admin-accommodations#rejectAccommodation",
  "admin-accommodations#revokeAccommodation",
  "privileged#approvePrivilegedOperation",
  "privileged#selfApprovePrivilegedOperation",
  "privileged#rejectPrivilegedOperation",
  "privileged#cancelPrivilegedOperation",
  "super-data#requestSubmissionPurge",
  "super-branding#previewBrandTheme",
  "super-integrations#sendTestEmail",
] as const);

/**
 * /super pages that serve the supporting actions rather than one of the
 * twelve (the approvals dashboard, scheduler health, mail settings). Each
 * calls requireSuperAdminPage() itself.
 */
export const SUPER_ADMIN_SUPPORTING_PAGES: readonly PageRef[] = Object.freeze([
  "app/super/page.tsx",
  "app/super/jobs/page.tsx",
  "app/super/settings/integrations/page.tsx",
] as const);

/**
 * Staff capabilities: ADMIN and SUPER_ADMIN, as each guard says
 * (requireActionRole("ADMIN", "SUPER_ADMIN") or requireAdminScopeAction(),
 * pages requirePageRole("ADMIN", "SUPER_ADMIN") or requireAdminScopePage()).
 * What an ADMIN may see and change among students is further narrowed by
 * AdminScope (lib/auth/scope.ts), which is data, not role.
 */
export const STAFF_CAPABILITIES = deepFreeze([
  {
    key: "integrity.review",
    label: "Review a flagged sitting and record a verdict",
    // College-level, not departmental: SPEC §5 needs two INDEPENDENT
    // reviewers at HIGH, and a department with one administrator could not
    // supply them (tests/repo/admin-scope.test.ts carries the reason).
    roles: ["ADMIN", "SUPER_ADMIN"],
    actions: ["integrity#recordVerdict", "integrity#decideAppeal"],
    pages: ["app/admin/integrity/page.tsx", "app/admin/integrity/[flagId]/page.tsx"],
  },
  {
    key: "exam.invigilate",
    label: "Invigilate a hall: message, grant time, record what you saw, end a sitting",
    // Every action here carries a written reason and an audit row, and
    // terminate takes a SECOND staff member (a CHECK, not a route).
    roles: ["ADMIN", "SUPER_ADMIN"],
    actions: [
      "invigilate#messageCandidate",
      "invigilate#grantExtraTime",
      /**
       * Phase 11b. The control docs/PROCTORING.md §4 rates highest is "a
       * physical invigilator in the room", and until now what they saw had
       * no way into the record a reviewer reads. It is context, never a
       * finding: INVIGILATOR_NOTE cannot raise a band.
       */
      "invigilate#recordObservation",
      "invigilate#requestTermination",
      "invigilate#confirmTermination",
    ],
    routes: ["app/api/admin/invigilate/[sessionId]/live/route.ts#GET"],
    pages: ["app/admin/invigilate/page.tsx", "app/admin/invigilate/[sessionId]/page.tsx"],
  },
  {
    key: "exam.device.enrol",
    label: "Enrol a student's exam device, in person",
    // SPEC §5: "supervised in-lab enrolment". A student who can enrol their
    // own device can enrol a friend's, which is the impersonation WebAuthn
    // is here to close.
    roles: ["ADMIN", "SUPER_ADMIN"],
    actions: ["exam-devices#revokeExamDevice"],
    routes: ["app/api/exam/device/enrol/route.ts#POST"],
    pages: ["app/admin/devices/page.tsx"],
  },
  {
    key: "judge.operate",
    label: "Operate the judge (drain nodes, rejudge one submission, toggle languages)",
    roles: STAFF,
    actions: ["admin-judge#setJudgeNodeStatus", "admin-judge#rejudgeSubmission", "admin-judge#setLanguageEnabled"],
    pages: ["app/admin/judge/page.tsx"],
  },
  {
    key: "students.view",
    label: "View in-scope students, cohorts and reports",
    roles: STAFF,
    actions: [],
    pages: [
      "app/admin/page.tsx",
      "app/admin/students/page.tsx",
      "app/admin/students/[id]/page.tsx",
      "app/admin/cohorts/page.tsx",
      "app/admin/reports/page.tsx",
    ],
  },
  {
    /**
     * Phase 8d. The review queue the inactivity sweep hands to a human, and
     * the two things a human can do with an item.
     *
     * Staff and scoped: an ADMIN acts only on students their AdminScope
     * covers. Clearing is a DE-ESCALATION only — there is no staff action
     * here that restricts anybody, because the sweep restricts from the
     * policy with evidence, and a staff member who wants somebody restricted
     * sooner changes the policy rather than reaching past it.
     *
     * `DISABLED` is refused to staff three times over: the pure
     * `canStaffClear()`, the action, and
     * `AccountStatusEvent_undisable_check`. The spec makes
     * DISABLED → ACTIVE super-admin only.
     */
    key: "inactivity.review",
    label: "Review and lift an inactivity restriction for an in-scope student",
    roles: STAFF,
    actions: ["admin-inactivity#clearRestriction", "admin-inactivity#dismissReviewItem"],
    pages: ["app/admin/inactivity/page.tsx"],
  },
  {
    key: "students.signOut",
    label: "Sign an in-scope student out everywhere",
    roles: STAFF,
    actions: ["admin-students#forceSignOutStudent"],
    pages: ["app/admin/students/[id]/page.tsx"],
  },
  {
    /**
     * The roster, in both sizes. Phase 11a added one student at a time
     * (`/admin/students/new`) for the late admission and the transfer, and
     * it is the SAME capability rather than a new one because it is the
     * same act with the same rules: the add action validates, plans and
     * writes through the import's own code, and refuses anything that is
     * not a clean creation inside the admin's scope.
     */
    key: "roster.import",
    label: "Add students to the roster (one at a time, or a CSV preview and commit)",
    roles: STAFF,
    actions: [
      "admin-roster#previewRosterImport",
      "admin-roster#commitRosterImport",
      "admin-roster#discardRosterImport",
      "admin-roster#addStudent",
    ],
    pages: [
      "app/admin/students/import/page.tsx",
      "app/admin/students/import/[importId]/page.tsx",
      "app/admin/students/new/page.tsx",
    ],
  },
  {
    key: "plans.manage",
    label: "Create and edit study sheets and tracks",
    roles: STAFF,
    actions: [
      "admin-plans#createStudyPlan",
      "admin-plans#updateStudyPlan",
      "admin-plans#setStudyPlanPublished",
      "admin-plans#detachPlanFromSeed",
      "admin-plans#addPlanSection",
      "admin-plans#renamePlanSection",
      "admin-plans#movePlanSection",
      "admin-plans#deletePlanSection",
      "admin-plans#addPlanItems",
      "admin-plans#movePlanItem",
      "admin-plans#removePlanItem",
    ],
    pages: [
      "app/admin/sheets/page.tsx",
      "app/admin/sheets/new/page.tsx",
      "app/admin/sheets/[id]/page.tsx",
      "app/admin/tracks/page.tsx",
      "app/admin/tracks/new/page.tsx",
      "app/admin/tracks/[id]/page.tsx",
    ],
  },
  {
    key: "contests.manage",
    label: "Create contests and pin their problems",
    roles: STAFF,
    actions: [
      "admin-contests#createContest",
      "admin-contests#addContestProblem",
      "admin-contests#removeContestProblem",
      "admin-contests#publishContest",
    ],
    pages: [
      "app/admin/contests/page.tsx",
      "app/admin/contests/new/page.tsx",
      "app/admin/contests/[id]/page.tsx",
    ],
  },
  {
    key: "announcements.manage",
    label: "Draft, publish and archive announcements to in-scope students",
    roles: STAFF,
    actions: [
      "admin-announcements#saveAnnouncementDraft",
      "admin-announcements#publishAnnouncement",
      "admin-announcements#archiveAnnouncement",
    ],
    pages: [
      "app/admin/announcements/page.tsx",
      "app/admin/announcements/new/page.tsx",
      "app/admin/announcements/[id]/page.tsx",
    ],
  },
  {
    key: "accommodations.request",
    label: "Request or withdraw an accommodation (a SUPER_ADMIN decides)",
    roles: STAFF,
    actions: ["admin-accommodations#requestAccommodation", "admin-accommodations#withdrawAccommodation"],
    pages: [
      "app/admin/accommodations/page.tsx",
      "app/admin/accommodations/new/page.tsx",
      "app/admin/accommodations/[id]/page.tsx",
    ],
  },
  {
    key: "aptitude.authoring",
    label: "Author the aptitude bank: write, review, retire and import questions",
    roles: STAFF,
    actions: [
      "admin-aptitude#createAptitudeQuestion",
      "admin-aptitude#updateAptitudeQuestion",
      "admin-aptitude#reviseAptitudeExplanation",
      "admin-aptitude#submitAptitudeQuestionForReview",
      // Retiring is ADMIN's, not SUPER_ADMIN's: it only ever stops a question
      // being served, and "this question is wrong" must not wait.
      "admin-aptitude#retireAptitudeQuestion",
      "admin-aptitude#saveAptitudePassage",
    ],
    routes: [
      "app/api/admin/aptitude/import/route.ts#POST",
      // The export carries the answer key and the worked explanations, which
      // is why it is here and why it audits every download.
      "app/api/admin/aptitude/export/route.ts#GET",
    ],
    pages: [
      "app/admin/aptitude/page.tsx",
      "app/admin/aptitude/new/page.tsx",
      // The ONE staff page that shows an answer key, which is why it is one
      // question rather than a list.
      "app/admin/aptitude/[questionId]/page.tsx",
      "app/admin/aptitude/import/page.tsx",
      "app/admin/aptitude/import/[importId]/page.tsx",
    ],
  },
  {
    key: "problems.author",
    label: "Author problems: create, revise, edit a draft, submit or withdraw it for review",
    roles: STAFF,
    actions: [
      "admin-problems#createProblem",
      "admin-problems#startRevision",
      "admin-problems#setProblemTopics",
      "admin-problems#submitForReview",
      "admin-problems#withdrawFromReview",
      "admin-problems#previewStatement",
      "admin-problem-content#updateDraftDetails",
      "admin-problem-content#updateDraftJudging",
      "admin-problem-content#setDraftChecker",
      "admin-problem-content#addDraftTests",
      "admin-problem-content#updateDraftTest",
      "admin-problem-content#removeDraftTests",
      "admin-problem-content#setDraftSubtasks",
      "admin-problem-content#upsertReferenceSolution",
      "admin-problem-content#removeReferenceSolution",
      "admin-problem-content#upsertStarterCode",
      "admin-problem-content#removeStarterCode",
      "admin-problem-content#setDraftHelp",
    ],
    pages: [
      "app/admin/problems/page.tsx",
      "app/admin/problems/new/page.tsx",
      "app/admin/problems/[id]/page.tsx",
      "app/admin/problems/[id]/testcases/page.tsx",
    ],
  },
  {
    key: "problems.validate",
    label: "Validate a draft against its reference solutions",
    roles: STAFF,
    actions: ["admin-problems#startProblemValidation", "admin-problems#refreshValidation"],
    pages: ["app/admin/problems/[id]/validate/page.tsx"],
  },
  {
    key: "problems.review",
    label: "Review a draft: approve, return to its author, revoke an approval (never your own)",
    roles: STAFF,
    actions: ["admin-problems#approveVersion", "admin-problems#returnToDraft", "admin-problems#revokeVersionApproval"],
  },
  {
    key: "problems.publish",
    label: "Publish an approved revision",
    roles: STAFF,
    actions: ["admin-problems#publishProblemVersion"],
  },
  {
    key: "problems.import",
    label: "Bulk-import problem packages and validate the imported drafts",
    roles: STAFF,
    actions: ["admin-problems#validateImportedDrafts"],
    routes: ["app/api/admin/problems/import/route.ts#POST"],
    pages: ["app/admin/problems/import/page.tsx", "app/admin/problems/import/[importId]/page.tsx"],
  },
] as const satisfies readonly Capability[]);

/**
 * Self-service capabilities: every signed-in role (requireActionUser), each
 * acting only on the caller's own rows. A role-specific narrowing (e.g. a
 * mentor-only action) would get its own capability with its own guard.
 */
export const SELF_SERVICE_CAPABILITIES = deepFreeze([
  {
    key: "judge.submit",
    label: "Submit a solution or run code",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["judge#submitSolution", "judge#runCode"],
  },
  {
    key: "drafts.save",
    label: "Save my code drafts",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["drafts#saveDraft"],
    routes: ["app/api/drafts/route.ts#POST"],
  },
  {
    key: "activity.record",
    label: "Record my active time on a problem",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: [],
    routes: ["app/api/activity/route.ts#POST"],
  },
  {
    key: "exam.heartbeat",
    label: "Sit a proctored assessment",
    // Every signed-in role, because the capability is not "be a student": a
    // staff member sitting a practice assessment is a candidate too, and the
    // attempt row itself (plus its token) is what decides whose sitting this
    // is. The route's own guard checks ownership and the attempt token.
    roles: EVERY_SIGNED_IN_ROLE,
    actions: [],
    routes: [
      "app/api/exam/[attemptId]/hb/route.ts#POST",
      "app/api/exam/[attemptId]/events/route.ts#POST",
      "app/api/exam/[attemptId]/snapshot/route.ts#POST",
      "app/api/exam/[attemptId]/submit/route.ts#POST",
    ],
  },
  {
    key: "exam.device.assert",
    label: "Verify my registered device before an assessment",
    // The candidate's own route: they hold the authenticator. Enrolment is a
    // supervisor's (exam.device.enrol), which is what closes impersonation.
    roles: EVERY_SIGNED_IN_ROLE,
    actions: [],
    routes: ["app/api/exam/device/assert/route.ts#POST"],
  },
  {
    key: "aptitude.sit",
    label: "Practise aptitude and sit a mock",
    // Every signed-in role, because the capability is not "be a student": a
    // staff member practising is a candidate too. Every action scopes by
    // userId in a `where` clause, and the sitting row is what decides whose
    // paper this is.
    roles: EVERY_SIGNED_IN_ROLE,
    actions: [
      "aptitude#startMock",
      "aptitude#saveMockAnswer",
      "aptitude#serveMockQuestion",
      "aptitude#advanceMockSection",
      "aptitude#finaliseMockAttempt",
      "aptitude#answerPractice",
      "aptitude#recordPracticeQuestionServed",
    ],
    // The clock route (GET /api/aptitude/attempts/[attemptId]/clock) is NOT
    // listed. `capabilities.test.ts` requires a binding for the admin and
    // super trees and for every MUTATING api route, and refuses a binding for
    // anything else — so listing a plain student GET fails the fence as
    // stale. It guards with requireActionUser() plus an ownership `where`,
    // and returns only this candidate's own clock. Widening the fence to
    // cover student GETs is recorded in docs/OPEN-QUESTIONS.md and is not a
    // change to make inside a slice.
    routes: [],
  },
  {
    key: "integrity.appeal",
    label: "Read my own sitting report and appeal a decision",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["appeals#submitAppeal"],
  },
  {
    key: "notes.manage",
    label: "Write my notes",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["notes#createNote", "notes#updateNote", "notes#deleteNote", "notes#previewNote"],
  },
  {
    key: "contests.enter",
    label: "Enter contests",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["contests#registerForContest", "contests#startVirtualContest"],
  },
  {
    key: "bookmarks.manage",
    label: "Bookmark problems",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["bookmarks#toggleBookmark"],
  },
  {
    key: "help.reveal",
    label: "Reveal hints and editorials",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["help#revealHint", "help#viewEditorial"],
  },
  {
    key: "notifications.manage",
    label: "Mark my notifications read",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["notifications#markNotificationRead", "notifications#markAllNotificationsRead"],
  },
  {
    key: "plans.enroll",
    label: "Join, leave or change a study plan",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["plans#enrollInPlan", "plans#leavePlan", "plans#changeEnrollment"],
  },
  {
    key: "profile.manage",
    label: "Edit my profile settings",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["profile#saveProfileSettings"],
  },
  {
    /**
     * Phase 11b. Every signed-in role, because a password is not a student
     * thing: until this existed, nobody at all could change the password
     * they sign in with, super-admins included.
     *
     * It is a capability of its own rather than part of `profile.manage`
     * because a password is not a profile setting — it needs the current
     * password, it is rate-limited, and it ends every session.
     */
    key: "account.password",
    label: "Change my own password",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["profile#changeMyPassword"],
  },
  {
    /**
     * Phase 8a. A student asks for their own leave and calls off their own
     * leave; a super-admin decides it, under `calendar.manage`.
     *
     * Self-service on purpose, and it must STAY self-service: from Phase 8e
     * this surface is part of the route out of an inactivity restriction, and
     * a route out that is itself behind the restriction is not a route out.
     */
    key: "account.leave",
    label: "Ask for leave to be excused, call off my own request, restore my own account",
    roles: EVERY_SIGNED_IN_ROLE,
    /**
     * `account#selfClearRestriction` is `requireActionUser()` and NOTHING
     * stronger, on purpose. SPEC §7: "do not require admin approval to clear
     * a soft restriction" — because approval turns a ten-day lapse into a
     * permanent exit, the administrator being busy and the student giving up.
     * Anybody who later moves it to a staff guard will have removed the route
     * out of a restriction.
     */
    actions: [
      "account#requestLeaveException",
      "account#cancelLeaveException",
      "account#selfClearRestriction",
    ],
  },
  {
    /**
     * Phase 9f. A student signs their OWN record and can withdraw it. Self
     * service, because it is their record: there is no path here that exports
     * somebody else, and an officer who wants cohort data has the CSV, which
     * records who asked.
     */
    key: "profile.export",
    label: "Make and withdraw a signed copy of my own record",
    roles: EVERY_SIGNED_IN_ROLE,
    actions: ["profile-export#createProfileExport", "profile-export#revokeProfileExport"],
  },
] as const satisfies readonly Capability[]);

/**
 * The placement cell's capabilities (Phase 9).
 *
 * Its own tier, not a slice of STAFF, because the role boundary is the whole
 * reason the role exists. An officer reads cohort analytics and nothing else:
 * no authoring, no moderation, no role change, no account status, and no
 * route to a student's private work. `tests/repo/placement-fence.test.ts`
 * holds the model allowlist, and `capabilityMatrix().PLACEMENT_OFFICER` is
 * asserted as an EXACT set so a capability granted here by accident fails
 * rather than ships.
 */
export const PLACEMENT_CAPABILITIES = deepFreeze([
  {
    key: "placement.analytics",
    label: "Read cohort placement analytics",
    roles: PLACEMENT,
    actions: [],
    pages: [
      "app/placement-cell/page.tsx",
      "app/placement-cell/heatmap/page.tsx",
      "app/placement-cell/at-risk/page.tsx",
      "app/placement-cell/aptitude/page.tsx",
    ],
  },
  {
    /**
     * The per-student view. Its own capability because it is the one
     * placement surface that reads ONE named student, and every view of it
     * writes an `AuditLog` row — so "who looked at whom" is answerable, which
     * is the whole difference between analytics and surveillance.
     */
    key: "placement.drilldown",
    label: "Open one student's coverage, with an audit row",
    roles: PLACEMENT,
    actions: [],
    pages: ["app/placement-cell/students/[id]/page.tsx"],
  },
  {
    /**
     * The CSV. Separate again, because an export leaves the platform: a file
     * on a laptop is outside every guard in this repo, which is why the route
     * records who asked, for which cohort, and a digest of what they were
     * given.
     */
    key: "placement.export",
    label: "Export the cohort as a spreadsheet",
    roles: PLACEMENT,
    actions: [],
    routes: ["app/api/placement/export/route.ts#POST"],
    pages: ["app/placement-cell/export/page.tsx"],
  },
  {
    /**
     * Routing a student to a named mentor. Its own capability rather than
     * part of `placement.analytics`, because it is the one thing on these
     * surfaces that WRITES to anything about a student — and the only
     * consequence the at-risk list can have is that a named person is asked
     * to talk to somebody.
     */
    key: "placement.mentor.route",
    label: "Ask a mentor to follow up with a student",
    roles: PLACEMENT,
    actions: ["placement-mentor#assignMentor", "placement-mentor#endAssignment"],
  },
  {
    key: "placement.drives",
    label: "Keep the list of company drives",
    roles: PLACEMENT,
    actions: ["placement-drives#createDrive", "placement-drives#archiveDrive"],
    pages: [
      "app/placement-cell/drives/page.tsx",
      "app/placement-cell/drives/new/page.tsx",
      "app/placement-cell/drives/[id]/page.tsx",
    ],
  },
  {
    /**
     * The one capability in the product that records a judgement about a
     * student's opportunities. Its own, so the matrix shows it alone: SPEC
     * §5 says eligibility is a human decision recorded in the audit log, and
     * the database refuses a decision with no audit row in the same
     * transaction.
     */
    key: "placement.eligibility.decide",
    label: "Record a human eligibility decision for a drive",
    roles: PLACEMENT,
    actions: ["placement-drives#recordEligibility"],
  },
] as const satisfies readonly Capability[]);

/**
 * The mentor of record's capabilities (Phase 9).
 *
 * One live capability and three declared for Phase 11. The three are
 * declared NOW rather than added later because the spec names discussion
 * moderation as part of the ROLE: a role whose powers arrive two phases after
 * the role is a role nobody can reason about, and a declared-but-unwired
 * capability fails its own test the day the models appear.
 */
export const MENTOR_CAPABILITIES = deepFreeze([
  {
    key: "mentor.mentees.view",
    label: "See my mentees and their coverage",
    roles: MENTOR,
    actions: [],
    pages: ["app/mentor/page.tsx", "app/mentor/[menteeId]/page.tsx"],
  },
  /**
   * All three are gated on the DISCUSSION models, including the editorial
   * one. `Editorial` already exists — it is the Phase 3 problem editorial,
   * written through the ADMIN authoring pipeline, and a mentor gets no part
   * of that. What arrives in Phase 11 is the community surface: a mentor's
   * explanation attached to a thread. Gating it on a model that already
   * exists would make the test demand wiring for a power that has nowhere
   * to be wired.
   */
  {
    key: "mentor.discussion.moderate",
    label: "Moderate discussion",
    roles: MENTOR,
    actions: [],
    arrives: { phase: 11, models: ["DiscussionPost", "DoubtThread"] },
  },
  {
    key: "mentor.solution.editorial",
    label: "Explain a solution on a thread",
    roles: MENTOR,
    actions: [],
    arrives: { phase: 11, models: ["DiscussionPost", "DoubtThread"] },
  },
  {
    key: "mentor.doubts.answer",
    label: "Answer student doubts",
    roles: MENTOR,
    actions: [],
    arrives: { phase: 11, models: ["DoubtThread"] },
  },
] as const satisfies readonly Capability[]);

/** The one action that works DURING an impersonation (guard requireImpersonator()). */
export const IMPERSONATOR_ACTIONS: readonly ActionRef[] = Object.freeze(["super-impersonate#endImpersonation"] as const);

/** Needs no session: signing out must always work (it is not wrapped in runAction). */
export const PUBLIC_ACTIONS: readonly ActionRef[] = Object.freeze(["auth#logout"] as const);

/**
 * Needs no session. Three, and each for a different reason:
 *
 *   - the sign-in form posts to login, where the credential IS the
 *     authentication;
 *   - `/api/health` is read by a load balancer and by the deploy script,
 *     neither of which has a session, and it discloses nothing a visitor
 *     could not infer — counts, never names, ids or slugs;
 *   - `/api/metrics` is authenticated by a BEARER TOKEN rather than by a
 *     role (`METRICS_TOKEN`), because the caller is Prometheus. It is listed
 *     here because it holds no session, not because it is open: with the
 *     token unset the endpoint is disabled, and a wrong token gets a 404
 *     rather than a 401, which would advertise that an endpoint worth
 *     guessing a token for exists.
 *   - `/api/vitals` takes a performance number from a browser and stores it
 *     in a histogram with no identity in the key. A session would buy
 *     nothing — there is nobody to attribute the number to — and would cost
 *     the measurements that matter most: a beacon fires while the document
 *     is being torn down, which is exactly when a cookie may have expired.
 *     What makes it safe is the shape of what it can do: three fields, a
 *     closed list of metrics and routes, bucketed before storage, rate
 *     limited per hashed address, and 204 to everything so it cannot be used
 *     to enumerate anything.
 */
export const PUBLIC_ROUTES: readonly RouteRef[] = Object.freeze([
  "app/api/auth/login/route.ts#POST",
  /**
   * Phase 11a: the two halves of "set a password". Unauthenticated by
   * nature — the people who need them have never signed in, or cannot —
   * and neither can be guarded without making it useless. Asking for a
   * link answers identically whether or not the account exists, and
   * spending one requires the link itself (lib/auth/password-reset.ts).
   */
  "app/api/auth/forgot-password/route.ts#POST",
  "app/api/auth/reset-password/route.ts#POST",
  "app/api/health/route.ts#GET",
  "app/api/metrics/route.ts#GET",
  "app/api/vitals/route.ts#POST",
] as const);

export type StaffCapabilityKey = (typeof STAFF_CAPABILITIES)[number]["key"];
export type PlacementCapabilityKey = (typeof PLACEMENT_CAPABILITIES)[number]["key"];
export type MentorCapabilityKey = (typeof MENTOR_CAPABILITIES)[number]["key"];
export type SelfServiceCapabilityKey = (typeof SELF_SERVICE_CAPABILITIES)[number]["key"];
export type CapabilityKey =
  | SuperAdminCapabilityKey
  | StaffCapabilityKey
  | PlacementCapabilityKey
  | MentorCapabilityKey
  | SelfServiceCapabilityKey;
export type CapabilityTier = "super-admin" | "staff" | "placement" | "mentor" | "self-service";

export const CAPABILITIES: readonly Capability<CapabilityKey>[] = Object.freeze([
  ...SUPER_ADMIN_CAPABILITIES,
  ...(STAFF_CAPABILITIES as readonly Capability<StaffCapabilityKey>[]),
  ...(PLACEMENT_CAPABILITIES as readonly Capability<PlacementCapabilityKey>[]),
  ...(MENTOR_CAPABILITIES as readonly Capability<MentorCapabilityKey>[]),
  ...(SELF_SERVICE_CAPABILITIES as readonly Capability<SelfServiceCapabilityKey>[]),
]);

const BY_KEY: ReadonlyMap<string, Capability<CapabilityKey>> = new Map(CAPABILITIES.map((c) => [c.key, c]));
const TIER: ReadonlyMap<string, CapabilityTier> = new Map([
  ...SUPER_ADMIN_CAPABILITIES.map((c) => [c.key, "super-admin"] as const),
  ...STAFF_CAPABILITIES.map((c) => [c.key, "staff"] as const),
  ...PLACEMENT_CAPABILITIES.map((c) => [c.key, "placement"] as const),
  ...MENTOR_CAPABILITIES.map((c) => [c.key, "mentor"] as const),
  ...SELF_SERVICE_CAPABILITIES.map((c) => [c.key, "self-service"] as const),
]);

/** Does `role` hold capability `key`? Unknown keys are never held. */
export function roleHas(role: Role, key: CapabilityKey): boolean {
  return BY_KEY.get(key)?.roles.includes(role) ?? false;
}

/** Alias of roleHas. */
export const can = roleHas;

/** Which tier a capability belongs to. */
export function capabilityTier(key: CapabilityKey): CapabilityTier {
  const tier = TIER.get(key);
  if (!tier) throw new Error(`unknown capability ${key}`);
  return tier;
}

/** Every role with the capability keys it holds (in CAPABILITIES order). */
export function capabilityMatrix(): Readonly<Record<Role, readonly CapabilityKey[]>> {
  const matrix = {} as Record<Role, readonly CapabilityKey[]>;
  for (const role of ROLES) {
    matrix[role] = Object.freeze(CAPABILITIES.filter((c) => c.roles.includes(role)).map((c) => c.key));
  }
  return Object.freeze(matrix);
}

/**
 * The matrix as a Markdown table: one row per capability, one column per
 * role. docs/SECURITY.md carries exactly this between its
 * `capability-matrix` markers (a test compares them; RECX_UPDATE_DOCS=1
 * rewrites the doc).
 */
export function capabilityMatrixMarkdown(): string {
  const bound = (c: Capability) =>
    c.arrives
      ? `arrives in Phase ${c.arrives.phase}`
      : [
          c.actions.length ? `${c.actions.length} action${c.actions.length === 1 ? "" : "s"}` : "",
          c.routes?.length ? `${c.routes.length} route${c.routes.length === 1 ? "" : "s"}` : "",
          c.pages?.length ? `${c.pages.length} page${c.pages.length === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(", ");
  const lines = [
    `| Capability | Tier | ${ROLES.join(" | ")} | Bound to |`,
    `| --- | --- | ${ROLES.map(() => ":---:").join(" | ")} | --- |`,
    ...CAPABILITIES.map(
      (c) =>
        `| \`${c.key}\` | ${capabilityTier(c.key)} | ${ROLES.map((r) => (c.roles.includes(r) ? "yes" : "-")).join(" | ")} | ${bound(c)} |`,
    ),
  ];
  const list = (refs: readonly string[]) => refs.map((r) => `\`${r}\``).join(", ");
  return [
    ...lines,
    "",
    `Not capabilities: ${SUPER_ADMIN_SUPPORTING_ACTIONS.length} SUPER_ADMIN supporting actions (${list(SUPER_ADMIN_SUPPORTING_ACTIONS)}), ` +
      `${SUPER_ADMIN_SUPPORTING_PAGES.length} supporting pages (${list(SUPER_ADMIN_SUPPORTING_PAGES)}); ` +
      `impersonator only: ${list(IMPERSONATOR_ACTIONS)}; public: ${list([...PUBLIC_ACTIONS, ...PUBLIC_ROUTES])}.`,
  ].join("\n");
}

/** Every ActionRef the map knows, with the role set that may call it (public actions: none needed). */
export function actionRoles(): ReadonlyMap<ActionRef, readonly Role[]> {
  const out = new Map<ActionRef, readonly Role[]>();
  for (const capability of CAPABILITIES) {
    for (const action of capability.actions) out.set(action, capability.roles);
  }
  for (const action of SUPER_ADMIN_SUPPORTING_ACTIONS) out.set(action, SUPER_ONLY);
  return out;
}
