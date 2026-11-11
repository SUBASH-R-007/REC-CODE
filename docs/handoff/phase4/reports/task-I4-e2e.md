You are Phase 4 integration agent "I4 e2e specs + accounts". First read C:\Users\SUBASH\AppData\Local\Temp\claude\C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE\488a8ed9-9b4f-4a0f-9859-3a195105ba00\scratchpad\p4design\INTEGRATION-COMMON.md in full and follow it (it points you to STREAM-COMMON.md, PLAN.md, FOUNDATION-REPORT.md, the stream reports stream-*.md and the spec). Then do this task.

TASK: write the Playwright side of the Phase 4 gate. It runs in the live stage, against the WSL dev server at http://localhost:3000 with a live judge, so it must be correct by construction now.

OWNED FILES
- apps/web/playwright.config.ts
- apps/web/e2e/** (global-setup.ts, support/*, the new specs and README.md)
- apps/web/e2e/a11y.spec.ts (append rows only)

Read gate-tests.md §5, the authoring stream's report "Requests" (stream-C-authoring.md) and judge-transparency.md §7, and look at how the existing specs and global-setup work. The sign-in is a no-JS form POST to /api/auth/login; check global-setup.

1. accounts and global-setup:
   - add staffAdmin (RECADMIN02, ADMIN scoped to CSE), super2 (RECSUPER02), authoring student 2116231001004 and an ECE student 2116226002001;
   - passwords come from the env vars SEED_ADMIN_PASSWORD / SEED_STUDENT_PASSWORD, which the existing setup already reads; never print them;
   - sign them in once in global-setup and store their state, and warm /admin/problems, /admin/problems/new and /super for staff.
2. playwright.config projects, each with its own outputDir (follow the existing pattern):
   - "rbac": no judge needed;
   - "authoring": E2E_JUDGE=1 only, serial;
   - "judge": judge-page.spec.ts already exists, written by stream E.
3. e2e/rbac.spec.ts:
   - a student visiting any /admin/** or /super/** URL ends on /dashboard;
   - RECADMIN02 visiting /super/** ends on /admin;
   - RECADMIN02 on /admin/students sees CSE roll numbers and NO ECE roll numbers, and an ECE student's /admin/students/<id> returns 404;
   - a super-admin sees the strip "Super-admin — all actions are audited" on every /super page;
   - impersonation: as RECADMIN01, start an impersonation of a student with a 20+ character reason, and confirm the banner appears and a draft save or other mutation is refused with the read-only message; end it, and confirm the audit rows exist via /super/audit;
   - an unauthenticated POST to /api/admin/problems/import returns 403.
4. e2e/authoring-journey.spec.ts, implementing gate-tests.md §5 with the real accessible names from the authoring report. Approval must be by a DIFFERENT admin than the creator:
   1. RECADMIN01 creates the problem, then adds tests and references, starting with a WRONG cpp20 model.
   2. Start validation; expect the blocker "Model solution failed: … produced WA" with Publish unavailable.
   3. Fix the model, revalidate until complete, submit for review with the originality checkbox.
   4. RECADMIN02 approves.
   5. Publish; expect "Published revision 1".
   6. Student 004 submits a Python solution and gets Accepted; record the submission URL.
   7. RECADMIN01 creates a new revision with a statement marker; validate; RECADMIN02 approves; publish; expect "Published revision 2".
   8. The old submission page shows revision 1 for the student and the admin. The workspace shows the marker. A new submission shows revision 2.
   9. Crawl as the student over HTML, RSC flight (header RSC: 1) and JSON for these routes, and assert no hidden input, hidden output or reference canary appears: /problems, the workspace, both submission pages, /api/submissions/<id>, /api/search?q=<slug>, /dashboard, /profile, /u/<handle>, /leaderboard, /bookmarks, /notes, /sheets, /learn, /help, /judge. Also: /admin/problems/<id> redirects to /dashboard, and GET /api/judge/blob/<hiddenSha> returns 401.
   10. Cleanup: RECADMIN01 retires the problem, with a reason of at least 10 characters.
   Use a unique runId in slugs, a 20-minute timeout, and a validation wait that fails after 5 minutes with a hint naming RECX_SLOTS/RECX_QUEUES (the REJUDGE lane's cap needs ≥5 slots).
5. a11y.spec.ts rows, GATING, light+dark at both viewports:
   - /admin, /admin/students, /admin/students/import, /admin/cohorts, /admin/reports, /admin/announcements/new, /admin/accommodations, /admin/problems, /admin/problems/new, /admin/judge;
   - /super, /super/users, /super/roles, /super/settings/branding, /super/settings/policy, /super/settings/judge, /super/audit, /super/impersonate, /super/flags, /super/jobs, /super/data;
   - /judge, signed out.
   Use the right account per path.
6. e2e/README.md: document the projects, accounts and env vars, and how to run against the WSL stack.
7. Validate: `npx tsc --noEmit -p apps/web/e2e/tsconfig.json`, eslint on e2e, and `npx playwright test --list` for each project. Do NOT run against a server.