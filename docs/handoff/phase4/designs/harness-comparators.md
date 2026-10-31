# Phase 4 design: FUNCTION harness, comparators and compile-error remapping

## 0. Decisions in one screen

- **FUNCTION languages in Phase 4:** cpp17, cpp20, py312, pypy310 and **java21**. c17, node22, go123 and kotlin20 get no harness. FUNCTION problems simply don't offer them, and the workspace says so plainly.
- **java21 stays `enabledByDefault: false`.** The Java harness ships complete and is proven in the Linux isolate gate. Enabling Java is a flag flip in a later PR. That PR must add Java model solutions for the 3 STDIN seeds, because a static test makes enabling impossible without full references.
- **Comparator storage:** no new Prisma enum or column. The comparator stays in the frozen `functionSignature` JSON. It is already required by zod and already carried by the protocol (`signature.ts:122`, `protocol.ts:207`).
  - `CompareMode` is meaningful for FUNCTION versions only as a mirror: it is `CHECKER` if and only if the comparator is `CUSTOM_CHECKER`. Otherwise it is `TOKEN` by convention, which matches the legacy frozen rows, and the judge ignores it.
  - The rule "cannot publish without a declared comparator" is enforced twice: by the app publish gate, and by a SQL-only CHECK migration that is evaluated on the `frozenAt` UPDATE.
- **Structured comparison:** a pure module `packages/shared/src/harness/compare.ts`, imported by the worker. It replaces today's token comparison for **every** FUNCTION problem.
- **Protocol:** `JUDGE_PROTOCOL_VERSION` goes from 2 to 3. There are no new fields, only a stricter `functionSignatureSchema` plus new semantics. The bump stops v2 workers from turning Java, SET_EQUAL or ROWS_ANY_ORDER jobs into permanent internal errors (IE).

## 1. Current state (what exists, and the bugs found)

**Where FUNCTION output is compared today**
- `effectiveCompareMode` (`apps/judge-worker/src/judge/plan.ts:151-177`) folds the comparator into a byte or token `CompareMode`:
  - EXACT and IN_PLACE_MUTATION use `spec.compareMode`, which is TOKEN in every seed.
  - FLOAT_TOLERANCE becomes FLOAT.
  - CUSTOM_CHECKER becomes CHECKER.
  - SET_EQUAL and ROWS_ANY_ORDER throw `PermanentJudgeError`.
- The comparison itself happens at `run-job.ts:321-333`, through `compareOutputs` (`compare.ts:41-58`) or `CheckerRunner.check` (`checker.ts:256-281`) on the **raw** stdout.

**Bugs this design fixes**
1. **False AC on strings.** TOKEN comparison of JSON text is whitespace-insensitive inside strings, so expected `"a b"` matches actual `"a  b"`.
2. **Python null trees and lists.** `_recx_out` (`python.ts:81-82`) prints `null` for a `None` TreeNode or ListNode, but the expected value is `[]`. Correct Python solutions get WA.
3. **Long precision.** `parseValue` (`values.ts:74-90`) uses `JSON.parse`, so longs above 2^53 lose precision.
4. **Signature validation gaps.** `functionSignatureSchema` (`signature.ts:108-145`) allows:
   - IN_PLACE_MUTATION with a non-void return, or on string, int or pair parameters (immutable in Python and Java);
   - doubles under EXACT;
   - duplicate parameter names;
   - keyword parameter names.
5. **CUSTOM_CHECKER output is unvalidated.** The checker receives raw student stdout.

**Language plumbing that already exists**
- Unsupported languages are already refused at submit (`actions/judge.ts:64-66`).
- They are filtered out of the workspace (`queries/problems.ts:310`).
- The worker refuses them permanently (`run-job.ts:84`).
- JVM verdict refinements exist (`verdict.ts:65,139-145`).
- JVM heap sizing is an open Phase 4 item in `docs/OPEN-QUESTIONS.md` ("JVM / V8 heap sizing").

## 2. Languages

**Why these five**
- **C++ and Python** are already enabled.
- **Java** is the second campus placement language. Its toolchain is installed and verified (`verify-toolchains.sh` java21 with and without CDS), JVM verdicts exist, and javac diagnostics are regular.

