export const meta = {
  name: 'p4-review',
  description: 'Phase 4 adversarial review: 6 dimension reviewers -> per-finding skeptic verification -> confirmed findings',
  phases: [
    { title: 'Review', detail: 'six independent dimension reviewers (read-only)' },
    { title: 'Verify', detail: 'two skeptics per finding try to refute it' },
  ],
}

const D = 'C:\\Users\\SUBASH\\AppData\\Local\\Temp\\claude\\C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE\\488a8ed9-9b4f-4a0f-9859-3a195105ba00\\scratchpad\\p4design'
const S = 'C:\\Users\\SUBASH\\AppData\\Local\\Temp\\claude\\C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE\\488a8ed9-9b4f-4a0f-9859-3a195105ba00\\scratchpad'
const COMMON = `You are a READ-ONLY reviewer of Phase 4 of REC Code, the repository at C:\\Users\\SUBASH\\OneDrive\\Documents\\GitHub\\REC-CODE.

Context:
- The spec is ${S}\\spec.txt. Read lines 11-17, 240-308, 364-375 and 633-697.
- The integrated plan is ${D}\\PLAN.md.
- The stream designs are ${D}\\*.md.
- The stream and integration reports are ${D}\\stream-*.md and ${D}\\integration-*.md.

Phase 4 added these, compared with Phase 3:
- /super, /admin and /admin/problems
- governance (impersonation, privileged operations, outbox)
- AdminScope and its fence
- the authoring and import pipeline
- the FUNCTION harness, Java support and comparators
- protocol v3
- six new seed problems
- /judge
- new migrations 2026101010xxxx

Use git status, file timestamps and the reports to find the Phase 4 code. Do NOT edit any file in the repository. You may write and run throwaway scripts in ${S}\\review, for example to execute a query, a vitest file or a tsc probe that demonstrates a bug. Do not start servers, and run long commands in the foreground.

Hunt for REAL defects, not style: things that would cause wrong behaviour, a security hole, data corruption, a spec violation, a broken gate, or a user-visible failure. For every finding give:
- severity (critical, high, medium or low);
- file:line;
- the concrete failure scenario (input or state → wrong outcome);
- evidence: the code you read, plus a repro script or command if you could build one;
- the minimal fix.

Do not report items that docs/OPEN-QUESTIONS.md explicitly records as a deliberate decision, unless the decision itself violates the spec. Report at most 15 findings, most severe first. If you find nothing in an area, say what you checked.`

