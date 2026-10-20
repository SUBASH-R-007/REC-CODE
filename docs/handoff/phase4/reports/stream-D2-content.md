All six problems (REC-0007 to REC-0012) are authored and appended to `AUTHORED_PROBLEMS`. Every reference got its expected verdict in cpp20, py312 and java21. `seed-content.test.ts` (D1-owned) currently fails 6 of 79 tests. Both causes are assertions D1's design (§10) says D1 will rewrite, not my content, so I left the test alone.

**Files created or changed**, all in `C:\Users\SUBASH\OneDrive\Documents\GitHub\REC-CODE\apps\web\scripts\content\`:
- `conveyor-shift.ts` (new): REC-0007, EASY, ARRAYS_HASHING + TWO_POINTERS, IN_PLACE_MUTATION on `parcels`, 16 tests.
- `playlist-fold.ts` (new): REC-0008, MEDIUM, LINKED_LIST + TWO_POINTERS, IN_PLACE_MUTATION on `head` (the head node stays first), 14 tests.
- `bench-blackout.ts` (new): REC-0009, MEDIUM, ARRAYS_HASHING, IN_PLACE_MUTATION on `grid`, 17 tests.
- `session-order.ts` (new): REC-0010, MEDIUM, GRAPHS, CUSTOM_CHECKER, 14 tests.
- `exact-change-pair.ts` (new): REC-0011, EASY, ARRAYS_HASHING, CUSTOM_CHECKER, 14 tests.
- `no-neighbour-seating.ts` (new): REC-0012, EASY, MATH_BITS + GREEDY, CUSTOM_CHECKER, 14 tests.
- `checker-json.ts` (new, a checker source): a C++ JSON-line reader pasted into each of the three testlib checkers. Bad contestant output gives `_wa`; a bad input or jury answer gives `_fail`.
- `index.ts`: imports plus six entries appended to `AUTHORED_PROBLEMS`.
- `docs/OPEN-QUESTIONS.md`: appended `### Phase 4 — D2 seed content` (five decisions, listed below).

Each problem has an original campus-framed statement, 2 samples, at least 12 hidden tests from a deterministic generator (including max-size cases), 3 hints, an editorial, cpp20/py312 starters from `starterStub`, and cpp20, py312 and java21 model solutions. CUSTOM_CHECKER problems have `compareMode: "CHECKER"`, the others `"TOKEN"`.

**Verification** (scripts in `scratchpad\d2v\`: `gen.mts`, `runner.py`, `run.sh`, `samples.mts`; output in `results-all.txt`):
- `gen.mts` uses `buildHarness` for all three languages; D1's wiring dispatched java21 by the final run.
- The real toolchains in WSL compiled and ran every program on every test.
- For the in-place problems, output was compared byte-for-byte with the expected value. For checker problems, the compiled testlib-0.9.41 checker judged it.
- Verdicts were emulated as the judge does: stop at the first failing test, time limit = max(2.5 × the model's time, 1000 ms).
- Before running, all six signatures passed D1's stricter `functionSignatureSchema` and `functionCompareMode`, and all 89 tests passed `validateFunctionTest`.

| Problem | cpp20 model | py312 model | java21 model | Deliberately wrong (expected → got) |
|---|---|---|---|---|
| conveyor-shift | AC 17 ms | AC 169 ms | AC 153 ms | py312 rebinds `parcels`: WA → WA (test 0); cpp20 shifts left: WA → WA (test 0) |
| playlist-fold | AC 12 ms | AC 98 ms | AC 148 ms | cpp20 no reversal: WA → WA (test 0) |
| bench-blackout | AC 14 ms | AC 84 ms | AC 218 ms | cpp20 zeros cascade: WA → WA (test 0) |
| session-order | AC 56 ms | AC 231 ms | AC 237 ms | cpp20 index order: WA → WA (test 0) |
| exact-change-pair | AC 27 ms | AC 99 ms | AC 298 ms | cpp20 O(n²): TLE → TLE (test 8, 6984 ms vs 18.8 ms model, 372×); py312 reuses a position: WA → WA (test 3) |
| no-neighbour-seating | AC 3 ms | AC 48 ms | AC 74 ms | cpp20 odds then evens: WA → WA (test 2, n = 4 only) |

Times are the maximum CPU time over all tests. The peak memory of any run was 85.8 MB (Java), against a 256 MB limit.

The checkers accept 14/14 jury answers each, and reject all 236 deliberately broken outputs or answers as intended: malformed JSON, wrong length, duplicates, out-of-range values, rule violations and reversed pairs give WA (exit 1); corrupted jury answers give FAIL (exit 3).

**Tests and gates:**
- `npx pnpm@9.15.9 --filter @recx/web typecheck`: exit 0.
- `npx eslint <my 8 content files> --max-warnings=0`: exit 0.
- `npx vitest run --config vitest.repo.config.ts tests/repo/forbidden-words.test.ts tests/repo/single-source.test.ts tests/repo/judge-isolation.test.ts`: 99/99 passed.
- `npx pnpm@9.15.9 --filter @recx/web exec vitest run test/seed-content.test.ts`: **73 passed, 6 failed.**
  - Line 70 expects `compareMode` to be `"TOKEN"`, which fails for the three CUSTOM_CHECKER problems. It should compare against `functionCompareMode(sig.comparator)`.
  - `functionResult` parses the output with the `void` return type, which fails "show their samples in the statement" for the three in-place problems. It should use `comparedTypeOf(sig)`.
  - `samples.mts` runs the same catalogue and sample checks with those two fixes, and all six problems pass.

**Requests:**
- **D1:** make the two `seed-content.test.ts` fixes above.
- **For D1's planned checker-mirror tests:** each module exports its reference function, limits and, for the checker problems, the checker's rule in JavaScript (`shiftedRight`, `foldedOrder`, `closedGrid`, `sessionOrder`/`isValidSessionOrder`, `changePair`/`isValidChangePair`, `seatingFor`/`isValidSeating`).
- **D1's future `content-purity` test** (not created yet): my modules import only `@recx/shared/harness` and relative content files, including the new `checker-json.ts`.
- No schema changes or new dependencies needed.

**Decisions recorded in OPEN-QUESTIONS:**
- The checkers are hand-written and self-contained rather than generated by `checkerTemplate` at load time, so a frozen checker's text never changes when the template does.
- No java21 starter rows: java21 is off by default and the workspace generates a starter from the signature (`problems.ts:313`).
- exact-change-pair allows up to 2·10⁵ prices. At 10⁵, the O(n²) solution took only about 1.5 s against the 1 s limit, too close for a golden gate on faster hardware.
- The no-neighbour-seating wrong solution fails only n = 4. That case is a hidden test on purpose; the samples are n = 5 and n = 1.
- playlist-fold cannot tell relinking from rewriting the values, so both are accepted.

Nothing is unfinished. The judging in my scripts was emulated without isolate; the real-isolate run is D1's golden test. Throwaway copies of the generated programs are in WSL at `~/d2verify` (not the `~/recx` mirror).