**Why not the rest**
- **C** has no classes or generics. It would need a different calling convention (sizes, malloc'd returns, `returnSize`), which is a separate design.
- **JavaScript** cannot represent `long` above 2^53 without BigInt, which is unidiomatic for students.
- **Go** needs a different code generator and error format.
- **Kotlin** compiles at 10–11 s of CPU (OPEN-QUESTIONS). Every FUNCTION submission compiles a new wrapped source, so this cost is paid on every submit.
- Each harness language also adds a reference solution for every FUNCTION problem, forever.

**What happens for the rest**
- **Workspace:** `getProblemWorkspace` gains `functionUnavailable: {key,label}[]`, listing enabled languages that `supportsFunctionMode()` rejects. The workspace renders: "Function problems are available in C++, Python and Java. {list} can be used for standard-input problems."
- **Submit and Run:** refused, as today.
- **Validation:** such reference solutions are not runnable, with the note "no function harness for X".
- **Worker:** refuses permanently, as today.
- **Authoring and bulk import:** use `supportsFunctionMode` to refuse StarterCode and ReferenceSolution rows in those languages on FUNCTION versions.

## 3. Comparator model, migration and publish gate

**Semantics, all pure, in `@recx/shared/harness/compare.ts`.** The "compared type" is the return type, or the mutated parameter's type for IN_PLACE_MUTATION.

| Comparator | Rule | Allowed compared type |
|---|---|---|
| EXACT | Structural equality after strict, type-directed decode | No `double` anywhere |
| FLOAT_TOLERANCE | Structure exact; `double` leaves match within absolute **or** relative ε (`floatEpsilon ?? 1e-6`, same rule as `compare.ts:92-101`) | Must contain a `double` |
| SET_EQUAL | Multiset equality with order ignored at **every** list/matrix level; pairs ordered; strings, trees and linked lists exact | Kind list or matrix; no double |
| ROWS_ANY_ORDER | Top-level order ignored (multiset of rows); each row exact | matrix, or list of list/pair; no double |
| IN_PLACE_MUTATION | EXACT on the named parameter after a void call | Parameter kind list, matrix, TreeNode or ListNode; return must be void; no double |
| CUSTOM_CHECKER | Output is decoded strictly (else WA without running the checker), then re-serialised canonically and handed to testlib | Any non-void type |

**Migration** (no `schema.prisma` edit; CHECK constraints are not modelled by Prisma, same precedent as the init migration). File: `packages/db/prisma/migrations/20261011000400_function_comparator_checks/migration.sql`.

```sql
-- A version cannot be frozen (published) without a declared, consistent comparator.
-- Scoped to frozen rows; the publish UPDATE that sets "frozenAt" is checked.
ALTER TABLE "ProblemVersion" ADD CONSTRAINT "ProblemVersion_function_comparator_declared" CHECK (
  "frozenAt" IS NULL OR "ioMode" <> 'FUNCTION' OR COALESCE(
    ("functionSignature" ->> 'comparator') IN
      ('EXACT','FLOAT_TOLERANCE','SET_EQUAL','ROWS_ANY_ORDER','IN_PLACE_MUTATION','CUSTOM_CHECKER'), false));
ALTER TABLE "ProblemVersion" ADD CONSTRAINT "ProblemVersion_function_checker_mirror" CHECK (
  "frozenAt" IS NULL OR "ioMode" <> 'FUNCTION'
  OR COALESCE(("functionSignature" ->> 'comparator') = 'CUSTOM_CHECKER', false) = ("compareMode" = 'CHECKER'));
ALTER TABLE "ProblemVersion" ADD CONSTRAINT "ProblemVersion_checker_present_when_frozen" CHECK (
  "frozenAt" IS NULL OR "compareMode" <> 'CHECKER' OR ("checkerSha256" IS NOT NULL AND "testlibId" IS NOT NULL));
```

Existing frozen rows (two-sum, handle-maker, lab-power-budget are EXACT with TOKEN) pass all three.

**App gate.** `comparatorIssues()` (§4) is called in `publishVersion` right after `summarizeValidation` (`validation.ts:650-651`). Its issues become `BLOCKED` blockers. `loadState` (`validation.ts:339`) adds `ioMode, functionSignature, compareMode, floatEpsilon, checkerSha256, testlibId` to its select.

## 4. Shared modules (exact exports)

### `packages/shared/src/harness/family.ts` (new)
Moves `index.ts:10-31` here so the root index can export it without pulling in the code generators.
```ts
export type HarnessFamily = "cpp" | "python" | "java";
export const HARNESS_FAMILY: Readonly<Partial<Record<LanguageKey, HarnessFamily>>>; // cpp17,cpp20→cpp; py312,pypy310→python; java21→java
export const FUNCTION_HARNESS_LANGUAGES: readonly LanguageKey[];                      // LANGUAGE_KEYS order
export class HarnessUnsupportedError extends Error {}
export function harnessFamily(language: LanguageKey): HarnessFamily;
export function supportsFunctionMode(language: LanguageKey): boolean;
```

### `signature.ts` (modify)
```ts
export const IN_PLACE_PARAM_KINDS = ["list", "matrix", "TreeNode", "ListNode"] as const;
export const RESERVED_IDENTIFIERS: ReadonlySet<string>;   // C++ ∪ Python ∪ Java keywords, plus main, Main, Solution
export function containsDouble(t: TypeNode): boolean;
export function comparedTypeOf(sig: FunctionSignature): TypeNode;
export function functionCompareMode(c: FunctionComparator): "CHECKER" | "TOKEN";
export const FUNCTION_COMPARATOR_DESCRIPTIONS: Readonly<Record<FunctionComparator, { label: string; student: string; author: string }>>;
```
New `superRefine` rules on `functionSignatureSchema`:
- parameter names are unique and not in `RESERVED_IDENTIFIERS`; `methodName` is not reserved;
- `mutatedParam` must be null unless the comparator is IN_PLACE_MUTATION;
- IN_PLACE_MUTATION requires `returns === "void"` and a parameter whose kind is in `IN_PLACE_PARAM_KINDS`;
- the comparator must fit the compared type, per the table in §3.

### `values.ts` (modify)
```ts
export type DecodeResult = { ok: true; canonical: string } | { ok: false; reason: string; offset: number };
export function decodeCanonical(type: TypeNode, text: string): DecodeResult;
export function validateFunctionInput(sig: FunctionSignature, input: string): string[];
export function validateFunctionTest(sig: FunctionSignature, input: string, output: string): string[];
```

**`decodeCanonical` rules**
- It is a type-directed parser with no generic JSON tree, so nesting depth is bounded by the type and the cost is linear.
- **Numbers:** int and long use `-?(0|[1-9]\d*)` with BigInt range checks (exact 64-bit). double uses the JSON number grammar and must be finite.
- **Nulls:** `null` is accepted as `[]` for TreeNode and ListNode. Trailing nulls in a tree are trimmed.
- **Whitespace:** JSON whitespace is allowed between tokens. Anything other than whitespace after the value makes the output malformed.

**`validateFunctionTest`**
- Each input line must decode against its parameter type, and the output must decode against `comparedTypeOf(sig)`.
- Both must already be canonical.
- Strings must be well-formed Unicode. Implement this with a lone-surrogate regex, because tsconfig `lib` is ES2023 and `isWellFormed` is not available.
- `serializeValue` "char" becomes a single **ASCII** character (C++ `char` is a byte).

### `compare.ts` (new)
```ts
export const DEFAULT_FLOAT_EPSILON = 1e-6;           // moved from worker compare.ts:21 (worker imports it)
export interface FunctionCompareSpec { comparator: FunctionComparator; type: TypeNode; floatEpsilon: number }
export function functionCompareSpec(sig: FunctionSignature, floatEpsilon: number | null): FunctionCompareSpec;
export type FunctionCompareResult =
  | { kind: "equal" } | { kind: "different"; reason: string }
  | { kind: "malformed-output"; reason: string } | { kind: "malformed-answer"; reason: string };
export function compareFunctionOutput(spec: FunctionCompareSpec, expected: string, actual: string): FunctionCompareResult; // throws for CUSTOM_CHECKER
export function canonicalizeFunctionOutput(spec: FunctionCompareSpec, actual: string): { ok: true; text: string } | { ok: false; reason: string };
```
Reason texts:
- **Empty output:** "Nothing was printed for the result…"
- **Extra output** (the last line decodes but there is other text): "Standard output must contain only your function's result — remove print statements…"
- **Type mismatch:** "…is not a valid list<int>: …"

### `declaration.ts` (new)
```ts
export interface ComparatorDeclaration { ioMode: IoMode; compareMode: CompareMode; functionSignature: unknown;
  floatEpsilon: number | null; checkerSha256: string | null; testlibId: string | null }
export function comparatorIssues(v: ComparatorDeclaration): string[];
```
It reports:
- STDIN: INTERACTIVE is not available; CHECKER needs a checker and a testlibId.
- FUNCTION: the signature must parse, and the CHECKER mirror must hold.
- CUSTOM_CHECKER: needs a checker.
- FLOAT_TOLERANCE: ε must be null or within (0, 1].

### `java.ts` (new)
```ts
export function javaType(t: TypeNode): string;
export function javaPrelude(sig: FunctionSignature): string;
export function javaDriver(sig: FunctionSignature): string;
export function javaStub(sig: FunctionSignature): string;
```

**Type mapping**
- int → `int`, long → `long`, double → `double`, bool → `boolean`, char → `char`, string → `String`; TreeNode and ListNode keep their names.
- `list<S>` → `S[]` and `matrix<S>` → `S[][]` when S is a scalar or a node type.
- Any other list or matrix → `List<box(X)>` or `List<List<box(X)>>`.
- `pair<A,B>` → `Pair<box(A),box(B)>`.
- Inside generics everything is boxed or `List`.

**Prelude.** Exactly 5 import lines: `java.util.*`, `java.util.function.*`, `java.util.stream.*`, `java.io.*`, `java.math.*`. There are no type declarations before student code, so students' own `import` lines stay legal. The student's first line is program line 6.

**Driver, placed after the student code**
- `ListNode` and `TreeNode` classes, only if used. Their fields and constructors match the C++ definitions in `cpp.ts:38-54`.
- `record Pair<A, B>(A first, B second) {}`, only if used.
- `final class RecxIn`, a char-cursor JSON reader with no external libraries. It provides `integer()` (`Long.parseLong`), `real()`, `bool()`, `str()` (escapes including `\uXXXX`; surrogate pairs concatenate), `tryNull()`, `expect()`, `peek()` and `end()`. On malformed input it calls `fail()`, which prints `harness: malformed input (…)` and exits with code 3.
- `final class RecxOut` handles JSON string escaping (`<0x20` becomes `\u%04x`, everything else raw) and doubles via `Double.toString`.
- `public class Main` holds generated typed readers and writers `rN`/`wN`, one per distinct `TypeNode`. Null TreeNode or ListNode writes `[]`; other nulls write `null`, which the comparator treats as malformed. ListNode writing has a 2,000,000-node cycle guard.
- `main` does the following:
  1. Read stdin with `System.in.readAllBytes()` and split as UTF-8 on `\n`.
  2. If lines are missing, print `harness: missing input line k` and exit 3.
  3. Call through a typed local: `int[] result = sol.twoSum(a0, a1);`. With IN_PLACE_MUTATION, call then write `a{idx}`.
  4. Write the result as UTF-8 bytes via `System.out.write(b, 0, b.length)` and flush.
- The driver uses fully qualified `java.util.*` names throughout, so a student's `import java.awt.*` cannot make it ambiguous.

**Stubs.** `class Solution {` (not public). Node types get one comment line ("The judge defines ListNode (val, next) — do not redefine it"). IN_PLACE_MUTATION stubs get "// Do not return anything: change `nums` in place." The same comment changes go into `cppStub` and `pythonStub`; no current seed is affected.

### `cpp.ts` (modify)
Extract `export function cppReaderKit(sig): string` (the content of lines 64-209) without changing output. `cppDriver` uses it.

### `checker-template.ts` (new)
```ts
export function checkerTemplate(sig: FunctionSignature): string;
```
It emits a complete testlib checker:
- `#include "testlib.h"`, `<bits/stdc++.h>`, the node structs, and `cppReaderKit(sig)`.
- A `main` that reads `inf.readLine()` once per parameter, then `ans.readLine()` and `ouf.readLine()`, through `recx_harness::parse`.
- A `TODO` for the checking logic, with `_fail` on an invalid jury answer.

The checker stays a self-contained, author-owned file. No hidden prelude, no toolchain change.

### `remap.ts` (new)
Moves `index.ts:80-136` here: `export function remapDiagnostics(output, build, boxFileName): string` and `export const GENERATED_CODE_HINT`. `HarnessBuild` gains `family: HarnessFamily`. `buildHarness` and `starterStub` dispatch to java (`displayName "Solution.java"`). Add `export function starterStubs(sig): Partial<Record<LanguageKey,string>>`.

### Other shared changes
- **`languages.ts`:**
  - `export const JVM_LANGUAGE_KEYS: readonly LanguageKey[] = ["java21","kotlin20"]` (`verdict.ts:65` imports it).
  - `export function jvmRunFlags(memoryLimitKb: number): string[]` returns `-Xmx${max(32, floor(0.7·MB))}m` and `-Xss${min(MB, 256)}m`.
- **`protocol.ts:14`:** `JUDGE_PROTOCOL_VERSION = 3`.
- **Root `index.ts`:**
  - extend the `./harness/signature` re-export block (lines 12-19) with `functionCompareMode, comparedTypeOf, FUNCTION_COMPARATOR_DESCRIPTIONS`;
  - add `export { FUNCTION_HARNESS_LANGUAGES, supportsFunctionMode } from "./harness/family"`.
  - Everything else stays on `@recx/shared/harness`.
- **Optional single-sourcing:** move the pure `effectiveVerdict` and `validationOutcome` (`validation.ts:59-74`) to `packages/shared/src/validation-outcome.ts`. `validation.ts` re-exports them, and the golden test reuses them.

## 5. Compile-error remapping (all families)

Dispatch is by `build.family`.

**Common rules**
- A location in the student's range maps to `{displayName}:{line}`.
- A location outside it becomes `[generated driver code]`.
- **No output line may ever show a line number outside 1..userLineCount** (a property test enforces this).

**gcc (cpp17, cpp20)**
- Existing behaviour stays.
- New:
  - drop `note:` lines located in generated code, together with their excerpt and caret lines;
  - drop "In instantiation of …recx_harness…" banners and generated `required from here` lines;
  - rewrite the `In function 'int main()':` banner to "In the judge's code that calls your function:".

**Python (py312 compile check; pypy310 runtime)**
- Existing frame mapping stays: generated frames and their source lines are dropped.

**javac**
- `Main.java:N: error|warning:` headers are mapped.
- After a generated header, drop the raw source line and the `^` caret line.
- Rewrite `location: class Main` to "location: the judge's code that calls your function".
- Map `Note: Main.java uses…` to the display name.

**JVM stack traces**
- Map `at X(Main.java:N)` to `Solution.java:M`, or drop the frame if it is generated.
- Keep `java.base` frames and the `Exception in thread` line.

**Hints** (appended once each, after sanitising): `GENERATED_CODE_HINT` (check the class name and the method name and types against the starter code), plus pattern-triggered hints for:
- `redefinition of 'int main()'`;
- `class Solution is public, should be declared in a file named`;
- `duplicate class: (ListNode|TreeNode|Pair|Main)` and `redefinition of 'struct (ListNode|TreeNode)'`;
- `harness: missing input` (your code read standard input; the judge passes arguments).

## 6. Worker changes (no database access, unchanged)

**`plan.ts`**
- `JudgePlan` gains `functionCompare: FunctionCompareSpec | null`.
- `effectiveCompareMode` for FUNCTION jobs: CUSTOM_CHECKER must be paired with CHECKER and vice versa, else `PermanentJudgeError`. Otherwise it returns the spec mode, which is unused. INTERACTIVE is refused, and so is a FUNCTION job with no signature.
- SET_EQUAL and ROWS_ANY_ORDER are no longer refused.

**`run-job.ts:316-333`** (decode stdout with `new TextDecoder("utf-8",{fatal:true})`, where invalid bytes count as malformed):
- **Structured comparators:** `compareFunctionOutput(...)` returns:
  - `equal` → AC;
  - `different` or `malformed-output` → WA;
  - `malformed-answer` → throw `PermanentJudgeError` (a problem bug, visible to admins).
- **CUSTOM_CHECKER:** `canonicalizeFunctionOutput`. If it fails, the test is WA and the checker never runs. Otherwise `checker.check({ input: <args blob verbatim>, output: Buffer(canonical+"\n"), answer: <expected blob verbatim> })` (`checker.ts:256`).
- Reason texts go into `result.message` only for visible tests or validation jobs, using the same gate as `run-job.ts:338`. Hidden tests carry nothing.

**Other worker files**
- **`limits.ts`:** `export function runArgv(spec): string[]` inserts `jvmRunFlags(spec.memoryLimitKb)` after `argv[0]` for `JVM_LANGUAGE_KEYS`. `run-job.ts:290` uses it. Students cannot influence it; it is published on /judge.
- **`compare.ts`:** imports `DEFAULT_FLOAT_EPSILON` from shared.

## 7. Protocol

**How the comparator reaches the worker:** in `functionSignature` (comparator, mutatedParam, types), `floatEpsilon`, `compareMode` and `checker`. The shape of `judgeJobSpecSchema` is unchanged. I'm deliberately not adding cross-field refines to the spec schema: they would break `scoring.test.ts:339` and `run-job.test.ts:308`. Consistency is checked instead in `buildJudgeJobSpec` (JobSpecError) and in `planJob`.

**Rollout:** deploy web and worker together. v2 workers receive 426 and drain. Postgres keeps the jobs QUEUED and the reconciler re-enqueues them. Add this to `docs/RUNBOOK.md`.

**Coordination:** if any other Phase 4 stream changes `protocol.ts`, all changes share this single 2→3 bump.

## 8. Web changes

This stream adds no pages, routes or server actions, so there are no new guards or audit rows.

**`lib/judge/job-spec.ts`**
- After line 211: for FUNCTION versions, `(sig.comparator==="CUSTOM_CHECKER") !== (compareMode==="CHECKER")` throws `JobSpecError`.
- `floatEpsilon` is passed through.

**`lib/judge/validation.ts`**
- Line 371: `runnable` becomes `configs.has(lang) && (ioMode!=="FUNCTION" || supportsFunctionMode(lang))`.
- Line 143: a distinct note, "has no function harness".
- Line 650: the `comparatorIssues` gate (§3).

**Workspace and run**
- `server/actions/judge.ts` (run path): for FUNCTION problems with custom input, `validateFunctionInput` raises a `ValidationError` naming the line and parameter, before anything is enqueued.
- `server/queries/problems.ts:300-319`: adds `functionUnavailable`.
- `components/workspace/problem-description.tsx:92-97`: copy driven by the comparator — the in-place wording ("…the output is `nums` after your function returns"), "any correct answer is accepted" for CUSTOM_CHECKER, "in any order" for SET_EQUAL.
- `components/workspace/result-view.tsx:31-37,116`, `lib/judge/view.ts` and `server/queries/submissions.ts`: the view carries `functionComparator` (from the version's `functionSignature`). The WA note uses `FUNCTION_COMPARATOR_DESCRIPTIONS[c].student`.

**Optional, owned by the authoring stream:** a "Scaffold from signature" action. It uses `requireActionRole("ADMIN","SUPER_ADMIN")`, takes zod `{versionId}`, is refused on frozen versions by the repository guard, and audits `problem.draft.scaffolded` as NORMAL. It writes `starterStubs(sig)` and `checkerTemplate(sig)`.

## 9. Seed content

All six are new modules in `apps/web/scripts/content/`, appended to `AUTHORED_PROBLEMS` (`index.ts:16`). Titles and statements are original; full content is written later. Each meets the existing contract (2 samples, ≥10 hidden tests, deterministic generator, 3 hints plus an editorial). Each has cpp20, py312 and **java21** model solutions plus at least one deliberately-wrong solution.

| Code | Slug | Title | Diff. | Topics | Signature | Comparator | Statement | Deliberately wrong |
|---|---|---|---|---|---|---|---|---|
| REC-0007 | conveyor-shift | Conveyor Shift | E | ARRAYS_HASHING, TWO_POINTERS | `shiftRight(parcels: list<int>, k: int) -> void` | IN_PLACE (`parcels`) | Shift every parcel on a circular conveyor k places right, rearranging the list in place. | py312 WA: rebinds `parcels`; cpp20 WA: shifts left |
| REC-0008 | playlist-fold | Playlist Fold | M | LINKED_LIST, TWO_POINTERS | `foldPlaylist(head: ListNode) -> void` | IN_PLACE (`head`) | Relink a playlist in place to play first, last, second, second-to-last, … (the head song stays first). | cpp20 WA: interleaves halves without reversing |
| REC-0009 | bench-blackout | Bench Blackout | M | ARRAYS_HASHING | `closeBenches(grid: matrix<int>) -> void` | IN_PLACE (`grid`) | Every row and column of the lab grid that contains a faulty seat (0) is set to 0, in place. | cpp20 WA: zeroes while scanning, so zeros cascade |
| REC-0010 | session-order | Workshop Session Order | M | GRAPHS | `orderSessions(n: int, prerequisites: matrix<int>) -> list<int>` | CUSTOM_CHECKER | Return any order of sessions 0..n−1 in which each `[a, b]` holds a before b (an order always exists). | cpp20 WA: index order |
| REC-0011 | exact-change-pair | Exact Change Pair | E | ARRAYS_HASHING | `findPair(prices: list<int>, amount: long) -> pair<int,int>` | CUSTOM_CHECKER | Return positions i<j of any two items whose prices sum exactly to amount (at least one pair exists). | cpp20 TLE: O(n²); py312 WA: may reuse a position |
| REC-0012 | no-neighbour-seating | No Neighbours Seating | E | MATH_BITS, GREEDY | `arrangeSeats(n: int) -> list<int>` | CUSTOM_CHECKER | Return any seating of roll numbers 1..n with no two neighbours consecutive (n = 1 or n ≥ 4). | cpp20 WA: odds then evens |

**Linked-list choice.** The linked-list in-place problem keeps the head node fixed on purpose. A parameter that is reassigned inside the method is invisible to the caller in all three languages, so "reverse a list in place" cannot be judged by printing the parameter.

**Checkers.** Built from `checkerTemplate`. Each validates the jury answer (`_fail`) and the student's answer (`_wa`).

**Java model solutions** are also added for two-sum (`packages/shared/src/samples/two-sum.ts` `TWO_SUM_REFERENCE.java21`), handle-maker and lab-power-budget.

## 10. Tests mapped to "Done when" for this stream

**Golden gate (the main proof)**
- New file: `apps/judge-worker/test/integration/golden.isolate.test.ts`, box base 64.
- It judges, on real isolate with the `processJob` + `FakeJudgeApi` pattern from `two-sum.isolate.test.ts`:
  - **problems:** two-sum plus every entry in `AUTHORED_PROBLEMS`, imported by relative path from `apps/web/scripts/content/index.ts`;
  - **languages:** catalog `enabledByDefault` (cpp20, py312) ∪ `RECX_GOLDEN_EXTRA_LANGUAGES`;
  - **solutions:** every reference solution in those languages.
- Time limits come from `deriveTimeLimitMs` and `clampCpuLimitMs`. Checkers use testlib.
- **Assertions:**
  - model solutions get AC on all tests;
  - deliberately-wrong solutions match their expected verdict per `validationOutcome`;
  - a missing toolchain or testlib for an enabled or extra language **fails** the test instead of skipping it;
  - every (problem, enabled language) pair has an AC reference, so the gate cannot pass with nothing to check.
- `scripts/dev/linux-gate.sh` (isolate-integration step) adds `RECX_GOLDEN_EXTRA_LANGUAGES=java21`.

**Isolate integration (new)**
- `function-harness.isolate.test.ts` (box base 60): an identity `echo(x: T) -> T` for every grammar type in cpp20, py312 and java21 (plus cpp17 and pypy310 if installed). Edge cases include INT_MIN, LONG_MAX, unicode and escapes, empty containers, `[1,null,2]`, an empty tree, an empty list, and one fixture per comparator, including in-place void.
- `compile-errors.isolate.test.ts` (box base 62), per harness language, on real compilers:
  - an error on student line 3 is reported as `solution.cpp:3`, `solution.py", line 3` or `Solution.java:3`;
  - a signature mismatch produces `[generated driver code]` plus the hint;
  - output never contains `main.cpp`, `Main.java`, `recx_harness`, `_recx_` or `RecxIn`, and no line number above the student's line count.

**Shared unit tests (new)**
- `function-compare.test.ts`:
  - the `"a b"` vs `"a  b"` false-AC regression;
  - 9007199254740993 vs 9007199254740992 is "different";
  - `null` equals `[]` for nodes; trailing tree nulls are trimmed;
  - each comparator's rules; NaN/Infinity is malformed; extra output gives the print-statement message; `malformed-answer`.
- `decode.test.ts`, `java-harness.test.ts`, `remap.test.ts` (fixtures for gcc, CPython, javac and JVM traces, plus the line-range property), `checker-template.test.ts`.

**Updated tests**
- `signature.test.ts`: the new rules.
- `harness.test.ts:62-68`: java21 is now supported; use go123, node22 and c17 as the unsupported examples.
- `run-job.test.ts:319-328`: SET_EQUAL is now judged.
- `scoring.test.ts:377-392`: rewritten for the new mirror rule.
- `argv.test.ts`: JVM flags appear only for JVM languages; still no `--share-net`.
- `judge-job-spec.test.ts`: the mirror JobSpecError.
- `seed-content.test.ts:66-73`:
  - compareMode is `functionCompareMode(sig.comparator)`;
  - ≥3 IN_PLACE_MUTATION and ≥3 CUSTOM_CHECKER seeds;
  - `validateFunctionTest` on every FUNCTION test;
  - JavaScript mirrors of each checker predicate accept the jury answers and reject the wrong-solution mirrors;
  - every `enabledByDefault` language has an AC reference for every seed.

**New tests elsewhere**
- New worker test `apps/judge-worker/test/function-compare-job.test.ts` (FakeSandbox): structured comparison, CUSTOM_CHECKER canonicalisation, message gating.
- `packages/db/test/function-comparator-constraints.test.ts` (`RECX_DB_TESTS`): freezing a version that breaks any of the three CHECKs fails with 23514; the legacy TOKEN/EXACT combination freezes.
- `tests/repo/content-purity.test.ts`: the import closure of `apps/web/scripts/content/index.ts` reaches only `@recx/shared*` and relative content files.

## 11. Docs

**`docs/OPEN-QUESTIONS.md`**, under "Phase 4 — FUNCTION harness":
- the language set and the reasons for the excluded languages;
- java21 is not enabled by default;
- SET_EQUAL vs ROWS_ANY_ORDER semantics;
- doubles are only allowed under FLOAT_TOLERANCE or CUSTOM_CHECKER;
- IN_PLACE_MUTATION needs a void return and a mutable parameter kind;
- the CHECKER mirror rule;
- structured comparison now applies to already-published FUNCTION versions (a harness fix plus an optional rejudge, not a content change);
- any extra stdout is WA, with the open question of framing the result line so debug prints are shown but ignored;
- char is ASCII, and non-ASCII string length differs by language;
- the JVM flag formula;
- the CUSTOM_CHECKER file contract;
- the golden suite imports seed content from apps/web.

**`ARCHITECTURE.md`:** the packages row now reads "FUNCTION harness (C++, Python, Java) + structured comparators".

**`RUNBOOK.md`:** the protocol 3 rollout.

## 12. Interactions and conflict points

- **`schema.prisma`:** untouched. The migration is SQL-only; only its timestamp needs to be unique.
- **Shared `index.ts`:** additive edits only, inside the harness re-export block plus one new line.
- **`protocol.ts`:** one 2→3 bump for the whole phase.
- **`validation.ts`:** three small hunks (lines 143, 371 and 650 plus the `loadState` select). The authoring and review-queue stream should land on top of them, or call `comparatorIssues` itself in its own publish or approve actions.
- **Bulk import and authoring streams** consume:
  - `functionSignatureSchema` (FUNCTION) and an explicit STDIN `compareMode` with no default;
  - `validateFunctionTest`, `starterStubs`, `checkerTemplate`, `supportsFunctionMode`.
- **/judge transparency stream** reads `FUNCTION_HARNESS_LANGUAGES`, `jvmRunFlags` and `FUNCTION_COMPARATOR_DESCRIPTIONS`.
- **"No STUDENT route returns non-sample test files" test:** include `checkerSha256` blobs in its forbidden set.
- **`setLanguageEnabled`** (`admin-judge.ts:233`) is unchanged. Enabling java21 at runtime now makes Java appear on FUNCTION problems; that is the intended switch.
- **Not touched:** auth guards, admin layout, the scheduler.