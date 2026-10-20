import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * The placement and mentor fence (Phase 9d).
 *
 * SPEC's "Done when" for this phase includes a line that cannot be satisfied
 * by a code review: **a PLACEMENT_OFFICER cannot reach notes, drafts or chat
 * content by any route.** The runtime half is
 * apps/web/test/capability-matrix.test.ts, which calls every bound page and
 * action as every role. This is the static half, and it exists because the
 * runtime half can only test what is bound today.
 *
 * Four rules:
 *
 *   R1 — no placement or mentor module touches a forbidden model. The list
 *        is `Note`, `CodeDraft`, `SubmissionSource`, `SubmissionTestDetail`,
 *        `Accommodation` and `AuditLog`. The last two are the ones a review
 *        misses: an accommodation is a disability record and belongs to the
 *        student and the exams office, and the audit log is read by
 *        SUPER_ADMIN alone — the placement surfaces WRITE to it and never
 *        read it.
 *
 *   R2 — the CLASSIFICATION RULE. Every model in the schema is either in the
 *        readable allowlist or the forbidden list. That is how the
 *        unsatisfiable half of the spec's line gets discharged honestly: no
 *        model holding discussion drafts or assistant chat content exists
 *        yet, so a future `DiscussionPost` or `AssistantMessage` fails this
 *        fence the DAY it is added rather than the day somebody notices it
 *        on an officer's screen.
 *
 *   R3 — no cohort surface ranks students by readiness. SPEC §5 is explicit
 *        that readiness is not a ranking of students, so no placement or
 *        mentor module may order by a readiness score column.
 *
 *   R4 — only lib/auth/mentor-scope.ts mints a `ScopedMenteeId`, and every
 *        mentor page resolves one before it reads anything. The mirror of
 *        the AdminScope rule in tests/repo/admin-scope.test.ts, for the same
 *        reason: "whose student is this" should be answered by the type
 *        system rather than by remembering to filter.
 */

const WEB_SRC = "apps/web/src";
const SCHEMA = "packages/db/prisma/schema.prisma";

/**
 * Models a placement or mentor surface MAY read, each with what it is for.
 *
 * This list is the ALLOWLIST and the rule is default-deny: a model that is
 * not here may not be touched from these files. That is the right direction
 * for this fence and it is what discharges the unsatisfiable half of the
 * spec's "Done when" line honestly. No model holding discussion drafts or
 * assistant chat content exists yet (Phase 11+), so there is nothing to
 * assert about them today — but a future `DiscussionPost` or
 * `AssistantMessage` is forbidden the moment it is created, with no list to
 * remember to update.
 *
 * A classification list of all ninety-odd models would have been the other
 * way round, and it would have rotted: the only safe default for a surface
 * that reads other people's data is no.
 */
const PLACEMENT_READABLE_MODELS: Readonly<Record<string, string>> = {
  User: "the cohort itself: batch, department, section, status",
  ReadinessRun: "which nightly run the figures come from",
  ReadinessSnapshot: "the figures, and the breakdown behind them",
  MentorAssignment: "who a student is routed to, and who asked",
  ActivityDay: "days practised, for the quiet-days figure",
  UserStats: "solved counts and the assisted split",
  UserProblemStatus: "per-problem solved state, which coverage is counted from",
  Problem: "difficulty, to group coverage by",
  ProblemTag: "the topic tags, which breadth is counted over",
  Contest: "which rated rounds a cohort has had",
  ContestRegistration: "entry counts, in aggregate",
  ContestStanding: "contest performance, in aggregate",
  UserRating: "the rating and how many rated contests it rests on",
  AptitudeUserTopicStat: "aptitude accuracy per topic, which is already an aggregate",
  MockAttempt: "mock results, in aggregate",
  MockPattern: "which pattern a mock followed, to label the aggregate",
  Assessment: "released assessment scores, which the spec's export allowlist names",
  AssessmentAttempt: "one student's released assessment score, for the same allowlist",
  Submission: "counts and verdicts; the SOURCE is a separate model and is forbidden",
};

