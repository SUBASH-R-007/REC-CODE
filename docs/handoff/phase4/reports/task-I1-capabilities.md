You are Phase 4 integration agent "I1 capabilities & role×capability matrix". First read C:\Users\SUBASH\AppData\Local\Temp\claude\C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE\488a8ed9-9b4f-4a0f-9859-3a195105ba00\scratchpad\p4design\INTEGRATION-COMMON.md in full and follow it (it points you to STREAM-COMMON.md, PLAN.md, FOUNDATION-REPORT.md, the stream reports stream-*.md and the spec). Then do this task.

TASK: complete the role × capability model and make the spec's gate test "the role × capability matrix test passes" cover the WHOLE app, not only the super-admin capabilities.

OWNED FILES
- apps/web/src/lib/auth/capabilities.ts (governance created it; you extend it)
- apps/web/test/capability-matrix.test.ts and apps/web/test/capabilities.test.ts (extend them)
- tests/repo/action-guards.test.ts and tests/repo/support/action-guards.ts (extend them)
- a new apps/web/test/support/capability-bindings.ts if useful
- the "Role × capability matrix" section of docs/SECURITY.md

Read super-governance.md §3 and §9 and gate-tests.md §4.4 first. Then:
1. Keep SUPER_ADMIN_CAPABILITIES exactly the spec's twelve.
2. Fill STAFF_CAPABILITIES so that EVERY exported action in apps/web/src/server/actions/admin-*.ts (admin-judge, admin-roster, admin-students, admin-plans, admin-announcements, admin-accommodations, admin-problems, admin-problem-content) and every app/api/admin/**/route.ts method is bound to exactly one capability.
   - Use meaningful keys, e.g. judge.operate, students.view, students.signOut, roster.import, plans.manage, announcements.manage, accommodations.request, problems.author, problems.review, problems.publish, problems.import.
   - Roles are ADMIN and SUPER_ADMIN unless the code says otherwise. Read each action's actual guard and record it as it is; do not invent.
   - Super-only actions that are not among the twelve stay in SUPER_ADMIN_SUPPORTING_ACTIONS: accommodation approve/reject/revoke, the privileged-operation decisions, grantJudgeQuotaOverride, branding preview, test email, submission-purge request.
3. Add SELF_SERVICE capabilities covering every requireActionUser action (judge submit/run, drafts, notes, bookmarks, help reveals, notifications, plans enrol, profile, xp-settings if any …), with all roles that the guard admits, plus the PUBLIC set (logout; /api/auth/login is a route).
4. Add the PAGE dimension: every page.tsx under app/admin/** and app/super/** maps to the capability or guard it requires.
5. Completeness tests:
   - every export of every "use server" file is in exactly one capability or list (no orphans, no duplicates);
   - every action's REAL guard, parsed with the TypeScript compiler API as governance's capabilities.test.ts already does, matches the roles the capability declares — if the code admits ADMIN, the capability must list ADMIN, and vice versa;
   - every admin and super page calls a guard consistent with its capability.
6. Runtime matrix (capability-matrix.test.ts):
   - for every role in [STUDENT, TA_MENTOR, ADMIN, PLACEMENT_OFFICER, SUPER_ADMIN] plus signed-out, call every bound action with real guards and a DB proxy that throws on access;
   - a denied role gets exactly the Forbidden/Unauthorized result, with no DB access, no audit and no enqueue;
   - an allowed role passes the guard;
   - an impersonating SUPER_ADMIN gets the read-only refusal on every mutation;
   - pages: a denied role is redirected to homeForRole(role), or to /login when signed out, before any DB access.
7. capabilityMatrix() renders a Markdown table (roles × capability keys). Write it into docs/SECURITY.md between the markers <!-- capability-matrix:start --> and <!-- capability-matrix:end -->. A test fails if the doc table differs from the code; RECX_UPDATE_DOCS=1 rewrites it.

Run the tests on Windows. Report the matrix dimensions and the counts.