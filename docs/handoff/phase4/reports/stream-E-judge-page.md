The /judge page, the workspace footer link and all the shared, worker and claim changes are built, and every test I added passes. Typecheck is clean for `@recx/shared` and `@recx/web`; `@recx/judge-worker` fails on one error in the harness stream's test file. Lint is clean on every file I touched.

The size check for /judge has not run against a real build yet, because no build containing /judge exists. I replayed its "page stub only" logic on the existing `.next`: /help, /u/[handle], /offline and /dashboard pass, and /problems is correctly flagged.

`jvmRunFlags` already existed when I built the page, and the worker now inserts those flags after the `java` program. So Java and Kotlin show their memory-derived flags (computed at the 256 MiB default and the 1 GiB ceiling) instead of the heap caveat. The caveat now appears only for an enabled garbage-collected runtime with no heap ceiling (Node.js, Go; both off by default).

### Files created (all mine)
- `apps/web/src/app/(public)/layout.tsx` — wraps pages in PublicShell; grants nothing.
- `apps/web/src/app/(public)/judge/page.tsx` — the page: server components only, `force-dynamic`, no guard, no next/link; if the database fails it still renders the constant sections plus a notice.
- `apps/web/src/components/shell/public-shell.tsx` — the body of `u/layout.tsx`, moved verbatim.
- `apps/web/src/lib/judge/transparency.ts` — pure view model: `buildJudgeFacts`, `RUN_OUTCOME_TEXT`, quoting and unit formatters, JVM flags via `jvmRunFlags`. It publishes only limits the judge enforces (the inode count is left out).
- `apps/web/src/lib/judge/judge-links.ts` — anchors, hrefs and `formatLanguageVersion`.
- `apps/web/src/server/queries/judge-languages.ts` — `getPublicLanguageRows` (cached, tag `language-config`, 60 s backstop) and `revalidateLanguageConfigs`. Revalidation is best effort: it logs and never throws.
- `apps/web/src/components/workspace/language-version.tsx` — the footer element; links to `/judge#lang-<key>` in a new tab.
- `apps/web/e2e/judge-page.spec.ts` — /judge returns 200 signed out; the footer link reaches the matching heading.
- Tests:
  - `packages/shared/test/run-outcome-rules.test.ts`
  - `apps/judge-worker/test/verdict-rules.test.ts` — one fixture per rule, plus an 8,640-combination grid checked against a restatement of the rules.
  - `apps/web/test/judge-transparency.test.ts`
  - `apps/web/test/judge-page.test.ts`
  - `apps/web/test/judge-page.canary.test.ts`
  - `apps/web/test/judge-page-imports.test.ts`
  - `apps/web/test/public-shell.test.ts`
  - `apps/web/test/language-version.test.ts`
  - `apps/web/test/problem-workspace-languages.test.ts`
  - `apps/web/test/judge-languages.test.ts`
  - `apps/web/test/judge-startup-credit.test.ts` (new file, instead of extending `judge-claim-constants.test.ts`)
  - `apps/web/test/help-judge-link.test.ts`