const DIMENSIONS = [
  { key: 'security-rbac', prompt: `DIMENSION: security and authorization.
- Check every new server action, route handler and page: the guard is the first statement; the roles are right; zod parses every input; IDOR (an admin acting on an out-of-scope student or someone else's import, operation or export); AdminScope folding for EVERY student query an admin can run.
- Impersonation: read-only everywhere, including route handlers, server actions reached through forms, GET handlers with side effects, and the PII export route; expiry; banner.
- Privileged operations: requester ≠ approver; break-glass audited and emailed; payload hash binding; expiry; replay of executed operations; executor idempotency.
- PII export: requester only, the download window and count, CSV formula injection, no-store headers, columns minimised.
- The zip import route: same-origin, size caps, zip-slip, symlinks, zip bombs (ratio and total), entry counts, temp-file permissions and cleanup, after() error handling.
- Judge node token rotation: the token is never logged or audited, and the old token is revoked.
- Secrets or emails in logs and audit metadata.
- The rate limits the design specified.
- The CSP and nonce interplay with the new pages.
- The no-JS sign-in still being safe after the governance changes to session.ts.` },
  { key: 'data-integrity', prompt: `DIMENSION: data integrity and concurrency.
- Transactions and optimistic concurrency: publish vs publish, publish vs retire, touchDraft editSeq/judgeSeq, import idempotency.
- Roster import: preview/commit diff hash and stale previews.
- Announcement fan-out atomicity.
- Accommodation flows against the database state machines and the coordinator decisions in FOUNDATION-REPORT.
- XP void: compensating rows and bucket decrements under the user advisory lock; no double void.
- Global rejudge: SKIP LOCKED, and the state of the rows it resets.
- Submission purge vs legal hold.
- The PII export lifecycle.
- Outbox claiming: SKIP LOCKED, lease recovery and backoff.
- The governance sweep using the database clock.
- Retry wrappers (retry.ts) re-running side effects.
- Bundle-after-freeze: a crash between the freeze and the store write; the repair path.
- Frozen-version invariants across every new write path, including import and clone.
- Every database CHECK or trigger that a legitimate app path will hit and fail on: cross-check each app flow against the migrations 20261010100000/100050/100080/100100/100200.
- Deadlocks and lock ordering in new code.
- Migrations: idempotent and ordered, drift-clean, and reversible enough.` },
  { key: 'judge-harness', prompt: `DIMENSION: judge correctness.
- The FUNCTION harness for C++, Python and Java: serialisation round-trips for every grammar type, including empty and null trees and lists, unicode, escapes, long bounds, doubles, char and pair.
- The six comparators' semantics against the spec, including IN_PLACE_MUTATION and CUSTOM_CHECKER canonicalisation.
- Compile-error remapping: lines are never outside the student's range, nothing generated is leaked, and no /box or /opt/toolchains paths appear.
- Java: heap flags, class names, imports and stack traces.
- Protocol v3: version gating on both sides, and old workers refused.
- Worker structured compare: hidden tests carry no messages; the verdict mapping.
- Golden-test coverage: every seeded problem × every enabled language; does any reference solution only pass by luck?
- The six new problems' generators, checkers and statements: correctness, determinism, limits, sample/hidden separation, originality. Do the CUSTOM_CHECKER checkers accept every valid answer and reject invalid ones?
- Time-limit derivation for the new problems.
- The custom-run input validation.` },
  { key: 'spec-conformance', prompt: `DIMENSION: spec conformance. Go through the Phase 4 section of the spec line by line, and through the DO-NOT list and the ground rules, and verify each item is implemented and true in the code:
- every route listed for /admin and /super, or an OPEN-QUESTIONS narrowing;
- the exact strip text;
- the twelve SUPER_ADMIN capabilities as ONE exported constant, with a test asserting each corresponding action calls requireSuperAdmin();
- the PrivilegedOperation kinds and rules;
- break-glass emailing ALL super-admins;
- AdminScope folded into every student-facing admin query;
- the FUNCTION grammar validated by zod;
- harness templates kept in the repo, not the database;
- all six comparators;
- "a problem cannot publish without a declared comparator";
- ≥3 IN_PLACE_MUTATION and ≥3 CUSTOM_CHECKER seeds;
- compile-error remapping;
- review-queue states;
- bulk import with per-row results;
- CI enforcing APPROVED problems' references in every enabled language;
- the 450-problem content target with named owners in OPEN-QUESTIONS, plus "content, not code, is the binding constraint";
- /judge contents: compiler versions and flags, multipliers, memory limits, TLE measurement, output limits, verdict precedence;
- the active language version in the workspace footer;
- the Phase 4 Done-when tests all present and genuinely testing the stated property.
Also check:
- forbidden words anywhere;
- that nothing touches the LMS repo;
- no student code in the web process;
- the judge worker has no database access;
- frozen-version rules;
- no aggregation of XpEvent to render a page;
- no raw IPs;
- no hard-deleted students.` },
  { key: 'ui-a11y', prompt: `DIMENSION: UI, accessibility and front-end budgets for the new pages (/admin/**, /super/**, /admin/problems/**, /judge, the dashboard announcement banner, the impersonation banner, the submission page's "Problem as judged", the workspace footer). Read the TSX. Check:
- every control has a label;
- forms use correct input types;
- errors are announced (role=alert or aria-live);
- focus management after actions;
- tables have captions or aria-labels and th scope;
- scroll regions are focusable;
- no colour-only meaning;
- no hex literals;
- target sizes;
- 375 px layouts with no horizontal page scroll (look for fixed widths and wide tables not wrapped);
- dialogs: focus trap and Escape;
- no-JS fallbacks where the design promised them;
- "use client" kept to leaves;
- no Monaco in admin or super;
- server components fetching with db.
Check that the size-budget config covers /judge and is still correct after the changes (read scripts/size-budget.mjs and size-budgets.json), and whether the dashboard banner's client code is likely to push /dashboard over 160 KB. Check that the design tokens are used, with no themeable success/warning/danger/info.` },
  { key: 'tests-gates', prompt: `DIMENSION: the quality of the tests and gates themselves. For each Phase 4 Done-when gate test, decide whether it would FAIL if the property broke:
- the role × capability matrix;
- golden files;
- frozen versions and their children reject writes;
- concurrent publish: one success, one conflict;
- no STUDENT-reachable route leaks a non-sample test or ReferenceSolution.source;
- the authoring e2e.
Look for vacuous assertions, mocks that bypass the code under test, skipped tests, tests that never run in any gate (not matched by any vitest config or Playwright project, or skipped by env vars that no gate sets), CI and gate scripts not running a test, and flaky timing.
Run a few targeted mutation checks yourself on a throwaway copy, never the real tree. For example: remove a guard call from one action, or make a student query select reference sources, and see whether the matching test catches it. Any copy must live under ${S}\\review and be deleted afterwards.
Also check that the linux-gate.sh and ci.yml steps cover the new suites, including the isolate golden suite with java21.` },
]

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' },
          location: { type: 'string' },
          scenario: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'title', 'location', 'scenario', 'evidence', 'fix'],
      },
    },
    checked: { type: 'string' },
  },
  required: ['findings', 'checked'],
}
const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string' },
    adjustedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-a-bug'] },
  },
  required: ['refuted', 'confidence', 'reasoning', 'adjustedSeverity'],
}