/**
 * The six the spec names, kept explicit although default-deny already covers
 * them.
 *
 * Not redundant: this is the list a reader checks against the spec, and the
 * test below asserts each one is absent from the allowlist. Default-deny
 * protects against what nobody thought of; this protects against somebody
 * adding one of these to the allowlist to make a feature work.
 *
 * The last two are the ones a review misses. An accommodation is a
 * disability record and belongs to the student and the exams office. The
 * audit log is read by SUPER_ADMIN alone — the placement surfaces WRITE to
 * it and never read it, which is the point of auditing a drill-down.
 */
const SPEC_FORBIDDEN_MODELS: Readonly<Record<string, string>> = {
  Note: "a student's private notes, which are theirs",
  CodeDraft: "unsubmitted code, which is theirs",
  SubmissionSource: "the code of a submission; an officer needs counts, never source",
  SubmissionTestDetail: "per-test detail of a submission, for the same reason",
  Accommodation: "a disability record: it belongs to the student and the exams office",
  AuditLog: "read by SUPER_ADMIN only; these surfaces write to it and never read it",
};

interface ModelField {
  name: string;
  type: string;
}

function parseModels(schema: string): Map<string, ModelField[]> {
  const models = new Map<string, ModelField[]>();
  const text = schema.replace(/\/\/.*$/gm, "");
  for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields: ModelField[] = [];
    for (const line of m[2]!.split("\n")) {
      const f = /^\s*(\w+)\s+(\w+)(\[\])?\??/.exec(line);
      if (f && !line.trim().startsWith("@@")) fields.push({ name: f[1]!, type: f[2]! });
    }
    models.set(m[1]!, fields);
  }
  return models;
}

const schemaModels = parseModels(readRepoFile(SCHEMA));
const delegateOf = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