### Files changed (shared files, minimal hunks)
- `packages/shared/src/verdict.ts` — appended `RUN_OUTCOME_RULES` and `RunOutcomeRuleId`.
- `packages/shared/src/languages.ts` — appended `SANDBOX_FORCED_ENV`. The harness stream's JVM helpers appended after it are intact.
- `apps/judge-worker/src/sandbox/isolate.ts` — `FORCED_ENV = SANDBOX_FORCED_ENV`; behaviour unchanged, `argv.test.ts` still green.
- `apps/judge-worker/src/judge/verdict.ts` — comment only.
- `apps/web/src/lib/judge/claim.ts` — `Math.min(…, LIMITS.startupCredit.maxMs)` and the `LIMITS` import.
- `apps/web/src/app/u/layout.tsx` — now returns `<PublicShell>`.
- `apps/web/src/server/queries/problems.ts` — `version` select and field only; the harness stream's `functionUnavailable` is intact.
- `apps/web/src/components/workspace/workspace.tsx` — `judgeLink = true` prop, the footer uses `<LanguageVersion>`, two imports.
- `apps/web/src/app/(student)/help/page.tsx` — reads `getPublicLanguageRows()` + `buildJudgeFacts()`, links to /judge, drops the db and catalog imports.
- `apps/web/src/server/actions/admin-judge.ts` — import plus `revalidateLanguageConfigs()` after the audit in `setLanguageEnabled`.
- `apps/web/src/components/shell/nav.ts` and `nav-icon.tsx` — "Judge specifications" in the sidebar footer links, `judge: Cpu`.
- `apps/web/size-budgets.json` — /judge row (125 KB, `shared: false`), the `serverRendered` block, a monacoFree entry, one sentence in `$comment`. No existing threshold changed.
- `apps/web/scripts/size-budget.mjs` — `shared !== false` filter and the new serverRendered check (report line, JSON output, exit code). Every existing check is unchanged.
- `apps/web/e2e/a11y.spec.ts` — appended `{ path: "/judge", as: null, gating: false }`.
- `apps/web/test/sw-routes.test.ts` — /judge row, expected "navigate".
- `apps/web/test/shell-nav.test.ts` — **not in my ownership list.** One-line change to the expected secondary links (`["/help", "/judge", "/accessibility"]`); adding the nav item breaks the old assertion otherwise.
- `docs/JUDGE.md` — new §13 "The public /judge page".
- `docs/OPEN-QUESTIONS.md` — new `### Phase 4 — E /judge transparency` (13 entries).

### Tests run
Unit commands (Windows):
- `npx pnpm@9.15.9 --filter @recx/shared exec vitest run` → 16 files, 434 passed (`run-outcome-rules.test.ts`: 5).
- `npx pnpm@9.15.9 --filter @recx/judge-worker exec vitest run` → 22 files, 390 passed (`verdict-rules.test.ts`: 12; `argv.test.ts`: 54).
- `npx pnpm@9.15.9 --filter @recx/web exec vitest run <my files + touched existing>` → 14 files, 222 passed.
- `npx vitest run --config vitest.repo.config.ts tests/repo` → 5 files, 117 passed (forbidden words, single source and the rest).

Per-file counts for the web run:

| Test file | Passed |
|---|---|
| judge-transparency | 43 |
| judge-page | 12 |
| judge-page.canary | 2 |
| judge-page-imports | 4 |
| public-shell | 4 |
| language-version | 5 |
| problem-workspace-languages | 1 |
| judge-languages | 6 |
| judge-startup-credit | 3 |
| help-judge-link | 1 |
| sw-routes (existing) | 85 |
| shell-nav (existing) | 28 |
| admin-judge (existing) | 17 |
| help-render (existing) | 11 |

Full web suite, run before I added `help-judge-link`: 1,021 passed, 87 skipped. The only failures were 6 in `seed-content.test.ts`, which is D1/D2 seed content, not my code.

`admin-judge.test.ts` passes but now logs one warning ("could not revalidate"), because the real `next/cache` runs outside a request. That is the intended best-effort path.

No database tests; this stream needed none.

### Typecheck and lint
- `npx pnpm@9.15.9 --filter <pkg> typecheck`: shared exit 0, web exit 0 (includes e2e).
- judge-worker exit 2 from `test/function-compare-job.test.ts(42,3)` TS2322, the harness stream's in-progress file. I did not touch it.
- `npx eslint --max-warnings=0 <all 36 touched or created paths>` → exit 0.

### Requests
- **`apps/web/playwright.config.ts`** (integration): `judge-page.spec.ts` matches no project, so it will not run until one is added, e.g. `{ name: "judge", testMatch: /judge-page\.spec\.ts$/, outputDir: "./test-results/judge" }`. `e2e/README.md` should also list /judge among the reported a11y pages.
- **D1 / integration:** link "scaled for other languages" in `components/workspace/problem-description.tsx` to `/judge#time-limits`. That file is D1's, so I left it.
- No schema changes or dependencies needed.

### Unfinished
- **TODO, integration:** after the build, run `pnpm --filter @recx/web size` to measure /judge (expect about 117 KB first-load and roughly 0.2 KB of its own). Then add the /judge line to `docs/CAPACITY.md` "Front-end budgets". I left the doc untouched.
- **RUNBOOK:** the manual check from design §8 (open /judge signed out; toggle a language and see it reflected; footer link lands on the right anchor) is left for the live stage. The task named only JUDGE.md and OPEN-QUESTIONS.