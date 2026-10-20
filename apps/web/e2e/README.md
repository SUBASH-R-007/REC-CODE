# REC Code end-to-end suite

Playwright specs that run against an **already running** REC Code (there is
no `webServer` block). Configuration: `apps/web/playwright.config.ts`.

| Project | Spec | Judge? | What it gates |
|---|---|---|---|
| `a11y` | `a11y.spec.ts` | no | axe-core, WCAG 2.0/2.1/2.2 A + AA tags: **zero serious or critical** violations, light and dark theme × 1366×768 and 375×812, on `/login`, `/dashboard`, `/problems`, `/problems/two-sum`, `/leaderboard`; the Phase 4 admin pages `/admin`, `/admin/students`, `/admin/students/import`, `/admin/cohorts`, `/admin/reports`, `/admin/announcements/new`, `/admin/accommodations`, `/admin/problems`, `/admin/problems/new`, `/admin/judge` (as RECADMIN02); the `/super` pages `/super`, `/super/users`, `/super/roles`, `/super/settings/branding`, `/super/settings/policy`, `/super/settings/judge`, `/super/audit`, `/super/impersonate`, `/super/flags`, `/super/jobs`, `/super/data` (as RECADMIN01); and `/judge` signed out. `/sheets`, `/learn`, `/profile`, `/notes`, `/bookmarks`, `/help`, `/admin/judge` (as RECADMIN01) and `/judge` are also scanned and **reported only**. |
| `keyboard` | `keyboard-journey.spec.ts` | steps 7–9 | the keyboard-only solving journey (below), with a visible focus indicator asserted at every stop. |
| `perf` | `perf-workspace.spec.ts` | last test | throttled workspace timings; the console overlay never hides the caret (Monaco, and the plain-textarea fallback with Monaco blocked); with `E2E_JUDGE=1`, a throttled solve from start to finish (Run and Submit Accepted, the caret checked against the console throughout). See that file's header. |
| `rbac` | `rbac.spec.ts` | no | Phase 4 RBAC at the HTTP surface (below). |
| `authoring` | `authoring-journey.spec.ts` | **yes** (skipped without `E2E_JUDGE=1`) | the Phase 4 authoring journey (below), serial, up to 20 minutes. |
| `judge` | `judge-page.spec.ts` | no | `/judge` answers 200 signed out and lists the enabled languages under their anchors; the workspace footer links the active language to its `/judge` section. |

## Accounts

All come from the seed (`apps/web/scripts/seed.ts`). Each spec acts as its
own account, so the specs never depend on each other's data.

| Key (`support/accounts.ts`) | Default account | Role | Used by | Override |
|---|---|---|---|---|
| `student` | `2116231001001` | STUDENT, CSE 2027 | axe pages; RBAC redirects; the import route refusal | `E2E_STUDENT_ID` |
| `journey` | `2116231001002` | STUDENT, CSE 2027 | keyboard journey (submits) | `E2E_JOURNEY_STUDENT_ID` |
| — | `2116231001003` | STUDENT, CSE 2027 | perf (signs itself in) | `E2E_PERF_STUDENT_ID` |
| `authoring` | `2116231001004` | STUDENT, CSE 2027 | authoring journey (submits, crawls) | `E2E_AUTHORING_STUDENT_ID` |
| `ece` | `2116226002001` | STUDENT, ECE 2026 | outside RECADMIN02's scope; the impersonation target | `E2E_ECE_STUDENT_ID` (`E2E_ECE_STUDENT_2_ID` for `2116226002002`) |
| `admin` | `RECADMIN01` | SUPER_ADMIN | authors, publishes and retires; `/super` pages; impersonates | `E2E_ADMIN_ID` |
| `staffAdmin` | `RECADMIN02` | ADMIN, AdminScope CSE / every batch | approves; scoped `/admin` pages | `E2E_STAFF_ADMIN_ID` |
| `super2` | `RECSUPER02` | SUPER_ADMIN | the second super-admin (`/super` strip) | `E2E_SUPER2_ID` |

Passwords are read from `SEED_STUDENT_PASSWORD` (students) and
`SEED_ADMIN_PASSWORD` (staff) in the environment or `apps/web/.env.local` —
the same variables the seed reads — and are never printed.

