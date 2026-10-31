# Phase 4 design: public `/judge` transparency page and workspace footer

## 0. Decisions and findings that affect the design

1. **`/judge` is public.** Signed-out visitors can open it, as the spec says. It reads only two things: `LanguageConfig` rows where `enabled && isCurrent`, and constants from `@recx/shared`. It reads no user, node, problem or test data. Signed-in viewers get the normal AppShell and signed-out viewers get the minimal header, the same split as `apps/web/src/app/u/layout.tsx:13-33`. The page calls no guard because it is public by design. Every other guard is untouched.
2. **Flags and multipliers come from `LanguageConfig.runtime` (jsonb), not `LANGUAGE_CATALOG`.** At claim time the worker receives that JSON (`claim.ts:304,314`, parsed at `job-spec.ts:198-201`). `fallbackMultiplier` is read from it too (`job-spec.ts:264-270`). `/help` currently reads the catalog instead (`(student)/help/page.tsx:103,238-246`), which can drift from what the worker gets. Nothing in argv or env is secret: any submission can already print its own environment.
3. **Two `LIMITS` fields are not enforced, so the page must not publish them as rules:**
   - `LIMITS.startupCredit.maxMs`: nothing reads it. `startupCreditFor` (`apps/web/src/lib/judge/claim.ts:259-264`) passes the raw node median through, even though `limits.ts:78` says "it is capped". Fix: `Math.min(…, LIMITS.startupCredit.maxMs)` at `claim.ts:263`, plus a test. Until that lands the page omits the cap.
   - `LIMITS.scratchDisk.inodes`: there is no per-slot tmpfs (OPEN-QUESTIONS item 4). Only `scratchDisk.defaultMb` is enforced, as the artefact cap at `run-job.ts:71`.