const results = await pipeline(
  DIMENSIONS,
  (d) => agent(COMMON + '\n\n' + d.prompt, { label: `rev:${d.key}`, phase: 'Review', schema: FINDINGS }),
  (rev, d) => parallel((rev?.findings ?? []).map((f, i) => () =>
    parallel([0, 1].map((k) => () => agent(
      `You are skeptic #${k + 1}, independently checking a reported defect in the REC Code repository at C:\\Users\\SUBASH\\OneDrive\\Documents\\GitHub\\REC-CODE. This is READ-ONLY: do not edit repository files. Throwaway scripts go in ${S}\\review. Your job is to REFUTE the finding if you can. Read the actual code at the location and trace the claimed scenario. Check docs/OPEN-QUESTIONS.md for a recorded deliberate decision. Try to reproduce it.
- refuted = true if the scenario cannot happen, is already prevented elsewhere (a guard, a DB constraint, a caller), or is a documented deliberate decision that is consistent with the spec ${S}\\spec.txt.
- refuted = false only if you confirm it is real.
If you are uncertain after honest effort, lean towards refuted = true and say why.

FINDING (dimension ${d.key}):
${JSON.stringify(f, null, 2)}`,
      { label: `skeptic:${d.key}#${i}.${k}`, phase: 'Verify', schema: VERDICT },
    ))).then((votes) => {
      const v = votes.filter(Boolean)
      const confirmed = v.filter((x) => !x.refuted).length
      return { dimension: d.key, ...f, votes: v, confirmed: confirmed >= 1 && v.length > 0 && confirmed >= Math.ceil(v.length / 2) }
    })
  )).then((arr) => ({ dimension: d.key, checked: rev?.checked ?? '', findings: arr.filter(Boolean) })),
)

const all = results.filter(Boolean)
const confirmed = all.flatMap((r) => r.findings.filter((f) => f.confirmed))
const rejected = all.flatMap((r) => r.findings.filter((f) => !f.confirmed))
log(`review: ${confirmed.length} confirmed, ${rejected.length} refuted`)
return { confirmed, rejected: rejected.map((f) => ({ dimension: f.dimension, title: f.title, location: f.location, votes: f.votes.map((v) => v.reasoning.slice(0, 300)) })), checked: all.map((r) => ({ dimension: r.dimension, checked: r.checked })) }