`e2e/global-setup.ts` signs every account in ONCE through the real sign-in
page (a no-JavaScript form that POSTs to `/api/auth/login`) and stores each
session under `e2e/.auth/<key>.json` (git-ignored). It also warms the dev
server's routes: the student pages, and for staff `/admin`, `/admin/problems`,
`/admin/problems/new`, `/admin/students`, `/admin/judge` and `/super`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:3000` | the running stack |
| `E2E_JUDGE` | unset | `1` = a judge worker is attached: run the verdict steps and the `authoring` project |
| `E2E_ADMIN` | unset | `0` = do not sign the staff accounts in (only for runs without staff pages) |
| `E2E_WARM` | unset | `0` = skip warming routes in global setup |
| `E2E_WORKERS` | `2` | Playwright workers |
| `E2E_PROBLEM` | `two-sum` | problem the keyboard journey and the `/judge` footer test open |
| `E2E_AXE_DETAILS` | unset | `1` = print every axe finding's markup |
| `SEED_STUDENT_PASSWORD`, `SEED_ADMIN_PASSWORD` | — | seed passwords (environment or `apps/web/.env.local`) |
| account overrides | see Accounts | |

## Running it locally

```powershell
cd apps/web
npx playwright test --project=a11y --project=keyboard --project=rbac --project=judge  # no judge needed
$env:E2E_JUDGE = "1"; npx playwright test --project=keyboard --project=authoring       # with the live judge
npx playwright show-report                                                               # HTML report
```

Browsers: Windows uses the installed Google Chrome (`channel: "chrome"`).
Linux uses Playwright's Chromium: `npx playwright install --with-deps chromium`.

### Against the WSL stack (the Phase 4 live stage)

The stack runs in the WSL mirror (`~/recx`, synced by `scripts/dev/linux-sync.sh`);
Playwright runs from Windows against `http://localhost:3000`.

1. Run the Linux gate first (`scripts/dev/linux-gate.sh` refuses to start
   while a Next server runs in WSL, and shares `.next` with `next build`).
2. Copy `apps/web/.env.local` into the mirror once (the sync never copies it).
3. In the mirror: migrate and seed (the seed creates every account above;
   it is idempotent).
4. Start, in the mirror: `corepack pnpm@9.15.9 --filter @recx/web dev` (port
   3000), `corepack pnpm@9.15.9 scheduler:dev`, and
   `corepack pnpm@9.15.9 --filter @recx/judge-worker dev`. The worker's
   `.env.local` needs `RECX_NODE_ID=dev-judge-1`, `RECX_DRIVER=isolate`,
   **`RECX_SLOTS=8`**, **`RECX_QUEUES=judge-practice,judge-run,judge-rejudge`**,
   `RECX_DEV_ALLOW_UNHARDENED_HOST=1` and `RECX_CACHE_DIR=/var/tmp/recjudge-blobs`.
   Validation runs on the REJUDGE lane, whose cap is `floor(0.2 × RECX_SLOTS)`:
   with fewer than 5 slots, or without `judge-rejudge`, validation never runs
   and the authoring journey fails after 5 minutes with that hint.
5. From Windows:

   ```powershell
   cd apps/web
   $env:E2E_JUDGE = "1"
   npx playwright test --project=a11y --project=keyboard --project=rbac --project=judge --project=authoring
   ```

Record the runs in the gate log (`docs/RUNBOOK.md` §3).

## RBAC (`rbac.spec.ts`)

* A student (`2116231001001`, and the ECE student on a sample) who opens any
  `/admin/**` page (dynamic ones with a missing id) or `/super/**` page ends
  on `/dashboard`.
* RECADMIN02 (ADMIN) who opens any `/super/**` page ends on `/admin`.
* RECADMIN02's `/admin/students` shows CSE roll numbers and no ECE roll
  number (the unfiltered list, exact searches and `?dept=ECE`); an ECE
  student's `/admin/students/<id>` answers 404 (the id is looked up as the
  super-admin, who sees the whole college), while a CSE student's answers 200.
* RECADMIN01 and RECSUPER02 see "Super-admin — all actions are audited" on
  every `/super` page.
* Impersonation: on a FRESH RECADMIN01 session (an impersonation belongs to
  the session that started it, so the stored one is never touched),
  `/super/impersonate` starts a read-only view of the ECE student with a
  20+ character reason; the banner shows; `POST /api/drafts` (the draft
  save) is refused with 403 and the read-only message; "End impersonation"
  ends it; `/super/audit` shows `impersonation.started` (with this run's
  reason) and `impersonation.ended` for the same session.
* `POST /api/admin/problems/import`: signed out and cross-site → 403;
  signed out, same origin → 401 (the staff guard: "sign in"); a student →
  403. None returns an import id.

## The authoring journey (`authoring-journey.spec.ts`)

Automates the Phase 4 manual check (author, fail validation, fix, publish,
edit the statement, older submissions keep their revision) with the
authoring pages' real accessible names. Each run has its own `runId` (slug `e2e-loud-echo-<runId>`, title
`Loud Echo <runId>`, canaries); `support/authoring.ts` holds the problem.

1. RECADMIN01 creates the draft on `/admin/problems/new`, adds 1 sample and
   3 hidden tests on `/testcases`, and adds the references: a WRONG cpp20
   "Model" (echoes the word unchanged, expected AC), a py312 model and a
   py312 deliberately-wrong solution (expected WA).
