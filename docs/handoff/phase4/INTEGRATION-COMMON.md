# Phase 4 Stage 3 (integration): rules common to every integration agent

All six Phase 4 streams have landed in the shared working tree at
C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-CODE. On Windows the baseline is green:
`npx pnpm@9.15.9 lint`, `typecheck` and `test` all exit 0, with 3,313 tests passing.
Four integration agents now work in parallel. Each owns a disjoint set of files.

## Read first
These live in
C:\Users\SUBASH\AppData\Local\Temp\claude\C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE\488a8ed9-9b4f-4a0f-9859-3a195105ba00\scratchpad\p4design.

1. `STREAM-COMMON.md`. All of its engineering rules, running instructions and report
   format apply to you. The "ownership" section is replaced by your task's list below.
2. `PLAN.md` and `FOUNDATION-REPORT.md`, including the Fix-up, Fix-up 2, coordinator
   decisions and wave-1 sections.
3. The stream reports `stream-*.md`, especially the "Requests" sections. They are why
   your task exists.
4. The design file(s) your task names, and the spec at `../spec.txt`: lines 11-17
   (ground rules), 240-308 (data model), 364-375 (Phase 4) and 633-697 (DO NOT).

## Ownership
You own exactly the files your task lists. For any other file, make only the minimal
hunk your task needs, and re-read the file immediately before every edit. The other
three integration agents are editing other files at the same time.

Never weaken an existing test or gate to make yours pass. If an existing test is
wrong, say why in your report.

## Database tests
Web database test files currently run in parallel against `recx_test`, and some
teardowns deadlock. Agent I3 owns fixing that. Until I3's fix lands, if you hit a
deadlock or flake in someone else's suite, re-run that suite alone and report the
flake. Do not patch other suites.

## Servers
Do not start servers. The live stage runs Playwright later, so write e2e specs to be
correct by construction: run `tsc` on them, and run them with `--list` to confirm
discovery.
