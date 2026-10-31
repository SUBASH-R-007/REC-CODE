You are Phase 4 integration agent "I2 student exposure". First read C:\Users\SUBASH\AppData\Local\Temp\claude\C--Users-SUBASH-OneDrive-Documents-GitHub-REC-CODE\488a8ed9-9b4f-4a0f-9859-3a195105ba00\scratchpad\p4design\INTEGRATION-COMMON.md in full and follow it (it points you to STREAM-COMMON.md, PLAN.md, FOUNDATION-REPORT.md, the stream reports stream-*.md and the spec). Then do this task.

TASK: implement the spec's gate test "no STUDENT-reachable route can return a non-sample test file or a ReferenceSolution.source". Design: gate-tests.md §4.3 (D1 static + D2 DB canary). Also read authoring.md §8 (its "content-leak" design); implement ONE combined, coherent set, not two overlapping ones.

OWNED FILES
- tests/repo/student-exposure.test.ts, plus helpers under tests/repo/support/ (e.g. module-graph.ts)
- apps/web/test/student-exposure.db.test.ts
- apps/web/test/support/collect-strings.ts
- any fixtures you need

1. Static fence (tests/repo/student-exposure.test.ts, runs on Windows and Linux in pnpm test).
   - SENSITIVE_PREFIXES must include:
     - app/api/judge/
     - lib/judge/claim.ts, finalize.ts and validation.ts (plus anything else that reads hidden test bytes or reference sources)
     - lib/testdata/
     - lib/authoring/
     - app/api/admin/
     - server/queries/admin-, server/actions/admin-, server/actions/super-, server/queries/super-
     - lib/privileged/
     - app/admin/, app/super/, components/admin/, components/super/
   - Rules:
     - R1: no referenceSolution(s) or "ReferenceSolution" outside the sensitive paths;
     - R2: no testBlob delegate, readBlobBytes, getTestDataStore, or "TestBlob" in SQL;
     - R3: every testCase(s) query selecting input/output includes isSample: true;
     - R4: no module outside the sensitive paths imports a sensitive one (resolve @/ and relative imports, skip `import type`);
     - R5: every student entry — page, layout, route, loading, error, not-found, template or default under src/app except admin/**, super/**, api/judge/** and api/admin/**, plus middleware.ts and src/pages/** — has a transitive import closure free of sensitive modules;
     - R6: every "use server" file whose closure reaches a sensitive module starts EVERY export's runAction body with a staff guard (requireActionRole including ADMIN, or requireSuperAdmin).
   - Every rule gets flagged and clean self-tests.
   - Also include checker sources (checkerSha256 blobs) as sensitive.
2. DB canary test (apps/web/test/student-exposure.db.test.ts, RECX_DB_TESTS=1). Follow gate-tests.md §4.3 D2.
   - Canaries:
     - HIDDEN-IN, HIDDEN-OUT and HIDDEN-BIG (a blob held only in the fake store via storageKey);
     - REF-SRC in cpp20 AC and py312 WA references;
     - CHECKER-SRC;
     - DRAFT-STMT in an open draft revision;
     - the positive control SAMPLE-IN.
   - Fixture: a published, frozen CHECKER problem. Student S has a DONE WA submission whose stored jsonb hidden entry is deliberately polluted with in/out keys, plus sample SubmissionTestDetail rows, a DONE RunRequest, a bookmark, a note and activity.
   - As S, call:
     - every src/app/**/route.ts method; ROUTE_CALLS must cover every file found by glob, and api/judge/* without node headers must return 401 or 426;
     - every export of the non-admin, non-super src/server/queries/*.ts modules (or name it in NOT_PROBLEM_SCOPED with a reason);
     - every student page (await Page({params, searchParams}) with next/navigation and next/headers mocked; collect strings by expanding async components; PAGE_SKIPS need a reason);
     - every self-service action with fixture inputs;
     - POST /api/admin/problems/import, which must return 403.
   - JSON.stringify every output and assert no secret canary appears. Assert the workspace output contains SAMPLE-IN, and that the submission view drops the polluted keys.
   - Use unique tags. Tear down per FOUNDATION-REPORT (disable guards in one transaction, delete only your rows, re-enable, assert none disabled).
3. Run the static test on Windows, and the DB test in the mirror with RECX_DB_TESTS=1, alone and then together with the full web DB suite.
4. If either test FINDS A REAL LEAK in product code, do not paper over it. Fix the product code minimally if it is clearly a leak, re-reading the file first, and report it prominently.