2. "Start validation": the status region shows
   `Model solution failed: … produced WA`, and Publish is disabled.
3. "Edit Model (cpp20)", fix it, validate again until complete, "Submit for
   review" with the originality checkbox.
4. RECADMIN02 approves (the approver must differ from the creator, the last
   editor and the submitter).
5. RECADMIN01 publishes: "Published revision 1".
6. Student `2116231001004` submits Python 3.12 and gets Accepted.
7. RECADMIN01 creates revision 2 with a statement marker, validates, submits;
   RECADMIN02 approves; publish: "Published revision 2".
8. The old submission page shows "Revision 1" to the student and to the
   admin; the workspace shows the marker; a new submission shows "Revision 2".
9. As the student, over HTTP (HTML, RSC flight with `RSC: 1`, JSON) and in
   the browser (every HTML, flight and JSON response), `/problems`, the
   workspace, both submission pages, `/api/submissions/<id>`,
   `/api/search?q=<slug>`, `/dashboard`, `/profile`, `/u/<handle>`,
   `/leaderboard`, `/bookmarks`, `/notes`, `/sheets`, `/learn`, `/help` and
   `/judge` contain no hidden input, hidden output or reference canary (the
   workspace must contain the sample input: positive control). As the
   student, `/admin/problems/<id>` ends on `/dashboard`, and
   `GET /api/judge/blob/<hidden sha256>` is refused: 426 without the judge
   protocol header, 401 with it (no judge node credentials).
10. RECADMIN01 retires the problem ("Confirm retirement", a 10+ character
    reason). If the run fails after publishing, `afterAll` retires it.

A run that crashes before step 5 leaves an unpublished draft (invisible to
students) in the dev database; a later run is unaffected (new runId).

## The axe gate

* Theme: `recx-theme` is written to localStorage before any page script runs
  and `prefers-color-scheme` is emulated to match; each test asserts the
  `dark` class really is (or is not) on `<html>` before scanning.
* Pages are scanned settled: network idle, no skeletons, fonts loaded, the
  workspace's real editor mounted (Monaco ≥ 768 px, CodeMirror below), and
  `prefers-reduced-motion: reduce` so no colour is measured mid-fade.
* **No rule is disabled.** One region is excluded: `nextjs-portal`, the
  Next.js development overlay that `next dev` injects into every page. It is
  not REC Code and is never shipped.
* Every scan attaches `axe-violations.json` (all impacts) and prints one
  `[axe] <page> [<viewport>, <theme>] → …` line.

## The keyboard journey

From `/problems`, with key presses only (no mouse, no `click()`, no
`fill()` after sign-in):

1. Tab to "Skip to content" (the first stop), then the **Easy** difficulty
   checkbox, Space, Tab to **Apply filters**, Enter.
2. Tab to the problem (`handle-maker`, else `two-sum`; `E2E_PROBLEM`
   overrides), Enter.
3. Focus to the main region (the skip link, unless the page already moved
   focus there), Tab to the statement panel; PageDown scrolls it.
4. Pick Python 3.12 by type-ahead on the language picker, Tab into the
   editor, type a one-line solution (one line, so nothing is auto-indented).
5. **Esc, then Tab** leaves the editor.
6. **Ctrl+M** (Ctrl+Shift+M on macOS) turns "Tab moves focus" on — Tab
   leaves — and off again — Tab stays and indents. Monaco's spoken
   confirmation is asserted to be announced and visually hidden.
7. *(E2E_JUDGE=1)* **Run** → the polite status region announces
   "Run result: Accepted." and the console shows the `AC` badge.
8. *(E2E_JUDGE=1)* **Submit** a wrong solution → "Wrong Answer"; the failing
   case (e.g. "Sample 1", with Expected / Your output) is reached by Tab.
9. *(E2E_JUDGE=1)* **Submit** the correct solution → "Accepted".
10. Shift+Tab to the **Problems** link, Enter, Tab to the row after the
    solved problem, Enter: the next problem opens.

Verdict waits allow 75 s each (queue, compile, tests on the live judge).

## CI

The `e2e` job in `.github/workflows/ci.yml` (Linux) starts Postgres and
Redis, migrates, seeds, starts `next dev` and runs the `a11y` and `keyboard`
projects. CI has no judge — a real one needs isolate and the toolchains, and
the mock driver fabricates verdicts — so `E2E_JUDGE` is unset there and steps
7–9 are reported as skipped. Only two-sum is published by the seed without a
judge, so the journey uses two-sum there and step 10 is skipped when no other
problem is listed. The judge steps run against the live local stack with
`E2E_JUDGE=1`; record those runs in the gate log (`docs/RUNBOOK.md`).