/** Prisma delegate calls in a file: `db.note.findMany(` → "note". */
const CALL = /\b(?:db|tx|client)\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z]+)\s*\(/g;

export function delegatesUsed(source: string): Array<{ delegate: string; method: string; line: number }> {
  const { code } = lexSource(source);
  const out: Array<{ delegate: string; method: string; line: number }> = [];
  for (const m of code.matchAll(CALL)) {
    out.push({ delegate: m[1]!, method: m[2]!, line: lineAt(source, m.index) });
  }
  return out;
}

/**
 * The placement and mentor surfaces: the two app trees, the two component
 * folders, and the query and action modules named for either role.
 *
 * Named by PREFIX rather than listed, so a new `placement-drives.ts` is
 * covered the moment it is created. apps/web/test/student-exposure.db.test.ts
 * relies on the same convention from the other direction.
 */
function placementFiles(): string[] {
  const underTrees = findFiles({
    under: [
      `${WEB_SRC}/app/placement-cell`,
      `${WEB_SRC}/app/mentor`,
      `${WEB_SRC}/components/placement`,
      `${WEB_SRC}/components/mentor`,
    ],
    extensions: CODE_EXTENSIONS,
    exclude: isTestPath,
  });
  const byPrefix = findFiles({
    under: [`${WEB_SRC}/server/queries`, `${WEB_SRC}/server/actions`],
    extensions: [".ts"],
    exclude: isTestPath,
  }).filter((f) => /\/(?:placement|mentor)-[^/]+\.ts$/.test(f));
  return [...new Set([...underTrees, ...byPrefix, `${WEB_SRC}/lib/auth/mentor-scope.ts`])].sort();
}

const FILES = placementFiles();
const SOURCES = new Map(FILES.map((f) => [f, readRepoFile(f)] as const));

describe("the fence covers something", () => {
  it("finds the placement and mentor surfaces", () => {
    // A fence over nothing passes vacuously, which is the failure mode of
    // every prefix-based rule.
    expect(FILES).toContain(`${WEB_SRC}/app/placement-cell/page.tsx`);
    expect(FILES).toContain(`${WEB_SRC}/app/mentor/page.tsx`);
    expect(FILES).toContain(`${WEB_SRC}/app/mentor/[menteeId]/page.tsx`);
    expect(FILES).toContain(`${WEB_SRC}/server/queries/placement-overview.ts`);
    expect(FILES).toContain(`${WEB_SRC}/server/queries/mentor-mentees.ts`);
    expect(FILES.length).toBeGreaterThanOrEqual(6);
  });

  it("does NOT cover the student's own readiness page", () => {
    // `/placement` is the student's own card and reads their own row. It is
    // fenced by tests/repo/readiness-copy.test.ts and by the student
    // exposure sweep, not by the officer rules here.
    expect(FILES).not.toContain(`${WEB_SRC}/app/(student)/placement/page.tsx`);
    expect(FILES).not.toContain(`${WEB_SRC}/server/queries/readiness.ts`);
  });
});

describe("R1 — a placement or mentor surface reads only what it is allowed to", () => {
  const allowed = new Set(Object.keys(PLACEMENT_READABLE_MODELS).map(delegateOf));

  it.each(FILES)("%s", (file) => {
    const source = SOURCES.get(file)!;
    const offenders = delegatesUsed(source)
      .filter((call) => !allowed.has(call.delegate))
      .map((call) => {
        const model = call.delegate.charAt(0).toUpperCase() + call.delegate.slice(1);
        const why = SPEC_FORBIDDEN_MODELS[model];
        return `${file}:${call.line}: db.${call.delegate}.${call.method}()${why ? ` — ${model} is ${why}` : ""}`;
      });
    expect(
      offenders,
      [
        "A placement or mentor surface reads a model that is not on its allowlist.",
        "",
        "SPEC: a PLACEMENT_OFFICER cannot reach notes, drafts or chat content by",
        "any route. A mentor is there to have a conversation about coverage, and a",
        "surface that showed them a student's unsubmitted code would change what",
        "that conversation is.",
        "",
        "If the model really is cohort data, add it to PLACEMENT_READABLE_MODELS in",
        "tests/repo/placement-fence.test.ts with what it is needed for. If in doubt,",
        "it is not: an officer surface that never needed a model costs nothing, and",
        "one that reads a private model costs the student.",
        "",
        offenders.join("\n"),
      ].join("\n"),
    ).toEqual([]);
  });

  it("the six models the spec names are not on the allowlist", () => {
    const leaked = Object.keys(SPEC_FORBIDDEN_MODELS).filter((model) => model in PLACEMENT_READABLE_MODELS);
    expect(leaked, `the spec forbids these: ${leaked.join(", ")}`).toEqual([]);
  });

  it("names models the schema actually has, on both lists", () => {
    // An entry for a model that was renamed would silently stop meaning
    // anything: the allowlist would permit a delegate nothing calls, and the
    // spec list would forbid a model that no longer exists.
    const missing = [...Object.keys(PLACEMENT_READABLE_MODELS), ...Object.keys(SPEC_FORBIDDEN_MODELS)].filter(
      (model) => !schemaModels.has(model),
    );
    expect(missing, `not in schema.prisma any more: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every entry a reason", () => {
    for (const [model, why] of Object.entries({ ...PLACEMENT_READABLE_MODELS, ...SPEC_FORBIDDEN_MODELS })) {
      expect(why.length, model).toBeGreaterThan(10);
    }
  });
});

describe("R2 — default-deny, so a model nobody has written yet is already forbidden", () => {
  const allowed = new Set(Object.keys(PLACEMENT_READABLE_MODELS).map(delegateOf));

  it("forbids every model in the schema that is not on the allowlist", () => {
    /**
     * The rule stated as a property rather than as a list. Most of the
     * schema is unreachable from these files, and that is the default: the
     * count is reported so a reader can see the allowlist is a small
     * fraction of the whole, not most of it with a few holes.
     */
    const forbidden = [...schemaModels.keys()].filter((model) => !allowed.has(delegateOf(model)));
    expect(forbidden.length).toBeGreaterThan(schemaModels.size / 2);
    for (const model of Object.keys(SPEC_FORBIDDEN_MODELS)) expect(forbidden, model).toContain(model);
  });

  it("would catch a Phase 11 discussion model on the day it is added", () => {
    // The assertion that makes the rule meaningful: simulate the model
    // arriving, and the allowlist check must refuse it with no edit here.
    for (const future of ["DiscussionPost", "DoubtThread", "AssistantMessage", "ChatTurn"]) {
      expect(allowed.has(delegateOf(future)), future).toBe(false);
    }
  });
});

describe("R3 — no cohort surface ranks students by readiness", () => {
  /** The three score columns, in an orderBy or a raw ORDER BY. */
  const RANKING = /orderBy[\s\S]{0,160}?\b(?:serviceScore|productScore|topScore)\b|ORDER\s+BY[^;]{0,80}?\b(?:serviceScore|productScore|topScore)\b/i;

  it.each(FILES)("%s", (file) => {
    const { code } = lexSource(SOURCES.get(file)!);
    expect(
      RANKING.test(code),
      [
        `${file} orders by a readiness score.`,
        "",
        "SPEC §5: readiness is a preparation-coverage measure, explicitly not a",
        "ranking of students. A sorted list of students by readiness is a ranking",
        "whatever it is called, and it is the one output of this phase that would",
        "turn a coverage figure into a verdict.",
        "",
        "Order by days quiet, by section, or by name. Not by the score.",
      ].join("\n"),
    ).toBe(false);
  });

  it("catches the shapes it is meant to", () => {
    // Without this the regex could be narrowed until the rule passed
    // vacuously. Three that must be caught and two that must not.
    expect(RANKING.test('orderBy: { serviceScore: "desc" }')).toBe(true);
    expect(RANKING.test("orderBy: [{ section: \"asc\" }, { topScore: \"desc\" }]")).toBe(true);
    expect(RANKING.test('ORDER BY s."productScore" DESC')).toBe(true);
    expect(RANKING.test('orderBy: { lastActiveOn: "asc" }'), "quiet days is the allowed sort").toBe(false);
    expect(RANKING.test("const serviceScore = row.serviceScore;"), "reading a score is fine").toBe(false);
  });
});

describe("R4 — only mentor-scope mints a ScopedMenteeId, and every mentor page resolves one", () => {
  const MINT = /\bas\s+ScopedMenteeId\b/;
  const SCOPE_MODULE = `${WEB_SRC}/lib/auth/mentor-scope.ts`;

  it("the brand is minted in exactly one file", () => {
    const minters = [
      ...findFiles({ under: [WEB_SRC], extensions: CODE_EXTENSIONS, exclude: isTestPath }),
    ].filter((file) => MINT.test(lexSource(readRepoFile(file)).code));
    expect(
      minters,
      [
        "A ScopedMenteeId is minted outside lib/auth/mentor-scope.ts.",
        "",
        "The brand is the whole mechanism: a per-mentee query takes one rather",
        'than a string, so "whose student is this" is answered by the type system.',
        "A cast anywhere else is a hole with a type annotation over it.",
      ].join("\n"),
    ).toEqual([SCOPE_MODULE]);
  });

  it("mentor-scope fails closed, visibly", () => {
    const source = readRepoFile(SCOPE_MODULE);
    // A mentor's scope is their LIVE assignments. Without the endedAt
    // filter an ended assignment would keep its access for ever.
    expect(source).toMatch(/endedAt:\s*null/);
    // And a probe for somebody else's mentee must look exactly like a probe
    // for a student who does not exist.
    expect(source).toMatch(/NotFoundError|notFound\(\)/);
  });

  it.each(
    findFiles({ under: [`${WEB_SRC}/app/mentor`], extensions: CODE_EXTENSIONS, exclude: isTestPath }).filter((f) =>
      /\[menteeId\]/.test(f),
    ),
  )("%s resolves the mentee before it reads anything", (file) => {
    const { code } = lexSource(readRepoFile(file));
    const resolve = code.search(/\brequireScopedMentee(?:Page)?\s*\(/);
    expect(resolve, `${file} never resolves the id through mentor-scope`).toBeGreaterThan(-1);
    // Everything the page reads of the student must come after it. The
    // scope load itself is keyed on the VIEWER and necessarily comes first.
    const read = code.search(/\bmenteeDetail\s*\(|\bdb\s*\.\s*(?!mentorAssignment)/);
    if (read >= 0) {
      expect(read, `${file} reads the student before resolving the id`).toBeGreaterThan(resolve);
    }
  });

  it("every mentor and placement page runs its role guard before it reads anything", () => {
    for (const file of findFiles({
      under: [`${WEB_SRC}/app/mentor`, `${WEB_SRC}/app/placement-cell`],
      extensions: CODE_EXTENSIONS,
      exclude: isTestPath,
    })) {
      /**
       * From `export default` onwards, not from the top of the file: the
       * import list names every helper the component calls, so a whole-file
       * search finds `loadMentorScope` on line 6 and reports the guard as
       * running too late in a file where it runs first.
       */
      const { code } = lexSource(readRepoFile(file));
      const body = code.slice(code.indexOf("export default"));
      const guard = body.search(/\brequire(?:Mentor|Placement)(?:Page|Action)\s*\(/);
      const touch = body.search(/\bdb\s*\.\s*\w|\bloadMentorScope\s*\(|\bmenteeDetail\s*\(|\bmyMentees\s*\(|\bplacementOverview\s*\(/);
      expect(guard, `${file}: no mentor or placement guard`).toBeGreaterThan(-1);
      if (touch >= 0) expect(touch, `${file}: reads before its guard`).toBeGreaterThan(guard);
    }
  });
});

describe("R5 — a declared brand symbol is never written at runtime", () => {
  /**
   * The bug this rule came out of.
   *
   * `declare const MENTOR_SCOPE: unique symbol` emits NOTHING. A brand built
   * as `{ ...fields, [MENTOR_SCOPE]: true }` therefore typechecks perfectly
   * and throws `ReferenceError: MENTOR_SCOPE is not defined` the first time
   * the object is constructed. It did, and four separate suites missed it:
   * typecheck believes the declaration, and the capability matrix hangs its
   * database stub, so the literal was never reached.
   *
   * The correct idiom is the one `buildStudentScope` already used: brand the
   * TYPE and cast in the constructor. So the rule is simply that a symbol
   * declared with `declare const` never appears as a computed property key.
   */
  const AUTH_FILES = findFiles({
    under: [`${WEB_SRC}/lib/auth`],
    extensions: [".ts"],
    exclude: isTestPath,
  });

  /** Symbols declared but not defined in this file. */
  function declaredSymbols(code: string): string[] {
    return [...code.matchAll(/\bdeclare\s+const\s+([A-Za-z_$][\w$]*)\s*:\s*unique\s+symbol/g)].map((m) => m[1]!);
  }

  /**
   * `[NAME]:` used as an OBJECT-LITERAL key, which needs a runtime value.
   *
   * The distinction is `readonly`: a computed key written `readonly [X]: true`
   * is a type member and compiles to nothing, while the same key without it
   * is a property somebody is trying to build at run time. Looking at the
   * token before the bracket separates the two without parsing TypeScript.
   */
  function writtenAsKey(code: string, name: string): boolean {
    const key = new RegExp(String.raw`\[\s*${name}\s*\]\s*:`, "g");
    for (const match of code.matchAll(key)) {
      const before = code.slice(0, match.index).trimEnd();
      if (!/\breadonly$/.test(before)) return true;
    }
    return false;
  }

  it.each(AUTH_FILES)("%s", (file) => {
    const { code } = lexSource(readRepoFile(file));
    const offenders = declaredSymbols(code)
      .filter((name) => writtenAsKey(code, name))
      .map(
        (name) =>
          `${file}: [${name}] is written as an object key, but \`declare const\` emits no value — ` +
          "this throws ReferenceError on the first render. Brand the type and cast in the constructor.",
      );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("catches the shape it is meant to, and not the type declaration", () => {
    const declaration = ["declare const BRAND: unique symbol;", "export type T = { readonly [BRAND]: true };"];
    const bad = [...declaration, "const t = { a: 1, [BRAND]: true } as T;"].join("\n");
    const good = [...declaration, "const t = { a: 1 } as T;"].join("\n");
    const alsoBad = [...declaration, "function f(): T { return { [BRAND]: true, a: 1 }; }"].join("\n");

    expect(declaredSymbols(bad)).toEqual(["BRAND"]);
    expect(writtenAsKey(bad, "BRAND"), "the literal that throws").toBe(true);
    expect(writtenAsKey(alsoBad, "BRAND"), "and the same thing in a return").toBe(true);
    expect(writtenAsKey(good, "BRAND"), "the type declaration alone is fine").toBe(false);
    // The real files: both brand their types and cast, so both must pass.
    expect(writtenAsKey(declaration.join("\n"), "BRAND"), "a type member is not a runtime key").toBe(false);
  });

  it("covers the files that have brands at all", () => {
    // A rule over no files passes vacuously.
    const withBrands = AUTH_FILES.filter((f) => declaredSymbols(lexSource(readRepoFile(f)).code).length > 0);
    expect(withBrands).toContain(`${WEB_SRC}/lib/auth/mentor-scope.ts`);
    expect(withBrands).toContain(`${WEB_SRC}/lib/auth/scope-where.ts`);
  });
});