4. **The per-test verdict order exists only in the worker.** It lives in `apps/judge-worker/src/judge/verdict.ts:4-23,92-135`, whose own comment says "published on the /judge transparency page". The web app cannot import the worker, so the order moves into `verdict.ts` in shared, and a worker test ties `classifyRun` to it (§3, §7).
5. **Size baseline, measured read-only from the existing `apps/web/.next` (BUILD_ID 2026-10-10 07:03), gzip -9:**

   | Route | First-load JS |
   |---|---|
   | Framework (rootMainFiles) | 100.4 KB |
   | `/u/[handle]` | 117.0 KB |
   | `/help` | 116.8 KB |
   | `/offline` | 111.2 KB |
   | `/login` | 113.6 KB |

   - **Phase 3 gate risk (not this stream's job):** `/login` is over its 90 KB budget, and the framework alone is over 90 KB.
   - Server-only pages add one ~0.2 KB page stub chunk whose only module is named `"apps/web"`. That is the target shape for `/judge`.
   - `docs/CAPACITY.md` has no "Front-end budgets" section yet, although `size-budgets.json` refers to one.
6. **Workspace footer.** It already shows `active.label` (`workspace.tsx:487-489`). The narrow reading is to show the version from `LanguageConfig.version` (not parsed out of the label), linked to `/judge#lang-<key>`. Showing the per-language time limit in the footer goes beyond that reading, so it is listed as an open question.
7. **Prisma: no changes.** The existing `LanguageConfig` (`schema.prisma:528-546`) already has `key`, `label`, `version`, `toolchainId`, `runtime`, `enabled` and `isCurrent`. No migration.

## 1. Files

**Create:**

| Path | Purpose |
|---|---|
| `apps/web/src/app/(public)/layout.tsx` | `export default async function PublicLayout({children})` returning `<PublicShell>{children}</PublicShell>` |
| `apps/web/src/app/(public)/judge/page.tsx` | The page (§4) |
| `apps/web/src/components/shell/public-shell.tsx` | `export async function PublicShell({ children }: { children: React.ReactNode })`, the body of `u/layout.tsx:13-33` moved verbatim |
| `apps/web/src/lib/judge/transparency.ts` | Pure view-model builder (§3). No `server-only`, no db |
| `apps/web/src/lib/judge/judge-links.ts` | Tiny module, type-only import from `@recx/shared` so the client workspace bundle stays clean |
| `apps/web/src/server/queries/judge-languages.ts` | `server-only` cached query (§3) |
| `apps/web/src/components/workspace/language-version.tsx` | Footer element (§5). No directive; imported by the client `workspace.tsx` |
| Tests | Listed in §7 |

**Modify:**

| Path | Change |
|---|---|
| `packages/shared/src/verdict.ts` | Append `RUN_OUTCOME_RULES` and `RunOutcomeRuleId`. Already exported through `export * from "./verdict"`, so **no `index.ts` edit** |
| `packages/shared/src/languages.ts` | Append `SANDBOX_FORCED_ENV`. Same: no `index.ts` edit |
| `apps/judge-worker/src/sandbox/isolate.ts:45` | `const FORCED_ENV = SANDBOX_FORCED_ENV;` imported from `@recx/shared`. Behaviour identical; `argv.test.ts` stays green |
| `apps/judge-worker/src/judge/verdict.ts:4-23` | Comment points to `RUN_OUTCOME_RULES`. No logic change |
| `apps/web/src/lib/judge/claim.ts:263` | Startup-credit cap (finding 3) |
| `apps/web/src/app/u/layout.tsx` | Becomes `return <PublicShell>{children}</PublicShell>`. Its chunk set does not change |
| `apps/web/src/server/queries/problems.ts` | `WorkspaceLanguage` (`:214-221`) gains `version: string`. The select at `:300-304` adds `version: true`, and the push at `:312-317` adds `version: config.version` |
| `apps/web/src/components/workspace/workspace.tsx` | New prop `judgeLink?: boolean` (default `true`). Lines 487-489 become `<LanguageVersion label={active.label} version={active.version} href={judgeLink ? judgeLanguageHref(active.key) : null} />` |
| `apps/web/src/components/workspace/problem-description.tsx:63-64` | "scaled for other languages" becomes `<Link href="/judge#time-limits">` (server component) |
| `apps/web/src/app/(student)/help/page.tsx` | Read languages through `getPublicLanguageRows()` + `buildJudgeFacts()` instead of `LANGUAGE_CATALOG` (`:98-103,238-246`). Add "Exact versions, flags and every limit: Judge specifications" linking to `/judge` in `#limits` |
| `apps/web/src/server/actions/admin-judge.ts` | Inside `setLanguageEnabled` (`:233-283`), after the existing `audit()`, call `revalidateLanguageConfigs()`. No new audit row |
| `apps/web/src/components/shell/nav.ts:73-76` | *Optional:* `SECONDARY_NAV` adds `item("/judge", "Judge specifications", "judge", "Compiler versions, flags, limits and verdict rules")`. `NavIconKey` adds `"judge"`; `nav-icon.tsx:17` maps `judge: Cpu`. `shell-nav.test.ts` checks the page exists |
| `apps/web/size-budgets.json`, `apps/web/scripts/size-budget.mjs` | §6 |
| `apps/web/e2e/a11y.spec.ts:85-106` | Add `{ path: "/judge", as: null, gating: false }` as reported, not gating (the Phase 4 gate does not list `/judge`) |
| `apps/web/test/sw-routes.test.ts` | TABLE row `["judge transparency page", { url: "/judge" }, "navigate"]` |
| Docs | `docs/JUDGE.md` new §13 "The public /judge page" (sources, publish-only-enforced rule) and fix §7 "FUNCTION … until Phase 4" if the harness stream changes it. `docs/OPEN-QUESTIONS.md` Phase 4 entries (§9). `docs/CAPACITY.md` "Front-end budgets" with the `/judge` numbers. `docs/RUNBOOK.md` manual check (§8) |

No `/judge` route conflict: `middleware.ts:78` only skips `api/judge/`, so `/judge` gets the CSP. `/admin/judge` is a different path, and the SW classifies by the `/admin` prefix.

## 2. Shared additions (exact)

**`packages/shared/src/verdict.ts` (append):**
```ts
/**
 * How ONE test's run is classified, in order: the first matching rule wins.
 * apps/judge-worker/src/judge/verdict.ts classifyRun() implements it
 * (apps/judge-worker/test/verdict-rules.test.ts binds the two). Published on /judge.
 */
export const RUN_OUTCOME_RULES = [
  { id: "sandbox-failure", verdict: "IE" },        // isolate status XX (retried, never charged)
  { id: "output-trip", verdict: "OLE" },           // supervisor early stdout trip
  { id: "time-limit", verdict: "TLE" },            // status TO (idle variant admin-only)
  { id: "cpu-overrun", verdict: "TLE" },           // ended inside --extra-time, CPU > limit
  { id: "memory-limit", verdict: "MLE" },          // cg-oom-killed or cg-mem ≥ limit
  { id: "file-size-signal", verdict: "OLE" },      // SIGXFSZ
  { id: "signal", verdict: "RE" },                 // any other signal
  { id: "runtime-out-of-memory", verdict: "MLE" }, // JVM OutOfMemoryError / Python MemoryError
  { id: "exit-code", verdict: "RE" },              // non-zero exit
  { id: "compare", verdict: null },                // clean exit: compare mode / checker decides
] as const satisfies readonly { id: string; verdict: Verdict | null }[];
export type RunOutcomeRuleId = (typeof RUN_OUTCOME_RULES)[number]["id"];
```
This sits under `packages/shared/src`, which `single-source.test.ts` excludes from its scan.

**`packages/shared/src/languages.ts` (append):**
```ts
/** Set by the sandbox for every program; a language cannot override them. */
export const SANDBOX_FORCED_ENV = Object.freeze({ HOME: "/box", LANG: "C.UTF-8" } as const);
```

## 3. Web modules (exact exports)

**`apps/web/src/lib/judge/judge-links.ts`:**
```ts
import type { LanguageKey } from "@recx/shared";
export const JUDGE_PAGE_PATH = "/judge";
export function judgeLanguageAnchor(key: LanguageKey): string;   // `lang-${key}`
export function judgeLanguageHref(key: LanguageKey): string;     // `/judge#lang-${key}`
export function formatLanguageVersion(label: string, version: string): string;
// label.includes(version) || !version ? label : `${label} · ${version}`
```

**`apps/web/src/server/queries/judge-languages.ts`** (pattern from `lib/brand/theme.ts:21-29,60-62`):
```ts
import "server-only";
export const LANGUAGE_CONFIG_TAG = "language-config";
export interface PublicLanguageRow { key: string; label: string; version: string; toolchainId: string; runtime: unknown }
export const getPublicLanguageRows: () => Promise<PublicLanguageRow[]>;
// unstable_cache(db.languageConfig.findMany({ where: { enabled: true, isCurrent: true },
//   select: { key, label, version, toolchainId, runtime }, orderBy: { key: "asc" } }),
//   ["judge-public-languages","v1"], { tags: [LANGUAGE_CONFIG_TAG], revalidate: 60 })
export function revalidateLanguageConfigs(): void;   // revalidateTag(LANGUAGE_CONFIG_TAG)
```
The 60 s backstop covers the seed and any writer that forgets to revalidate.

**`apps/web/src/lib/judge/transparency.ts`** (pure). It reuses:
- `deriveTimeLimitMs`, `wallTimeSecFor` and `earlyOleCapBytes` from `limits.ts:85-130`;
- `languageRuntimeSchema` from `protocol.ts:121-138`;
- `VERDICT_PRECEDENCE` from `verdict.ts:76-87`;
- `RUN_OUTCOME_RULES` and `SANDBOX_FORCED_ENV`.
```ts
export const EXAMPLE_BASE_MS = 1_000;               // illustrative input, not a fact
export const WALL_EXAMPLES_MS = [1_000, 2_000] as const;
export function displayArgv(argv: readonly string[]): string;   // POSIX single-quote only where needed
export function formatKib(kb: number): string;      // "256 MiB (262,144 KiB)"
export function formatBytesExact(bytes: number): string;
export function formatMs(ms: number): string;       // "1.5 s" / "300 ms"
export interface JudgeLanguageFact {
  key: LanguageKey; anchor: string; label: string; version: string; toolchainId: string;
  available: boolean;                                // false: runtime json invalid or key ≠ row.key
  compile: { command: string; cpuSec: number; wallSec: number; slow: boolean } | null; // null = no compile step
  run: string | null;
  env: ReadonlyArray<readonly [string, string]>;    // runtime.env minus forced keys, then SANDBOX_FORCED_ENV (same rule as isolate.ts:112-121)
  processes: number | null; openFiles: number | null; managed: boolean;
  timeLimit: { multiplier: number; extraMs: number; exampleMs: number } | null; // exampleMs = deriveTimeLimitMs({ baseMs: EXAMPLE_BASE_MS, measuredModelMs: null, multiplier, extraMs })
}
export interface JudgeLimitFact { id: JudgeLimitId; resource: string; value: string; mechanism: string; breach: Verdict | "rejected" | "truncated" | null }
export type JudgeLimitId = "cpu" | "extra" | "wall" | "memory" | "stack" | "processes" | "open-files" | "file-size"
  | "stdout" | "stderr" | "artefacts" | "core" | "source" | "compile" | "custom-run" | "visible-detail";
export interface JudgeFacts {
  languages: JudgeLanguageFact[];                   // sorted by LANGUAGE_KEYS index, deduped by key
  limits: JudgeLimitFact[];                         // enforced LIMITS fields only (no scratchDisk.inodes; startupCredit.maxMs only once enforced)
  timing: { floorMs: number; ceilingMs: number; roundToMs: number; modelMultiplier: number; extraTimeSec: number;
            startupRuns: number; startupMaxMs: number; wall: Array<{ cpuMs: number; wallSec: number }>;
            wallCeilingSec: number; flipMarginPct: number /* LIMITS.calibration.maxDeviation × 100 */ };
  outcomeRules: Array<{ id: RunOutcomeRuleId; verdict: Verdict | null; text: string }>;
  precedence: readonly Verdict[];
}
export const RUN_OUTCOME_TEXT: Readonly<Record<RunOutcomeRuleId, string>>;  // exhaustive: a new rule fails typecheck until it has prose
export function buildJudgeFacts(rows: readonly PublicLanguageRow[]): JudgeFacts;
```

## 4. Page: `apps/web/src/app/(public)/judge/page.tsx`

- Exports `metadata = { title: "Judge specifications", description: … }` and `dynamic = "force-dynamic"` (so build never prerenders it or touches the database).
- `default async function JudgePage()`:
  - wraps `getPublicLanguageRows()` in try/catch; on failure it renders every constant section plus a notice that the language list is unavailable;
  - calls `buildJudgeFacts`.
- Server components only: `Card` and `VerdictBadge` from `@recx/design` (neither is `"use client"`), lucide icons rendered on the server. **No first-party `"use client"` import.**
- Sections, each `<section aria-labelledby>` with an `<h2>`:

| Anchor | Content |
|---|---|
| `#languages` | One `<h3 id={anchor}>` card per enabled language: label, version, toolchain id; compile command, or "no compile step" for PyPy; compile caps (`LIMITS.compile.cpuSec` / `cpuSecSlow` chosen by `runtime.compile.slow`); run command; fixed environment; processes and open files; numpy-only vendoring stated through the label |
| `#time-limits` | Measured rule (`modelMultiplier` × slowest model, at least the C++ limit, rounded to `roundToMs`, clamped `floorMs`–`ceilingMs`). Fallback table: each language's multiplier and extra ms, with the worked example from `EXAMPLE_BASE_MS`. Memory is the same per-problem limit for every language (`validation.ts:410`). Startup credit (`startupCredit.runs`) |
| `#tle` | TLE is decided on CPU time inside the box's cgroup. Queue wait and compilation are never counted: the clock starts when the program starts in its own fresh box, and the limit applies per test. Overrun is measured up to `extraTimeSec`. Wall-time safety net from `wallTimeSecFor()` examples and `wallTime.ceilingSec`. An idle wall-clock stop is still TLE. Determinism caveat: limits are at least `modelMultiplier` × the model; nodes more than `flipMarginPct`% off the fleet median are kept off contest and assessment lanes; a solution within that margin may flip between runs |
| `#memory` | `formatKib(memory.defaultKb)` default, `ceilingKb` maximum. cgroup peak, not address space. Stack equals memory. Managed-heap caveat (JUDGE.md §7) shown only if some enabled runtime has `family === "managed"` |
| `#output` | `outputFile.defaultKb` per file (SIGXFSZ, OLE). Early stdout trip `min(capBytes, perExpectedMultiplier × expected + slackBytes)` every `pollMs`. stderr `stderrCapture.defaultBytes`. Custom run and visible-detail limits |
| `#verdicts` | `<ol id="run-outcome-rules">` from `outcomeRules`. `<ol id="verdict-precedence">` of `VerdictBadge` from `VERDICT_PRECEDENCE`. ICPC stops at the first failing test; PER_TEST and SUBTASK give AC or PARTIAL by score, otherwise the worst failing verdict by precedence |
| `#limits` | Full table built from `facts.limits`: `caption`, `th scope`, and a scroll region with `tabIndex=0` + `aria-label` (pattern from `help/page.tsx:149`) |
| `#sandbox` | Short "layered containment" paragraph. Uses none of the five banned phrases, even negated (`forbidden-words.test.ts` scans `.tsx`) |

- Commands render in `<code class="break-all whitespace-pre-wrap">`, so a 375 px viewport has no horizontal scroll.
- No verdict-list literals; rows use `Verdict.MLE` etc., to stay clean under `single-source.test.ts`.

## 5. Workspace footer

`language-version.tsx`:
```ts
export function LanguageVersion(props: { label: string; version: string; href: string | null }): JSX.Element
```
- Renders `formatLanguageVersion(label, version)` in mono, `ml-auto truncate`.
- When `href` is set: `<a target="_blank" rel="noopener">` with sr-only "— compiler version, flags and limits, opens in a new tab". A new tab means the editor is never left.
- The footer is `min-h-8`, which meets the WCAG 2.2 target size.
- Phases 5-7 (arena and attempt) must pass `judgeLink={false}`.
- Bundle cost on `/problems/[slug]` is under 0.3 KB, against its 220 KB budget.

## 6. Size budget

**`size-budgets.json`:**
- `routes` += `{ "route": "/judge", "entry": "/(public)/judge/page", "maxKb": 125, "shared": false }`. Baseline is about 117 KB (see `/u/[handle]`); `shared:false` keeps the Phase 3 shared-first-party figure unchanged.
- New block: `"serverRendered": { "$comment": "Pages that add no client JS of their own", "entries": ["/(public)/judge/page"] }`.
- `monacoFree.entries` += `"/(public)/judge/page"`.

**`size-budget.mjs`:**
- At `:169`, build the shared sets only from routes where `shared !== false`.
- After `:185`, add a new check. For each `serverRendered` entry:
  - own chunks = `pages[entry]` minus rootMainFiles and the layout chain (`chainEntries`, `:81-90`);
  - breach if any module in `chunkMap[file]` is named anything other than exactly `"apps/web"`, or if own gzip is over 1 KB;
  - exit 2 if the entry is missing.

## 7. Tests that prove the stream's Phase 4 items

1. **`packages/shared/test/verdict.test.ts` (extend):** `RUN_OUTCOME_RULES` ids are unique, every non-null verdict is in `VERDICTS`, the first rule is IE and the last is `compare` with `null`.
2. **`apps/judge-worker/test/verdict-rules.test.ts` (new):** `FIXTURES: Record<RunOutcomeRuleId, { meta: Partial<IsolateMeta>; ctx: Partial<RunContext> }>`. Each fixture triggers its own rule *and* as many later rules as are compatible; for example `output-trip` uses `status:"TO"`, `cgOomKilled:true` and `outputLimitExceeded:true`. For each rule, `classifyRun(meta, ctx).verdict ?? null` must equal the rule's verdict, and the fixture keys must equal the rule ids in order. This makes the published order the worker's real order.
3. **`apps/web/test/judge-transparency.test.ts` (new, pure):**
   - `displayArgv` quoting (the py312 `-c` snippet round-trips).
   - `formatKib`.
   - Sort follows `LANGUAGE_KEYS`; duplicate keys are deduped.
   - An invalid runtime, or `runtime.key ≠ row.key`, gives `available:false`.
   - `exampleMs === deriveTimeLimitMs(...)`; compile caps follow `compile.slow`.
   - `env` ends with `SANDBOX_FORCED_ENV` and has no duplicate HOME or LANG.
   - No limit row for the inode count; the startup cap row appears only with the claim fix.
4. **`apps/web/test/judge-page.test.ts` (new, render).** Uses the `renderToStaticMarkup` pattern from `help-render.test.ts:10-35`. Mocks `@/lib/db` (`languageConfig.findMany` filtering a fixture by `args.where`), `next/cache` (passthrough), and `@/lib/auth/guards` (every guard throws "/judge must not require sign-in").
   - Fixture rows are built from `LANGUAGE_CATALOG`. Includes java21 enabled in the database (catalog says off) and cpp20 disabled in the database (catalog says on), plus an old non-current row.
   - Asserts findMany receives exactly `where {enabled:true,isCurrent:true}` and the five-field select.
   - For each rendered row: label, version, every compile and run argv token, every env pair, multiplier, extra ms, processes, open files, and `id="${judgeLanguageAnchor(key)}"`.
   - Disabled and non-current labels are absent.
   - Every `facts.limits` value string is present.
   - `data-verdict` order inside `#verdict-precedence` equals `VERDICT_PRECEDENCE`; row order inside `#run-outcome-rules` equals `RUN_OUTCOME_RULES`.
   - A database failure still renders the constants and the "unavailable" notice.
5. **`apps/web/test/judge-page.canary.test.ts` (new): proves the page derives its values instead of copying them.**
   - `vi.mock("@recx/shared", async (orig) => ({ ...await orig(), LIMITS: patched, VERDICT_PRECEDENCE: [...real].reverse() }))`, with sentinels: `memory.defaultKb 123_457`, `cpuTime.ceilingMs 14_321`, `outputFile.defaultKb 54_321`, `extraTimeSec 0.37`, `startupCredit.runs 17`, `calibration.maxDeviation 0.07`.
   - A canary cpp20 row with argv flag `-fcanary-flag`, `fallbackMultiplier 3.7`, `fallbackExtraMs 432` and version `99.9.9-canary`.
   - Every sentinel appears and the precedence order is the reversed one.
6. **`apps/web/test/judge-page-imports.test.ts` (new, static):** walks `@/…` imports from `src/app/(public)/judge/page.tsx` recursively and asserts no file starts with `"use client"`. The build-time check is `size-budget.mjs` `serverRendered`.
7. **`apps/web/test/public-shell.test.ts` (new):**
   - `getCurrentUser` returning null renders "Sign in" and no AppShell.
   - A user renders the AppShell (mocked to a marker).
   - Rendering never redirects to `/login`.
8. **`apps/web/test/language-version.test.ts` (new):** label plus version; `formatLanguageVersion` does not repeat a version already in the label; href is `/judge#lang-cpp20` with the "opens in a new tab" text; `href:null` renders no anchor.
9. **`apps/web/test/problem-workspace-languages.test.ts` (new, mocked db):** `getProblemWorkspace` selects `version`; `WorkspaceLanguage.version` equals `LanguageConfig.version`.
10. **`apps/web/test/judge-claim-constants.test.ts` (extend):** `startupCreditFor({ cpp20: 5000 }, "cpp20") === LIMITS.startupCredit.maxMs`.
11. **`apps/web/e2e/judge-page.spec.ts` (new):**
    - Signed-out `/judge` returns 200, the URL stays `/judge`, the h1 shows, and the seeded enabled language cards show.
    - As a student, `/problems/two-sum` has a footer link named with the seeded label, href `/judge#lang-<key>`, and the target anchor exists.
12. **Unchanged but must stay green:** `tests/repo/forbidden-words.test.ts`, `single-source.test.ts`, `shell-nav.test.ts`, and the Monaco-free check (now including `/judge`).

## 8. Server actions, audit, RBAC

- **No new server actions and no new audit rows.**
- The only mutation touched is the existing `setLanguageEnabled` (already audited, `SENSITIVE` `judge.language.enabled_changed`), which now also calls `revalidateLanguageConfigs()`.
- **RBAC:** `/judge` has no guard by design. `(public)/layout.tsx` grants nothing.
- **RUNBOOK manual step:** open `/judge` signed out in a private window. Toggle a language in `/admin/judge` and confirm `/judge` reflects it on the next load. Confirm the workspace footer link opens the right anchor.

## 9. Interactions and conflicts with other streams

| Area | Interaction |
|---|---|
| `schema.prisma` | None |
| `packages/shared/src/index.ts` | None; the new names flow through existing `export *` |
| `verdict.ts` / `languages.ts` | Append-only edits at end of file. The FUNCTION-harness stream (enabling languages / `enabledByDefault`) may edit `languages.ts`: rebase on append |
| `apps/web/src/lib/auth/guards.ts`, admin layout | Untouched |
| **Role × capability matrix stream** | If it adds an "every `page.tsx` calls a guard" check, its public allowlist must include `/judge`, `/u/[handle]`, `/offline` and `/login` |
| **`/super/settings/judge` stream** (language-config edits, toolchain upgrades that create new `LanguageConfig` rows) | Every `LanguageConfig` write must call `revalidateLanguageConfigs()`; the 60 s backstop covers misses. If it adds memory-derived heap flags (`-Xmx`, `--max-old-space-size`), they must be a pure function in `@recx/shared` (e.g. `heapArgsFor(runtime, memoryLimitKb)`) so `/judge` can render them, and the managed-heap caveat is removed in the same change |
| FUNCTION-harness stream | Shares `server/queries/problems.ts` (`supportsFunctionMode` / starter stub, `:300-318`) with my small `version` hunk |
| Compile-error-remap stream | Its `result-view.tsx` hunk is near but not overlapping `workspace.tsx`; mine is lines 487-489 plus one prop |
| `/help` | Becomes a plain-language summary that links to `/judge`; both read the same `getPublicLanguageRows()` |
| `e2e/a11y.spec.ts`, `size-budgets.json` | Append-only rows; other streams adding admin pages rely on `monacoFree.entryPrefixes` unchanged |

## 10. Open questions (narrower reading chosen; add to `docs/OPEN-QUESTIONS.md` under Phase 4)

1. `/judge` is reachable signed out but keeps the root `robots: noindex` (`layout.tsx:32`). Should it be indexable?
2. Only `enabled && isCurrent` toolchains are listed. Should retired toolchains (still used for rejudges) or not-yet-enabled catalog languages be shown?
3. Live fleet facts are not published: per-node startup credit values and the isolate version from `JudgeNode`. Only the method is stated.
4. Per-problem, per-language time limit in the workspace footer (from `ProblemLanguageLimit`, or the fallback via `jobTimeLimitMs`, `job-spec.ts:166-189`): deferred. The footer shows version plus link only.
5. The startup-credit cap was claimed but not enforced. The fix is in this stream (`claim.ts:263`); if rejected, the page omits the cap.
6. The per-box inode limit is not published because it is not enforced.
7. The managed-runtime heap caveat is published as-is until heap flags exist.
8. The footer link opens a new tab. The arena and attempt surfaces pass `judgeLink={false}` (Phases 5-7).
9. The existing build shows `/login` at 113.6 KB first-load against a 90 KB budget (framework 100.4 KB). This is a Phase 3 gate risk, raised for the orchestrator.