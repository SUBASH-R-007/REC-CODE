import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LANGUAGE_CATALOG } from "@recx/shared";
import { collectStrings } from "./support/collect-strings";

/**
 * Phase 4 gate, runtime half: "no STUDENT-reachable route can return a
 * non-sample test file or a ReferenceSolution.source" (gate-tests §4.3 D2;
 * the static half is tests/repo/student-exposure.test.ts).
 *
 * A published, frozen CHECKER problem carries canary strings in every place
 * a student must never see: hidden test input and output (inline), a hidden
 * test held only in the test-data store (storageKey), the cpp20 AC and py312
 * WA reference sources, the checker source, and the statement of an open
 * draft revision (plus a never-published draft problem). Student S has a
 * DONE WA submission whose stored jsonb hidden entry is deliberately
 * polluted with in/out/input/expected/stdout keys, sample-only
 * SubmissionTestDetail rows, a DONE RunRequest (also polluted), a bookmark,
 * a note, activity, a solved-status row and two study-plan memberships.
 *
 * As S the test then calls:
 *   - every exported method of every src/app/**\/route.ts (ROUTE_CALLS must
 *     cover the glob); api/judge/* without node headers must refuse (401 or
 *     426), and POST /api/admin/problems/import must answer 403;
 *   - every export of the non-admin, non-super src/server/queries/*.ts
 *     modules (QUERY_CALLS, or NOT_PROBLEM_SCOPED with a reason);
 *   - every student page, layout, loading and not-found entry (PAGE_CALLS,
 *     or PAGE_SKIPS with a reason), rendered by awaiting the component and
 *     expanding its async children (test/support/collect-strings.ts);
 *   - every export of every server-action module: the self-service ones with
 *     fixture inputs, every other one must refuse S with exactly Forbidden.
 *
 * Every output goes through JSON.stringify (pages: their collected strings)
 * and must contain no secret canary. Positive controls: the workspace output
 * contains the SAMPLE canary, and the submission view drops the polluted keys.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database). Redis, the judge queue, the test-data store,
 * audit and rate limits are fakes; the session is S.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";

const h = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  class RedirectSentinel extends Error {
    constructor(readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.name = "RedirectSentinel";
    }
  }
  class NotFoundSentinel extends Error {
    constructor() {
      super("NEXT_NOT_FOUND");
      this.name = "NotFoundSentinel";
    }
  }
  const objects = new Map<string, Buffer>();
  return {
    RedirectSentinel,
    NotFoundSentinel,
    state: { user: null as Record<string, unknown> | null },
    enqueued: [] as { kind: string; id: string; lane: string }[],
    store: {
      driver: "local" as const,
      async put(key: string, bytes: Buffer) {
        objects.set(key, bytes);
      },
      async get(key: string) {
        const bytes = objects.get(key);
        if (!bytes) throw new Error(`missing ${key}`);
        return bytes;
      },
      async exists(key: string) {
        return objects.has(key);
      },
      async stream(key: string): Promise<ReadableStream<Uint8Array>> {
        return new Blob([new Uint8Array(objects.get(key) ?? Buffer.alloc(0))]).stream();
      },
    },
  };
});

vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  redirect: (url: string) => {
    throw new h.RedirectSentinel(url);
  },
  permanentRedirect: (url: string) => {
    throw new h.RedirectSentinel(url);
  },
  notFound: () => {
    throw new h.NotFoundSentinel();
  },
}));
vi.mock("next/headers", () => {
  const jar = {
    get: () => undefined,
    getAll: () => [],
    has: () => false,
    set: () => undefined,
    delete: () => undefined,
  };
  return {
    cookies: async () => jar,
    headers: async () => new Headers({ host: "localhost", "user-agent": "student-exposure-test" }),
    draftMode: async () => ({ isEnabled: false }),
  };
});
vi.mock("next/cache", () => ({
  unstable_cache: <T>(fn: T) => fn,
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock("next/font/google", () => {
  const font = () => ({ className: "font", variable: "--font", style: { fontFamily: "font" } });
  return { Inter: font, Sora: font };
});
vi.mock("@/lib/auth/session", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  getCurrentUser: async () => h.state.user,
  currentSessionId: async () => null,
  createSession: async () => undefined,
  destroySession: async () => undefined,
  destroyAllSessions: async () => undefined,
}));
vi.mock("@/lib/redis", () => ({
  redis: () => ({
    publish: async () => 1,
    status: "ready",
  }),
  newSubscriber: () => {
    throw new Error("no Redis in this test");
  },
}));
vi.mock("@/lib/rate-limit", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  hitRateLimit: async (name: string) => ({ allowed: true, remaining: 99, retryAfterMs: 0, key: name, member: "m", failedOpen: false }),
  releaseRateLimit: async () => undefined,
  resetRateLimit: async () => undefined,
}));
vi.mock("@/lib/judge/queue", () => ({
  enqueueJudge: async (kind: string, id: string, lane: string) => {
    h.enqueued.push({ kind, id, lane });
    return true;
  },
}));
vi.mock("@/lib/testdata/store", () => ({ getTestDataStore: () => h.store }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined, auditMany: async () => undefined }));
vi.mock("@/lib/ip", () => ({
  requestIp: async () => null,
  requestIpHash: async () => null,
  hashIp: () => "x",
  hashUserAgent: () => "ua",
}));

const SRC = path.resolve(__dirname, "../src");
const APP = path.join(SRC, "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Repo-style path relative to src/app, posix separators. */
const appRel = (full: string) => path.relative(APP, full).split(path.sep).join("/");

const appFiles = walk(APP).map(appRel);
const routeFiles = appFiles.filter((f) => f.endsWith("/route.ts")).sort();
const ENTRY = /(?:^|\/)(?:page|layout|loading|error|global-error|not-found|template|default)\.tsx?$/;
const studentEntries = appFiles
  .filter((f) => ENTRY.test(f) && !/^(?:admin|super|api)\//.test(f))
  .sort();
const isClientModule = (rel: string) => /^\s*["']use client["']/.test(readFileSync(path.join(APP, rel), "utf8"));

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

type Loaded = Record<string, unknown>;
const load = (abs: string) => import(/* @vite-ignore */ abs) as Promise<Loaded>;

describe.skipIf(!ENABLED)("student exposure canaries against recx_test", () => {
  const tag = `sx-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const C = {
    hiddenIn: `HIDDEN-IN-${tag}`,
    hiddenOut: `HIDDEN-OUT-${tag}`,
    hiddenBig: `HIDDEN-BIG-${tag}`,
    refSrc: `REF-SRC-${tag}`,
    checkerSrc: `CHECKER-SRC-${tag}`,
    draftStmt: `DRAFT-STMT-${tag}`,
    sampleIn: `SAMPLE-IN-${tag}`,
    // Phase 7: the worked explanation is the aptitude answer key's twin. A
    // student may read it only AFTER they have committed an answer, so it is
    // a secret everywhere the canary sweep goes.
    aptExplain: `APT-EXPLAIN-${tag}`,
  };
  const SECRETS = [C.hiddenIn, C.hiddenOut, C.hiddenBig, C.refSrc, C.checkerSrc, C.draftStmt, C.aptExplain];

  let db: (typeof import("@/lib/db"))["db"];
  let boardModel: typeof import("@/components/leaderboard/model");
  let catalogFilters: typeof import("@/components/problems/catalog-filters");
  const ids = {
    user: "",
    handle: "",
    problem: "",
    slug: `${tag}-p`,
    draftProblem: "",
    draftSlug: `${tag}-d`,
    live: "",
    draft: "",
    submission: "",
    run: "",
    note: "",
    sheet: "",
    track: "",
    sheetSlug: `${tag}-sheet`,
    trackSlug: `${tag}-track`,
    contest: "",
    contestSlug: `${tag}-contest`,
    contestProblem: "",
    assessment: "",
    assessmentSlug: `${tag}-exam`,
    assessmentProblem: "",
    examSession: "",
    attempt: "",
    submitAttempt: "",
    cpp20Config: "",
    aptitudeQuestion: "",
    aptitudePattern: "",
    aptitudePatternSlug: `${tag}-mock`,
    aptitudeSection: "",
    mockAttempt: "",
  };
  /**
   * The attempt token S holds, so the heartbeat's AUTHENTICATED path is the
   * one the canary sweep calls. A refused heartbeat proves nothing: it never
   * reads the paper.
   */
  const ATTEMPT_TOKEN = `${tag}-attempt-token`;
  const blobShas: string[] = [];
  const createdNoteIds: string[] = [];

  /** Every output checked, with where it came from. */
  const outputs: { where: string; text: string }[] = [];
  const record = (where: string, value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    outputs.push({ where, text: text ?? "" });
    return text ?? "";
  };
  const leaks = (text: string) => SECRETS.filter((s) => text.includes(s));

  /**
   * The ONE place a student may legitimately meet the worked explanation: the
   * practice action, on the same round trip in which it committed their
   * answer. SPEC §5's design is "the explanation enters the DOM only after
   * the answer is committed", and an action that has just written the answer
   * is exactly that moment — the check lives in the write rather than in a
   * later read that would have to re-establish it.
   *
   * Recorded here rather than exempted, so the sweep ALSO fails if the
   * explanation stops being returned. A positive control is stronger than a
   * hole.
   */
  const EXPLANATION_CARRIER = "action aptitude#answerPractice";

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    db = (await import("@/lib/db")).db;
    boardModel = await import("@/components/leaderboard/model");
    catalogFilters = await import("@/components/problems/catalog-filters");
    const { ensureTestBlob } = await import("@/lib/testdata/blobs");
    const blob = async (text: string) => {
      const row = await ensureTestBlob(db, h.store, Buffer.from(text, "utf8"));
      blobShas.push(row.sha256);
      return row.sha256;
    };

    for (const key of ["cpp20", "py312"] as const) {
      const rt = LANGUAGE_CATALOG[key];
      const fields = { label: rt.label, version: rt.version, runtime: JSON.parse(JSON.stringify(rt)), enabled: true, isCurrent: true };
      const row = await db.languageConfig.upsert({
        where: { key_toolchainId: { key, toolchainId: rt.toolchainId } },
        create: { key, toolchainId: rt.toolchainId, ...fields },
        update: fields,
        select: { id: true },
      });
      if (key === "cpp20") ids.cpp20Config = row.id;
    }

    ids.handle = tag.replace(/-/g, "").slice(0, 24);
    const user = await db.user.create({
      data: {
        collegeId: tag.toUpperCase(),
        email: `${tag}@rec-code.example`,
        firstName: "Exposure",
        lastName: "Student",
        handle: ids.handle,
        role: "STUDENT",
        batchYear: 2027,
        departmentCode: "CSE",
        section: "A",
        visibility: "PUBLIC",
      },
    });
    ids.user = user.id;
    h.state.user = { ...user, impersonation: undefined };

    // ── the problem: tests, references, checker, help ──
    const sampleIn = await blob(`${C.sampleIn}\n`);
    const sampleOut = await blob(`SAMPLE-OUT-${tag}\n`);
    const hiddenIn = await blob(`${C.hiddenIn}\n`);
    const hiddenOut = await blob(`${C.hiddenOut}\n`);
    // > 64 KB: held only in the (fake) test-data store under storageKey.
    const big = await blob(`${C.hiddenBig}\n${"9 ".repeat(40_000)}\n`);
    const bigRow = await db.testBlob.findUniqueOrThrow({ where: { sha256: big }, select: { inline: true, storageKey: true } });
    expect(bigRow.inline).toBeNull();
    expect(bigRow.storageKey).toBeTruthy();
    const checker = await blob(`#include "testlib.h"\n// ${C.checkerSrc}\nint main(int argc, char* argv[]) { registerTestlibCmd(argc, argv); quitf(_ok, "ok"); }\n`);

    const problem = await db.problem.create({
      data: { slug: ids.slug, displayCode: `${tag}-P`.toUpperCase(), title: `Exposure ${tag}`, difficulty: "EASY" },
      select: { id: true },
    });
    ids.problem = problem.id;
    const versionData = (revision: number, statementMd: string) => ({
      problemId: problem.id,
      revision,
      title: `Exposure ${tag}`,
      difficulty: "EASY" as const,
      statementMd,
      ioMode: "STDIN" as const,
      compareMode: "CHECKER" as const,
      scoringMode: "ICPC" as const,
      timeLimitMs: 1000,
      checkerSha256: checker,
      testlibId: "testlib-0.9.41",
    });
    const live = await db.problemVersion.create({ data: versionData(1, `Read a line and echo it, ${tag}.`), select: { id: true } });
    ids.live = live.id;
    await db.testCase.createMany({
      data: [
        { problemVersionId: live.id, index: 0, isSample: true, inputSha256: sampleIn, outputSha256: sampleOut },
        { problemVersionId: live.id, index: 1, isSample: false, inputSha256: hiddenIn, outputSha256: hiddenOut },
        { problemVersionId: live.id, index: 2, isSample: false, inputSha256: big, outputSha256: hiddenOut },
      ],
    });
    await db.referenceSolution.createMany({
      data: [
        { problemVersionId: live.id, language: "cpp20", label: "model", source: `// ${C.refSrc}\nint main() { return 0; }\n`, expectedVerdict: "AC" },
        { problemVersionId: live.id, language: "py312", label: "wrong", source: `# ${C.refSrc}\nprint(input())\n`, expectedVerdict: "WA" },
      ],
    });
    await db.hint.createMany({
      data: [1, 2, 3].map((tier) => ({ problemVersionId: live.id, tier, contentMd: `Hint ${tier} for ${tag}.` })),
    });
    await db.editorial.create({ data: { problemVersionId: live.id, contentMd: `Editorial for ${tag}.` } });
    const now = new Date();
    await db.problemVersion.update({ where: { id: live.id }, data: { status: "PUBLISHED", frozenAt: now, publishedAt: now } });
    await db.problem.update({ where: { id: problem.id }, data: { status: "PUBLISHED", liveVersionId: live.id, version: 1 } });

    // An open draft revision of the same problem, and a never-published problem.
    const draft = await db.problemVersion.create({ data: versionData(2, `New statement ${C.draftStmt}`), select: { id: true } });
    ids.draft = draft.id;
    await db.testCase.create({
      data: { problemVersionId: draft.id, index: 0, isSample: true, inputSha256: sampleIn, outputSha256: sampleOut },
    });
    const draftProblem = await db.problem.create({
      data: { slug: ids.draftSlug, displayCode: `${tag}-D`.toUpperCase(), title: `Draft ${tag}`, difficulty: "EASY" },
      select: { id: true },
    });
    ids.draftProblem = draftProblem.id;
    await db.problemVersion.create({
      data: { ...versionData(1, `Unreleased ${C.draftStmt}`), problemId: draftProblem.id },
    });

    // ── S's history on the problem ──
    const polluted = { i: 1, v: "WA", ms: 3, kb: 9, in: C.hiddenIn, out: C.hiddenOut, input: C.hiddenIn, expected: C.hiddenOut, stdout: C.hiddenOut, stderr: C.hiddenIn };
    const submission = await db.submission.create({
      data: {
        userId: user.id,
        problemId: problem.id,
        problemVersionId: live.id,
        languageConfigId: ids.cpp20Config,
        language: "cpp20",
        status: "DONE",
        judgeState: "DONE",
        verdict: "WA",
        passedCases: 1,
        totalCases: 3,
        maxTimeMs: 3,
        maxMemoryKb: 9,
        firstFailedIndex: 1,
        testResults: [{ i: 0, v: "AC", ms: 2, kb: 8 }, polluted, { i: 2, v: "SKIPPED", ms: 0, kb: 0 }],
        sourceSha256: "1".repeat(64),
        sourceBytes: 24,
        judgedAt: now,
        source: { create: { source: "int main() { return 0; }\n" } },
        details: { create: [{ testIndex: 0, input: `${C.sampleIn}\n`, expected: `SAMPLE-OUT-${tag}\n`, stdout: `SAMPLE-OUT-${tag}\n`, stderr: "" }] },
      },
      select: { id: true },
    });
    ids.submission = submission.id;
    const run = await db.runRequest.create({
      data: {
        userId: user.id,
        problemVersionId: live.id,
        languageConfigId: ids.cpp20Config,
        language: "cpp20",
        source: "int main() { return 0; }\n",
        status: "DONE",
        judgeState: "DONE",
        verdict: "WA",
        result: [{ i: 0, v: "AC", ms: 2, kb: 8, stdout: `SAMPLE-OUT-${tag}\n` }, polluted],
        judgedAt: now,
        expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      },
      select: { id: true },
    });
    ids.run = run.id;
    await db.bookmark.create({ data: { userId: user.id, problemId: problem.id } });
    const note = await db.note.create({ data: { userId: user.id, problemId: problem.id, title: `Note ${tag}`, contentMd: "My own note." }, select: { id: true } });
    ids.note = note.id;
    await db.problemActivity.create({ data: { userId: user.id, problemId: problem.id, activeSeconds: 120 } });
    await db.userProblemStatus.create({
      data: { userId: user.id, problemId: problem.id, status: "ATTEMPTED", attempts: 1, failedAttempts: 1, firstAttemptAt: now, lastAttemptAt: now },
    });
    for (const [kind, slug] of [["SHEET", ids.sheetSlug], ["TRACK", ids.trackSlug]] as const) {
      const plan = await db.studyPlan.create({
        data: { slug, kind, title: `Plan ${slug}`, description: "A test plan.", published: true, itemsTotal: 1 },
        select: { id: true },
      });
      const section = await db.studyPlanSection.create({ data: { planId: plan.id, title: "Section" }, select: { id: true } });
      await db.studyPlanItem.create({ data: { planId: plan.id, sectionId: section.id, problemId: problem.id } });
      if (kind === "SHEET") ids.sheet = plan.id;
      else ids.track = plan.id;
    }
    await db.studyPlanEnrollment.create({ data: { userId: user.id, planId: ids.sheet, itemsTotal: 1 } });

    // Phase 5: a RUNNING contest that pins the SAME frozen version carrying
    // every canary, with this student registered and on the board. The
    // contest queries reach a ProblemVersion, so they are a plausible leak
    // path and must be proved clean rather than assumed.
    const contest = await db.contest.create({
      data: {
        slug: ids.contestSlug,
        title: `Contest ${tag}`,
        rules: "Be quick.",
        kind: "ICPC",
        status: "RUNNING",
        startsAt: new Date(now.getTime() - 30 * 60_000),
        endsAt: new Date(now.getTime() + 90 * 60_000),
        freezeMinutes: 30,
        isRated: false,
        createdById: user.id,
      },
      select: { id: true },
    });
    ids.contest = contest.id;
    const contestProblem = await db.contestProblem.create({
      data: { contestId: contest.id, problemVersionId: ids.live, index: "A", points: 1 },
      select: { id: true },
    });
    ids.contestProblem = contestProblem.id;
    await db.contestRegistration.create({ data: { contestId: contest.id, userId: user.id, kind: "UNRATED" } });
    await db.contestProblemAttempt.create({
      data: { contestId: contest.id, userId: user.id, contestProblemId: contestProblem.id, wrongAttempts: 1 },
    });
    await db.contestStanding.create({
      data: { contestId: contest.id, userId: user.id, score: 0, penalty: 0, solved: 0, rank: 1 },
    });

    // Phase 6b: a live assessment attempt for this student, whose assessment
    // pins the SAME frozen version carrying every canary. The heartbeat
    // returns only a clock today, but it is the route an exam client calls
    // every ten seconds, and this is what fails if anyone ever makes it echo
    // the paper.
    const assessment = await db.assessment.create({
      data: {
        slug: ids.assessmentSlug,
        title: `Exam ${tag}`,
        instructions: "Answer the question.",
        status: "OPEN",
        proctorMode: "ADVISORY",
        opensAt: new Date(now.getTime() - 30 * 60_000),
        closesAt: new Date(now.getTime() + 4 * 60 * 60_000),
        durationSec: 3_600,
        // Room for three sittings: the heartbeat sweep's, the submit sweep's
        // (submitting finalises one), and the one the attempt PAGE starts when
        // the canary sweep renders it.
        maxAttempts: 5,
        createdById: user.id,
      },
      select: { id: true },
    });
    ids.assessment = assessment.id;
    const assessmentProblem = await db.assessmentProblem.create({
      data: { assessmentId: assessment.id, problemVersionId: ids.live, position: 1, points: 1 },
      select: { id: true },
    });
    ids.assessmentProblem = assessmentProblem.id;

    // Phase 7: a PUBLISHED aptitude question whose worked explanation is a
    // canary, and a PUBLISHED pattern whose single section draws on it. The
    // explanation and the answer key are the phase's student-unreachable
    // data, and this is the live half of
    // tests/repo/aptitude-answer-exposure.test.ts: the static fence proves no
    // student-reachable module SELECTS the key, and this one proves nothing a
    // student can actually call hands it back.
    const aptitudeQuestion = await db.aptitudeQuestion.create({
      data: {
        displayCode: `APT-${String(Math.floor(Math.random() * 90_000) + 10_000)}0001`,
        area: "QUANTITATIVE",
        topic: "PERCENTAGES",
        kind: "SINGLE_CHOICE",
        difficulty: "EASY",
        status: "PUBLISHED",
        publishedAt: new Date(now.getTime() - 60_000),
        stem: "What is 10% of 250?",
        options: ["25", "20", "30", "35"],
        correctOptionIndexes: [0],
        explanation: `${C.aptExplain} — ten percent is one tenth, so 250 divided by ten is 25.`,
        expectedSeconds: 45,
        origin: "FACULTY",
        contentHash: createHash("sha256").update(`${tag}-apt`).digest("hex"),
      },
      select: { id: true },
    });
    ids.aptitudeQuestion = aptitudeQuestion.id;
    const aptitudePattern = await db.mockPattern.create({
      data: {
        slug: ids.aptitudePatternSlug,
        name: `Mock ${tag}`,
        funnelLabel: "A canary-sweep funnel",
        sourceNote: "Written for the student-exposure canary sweep, 2026.",
        description: "A pattern the canary sweep sits; it models no company at all.",
      },
      select: { id: true },
    });
    ids.aptitudePattern = aptitudePattern.id;
    const aptitudeSection = await db.aptitudeSection.create({
      data: {
        patternId: aptitudePattern.id,
        position: 1,
        key: "quantitative",
        label: "Quantitative aptitude",
        area: "QUANTITATIVE",
        topicMix: [{ topic: "PERCENTAGES", count: 1 }],
        questionCount: 1,
        timeLimitSec: 600,
        cutoffPercent: 50,
        // Back navigation OFF, so the sweep exercises the restricted path.
        allowBackNavigation: false,
      },
      select: { id: true },
    });
    ids.aptitudeSection = aptitudeSection.id;
    await db.mockPattern.update({ where: { id: aptitudePattern.id }, data: { status: "PUBLISHED" } });

    // A sitting IN PROGRESS for S, so the four mock actions run against a
    // real paper instead of being refused before they read anything. A
    // refusal proves nothing: it never reaches the question. `startMock` is
    // idempotent, so the canary sweep's call RESUMES this one — which also
    // exercises the resume path.
    const mockStartedAt = new Date(now.getTime() - 60_000);
    const mockAttempt = await db.mockAttempt.create({
      data: {
        patternId: aptitudePattern.id,
        userId: user.id,
        attemptNumber: 1,
        seed: 20_261_019,
        startedAt: mockStartedAt,
        expiresAt: new Date(mockStartedAt.getTime() + 600_000),
        currentSectionPosition: 1,
        layout: {
          v: 1,
          sections: [
            {
              sectionId: aptitudeSection.id,
              key: "quantitative",
              position: 1,
              questions: [
                {
                  questionId: aptitudeQuestion.id,
                  index: 0,
                  topic: "PERCENTAGES",
                  optionOrder: [0, 1, 2, 3],
                  passageId: null,
                },
              ],
            },
          ],
        },
      },
      select: { id: true },
    });
    ids.mockAttempt = mockAttempt.id;
    await db.mockSectionState.create({
      data: {
        attemptId: mockAttempt.id,
        sectionId: aptitudeSection.id,
        position: 1,
        startedAt: mockStartedAt,
        endsAt: new Date(mockStartedAt.getTime() + 600_000),
      },
    });

    // A hall, so the invigilator SSE route has a session to be refused for.
    const examSession = await db.examSession.create({
      data: {
        assessmentId: assessment.id,
        label: `${tag}-hall`,
        startsAt: new Date(now.getTime() - 30 * 60_000),
        endsAt: new Date(now.getTime() + 2 * 60 * 60_000),
        createdById: user.id,
      },
      select: { id: true },
    });
    ids.examSession = examSession.id;
    const attempt = await db.assessmentAttempt.create({
      data: {
        assessmentId: assessment.id,
        userId: user.id,
        attemptNumber: 1,
        seed: 1,
        startedAt: new Date(now.getTime() - 10 * 60_000),
        expiresAt: new Date(now.getTime() + 50 * 60_000),
        layout: { order: [1] },
        tokenHash: createHash("sha256").update(ATTEMPT_TOKEN).digest("hex"),
        proctorMode: "ADVISORY",
        status: "IN_PROGRESS",
      },
      select: { id: true },
    });
    ids.attempt = attempt.id;

    // A SECOND sitting, for the submit sweep alone. Submitting finalises an
    // attempt — correctly: a candidate who presses "Submit test" having
    // written nothing has submitted — so the sweep must not be pointed at
    // the attempt the heartbeat sweep needs live.
    const submitAttempt = await db.assessmentAttempt.create({
      data: {
        assessmentId: assessment.id,
        userId: user.id,
        attemptNumber: 2,
        seed: 2,
        startedAt: new Date(now.getTime() - 10 * 60_000),
        expiresAt: new Date(now.getTime() + 50 * 60_000),
        layout: { v: 1, questions: [] },
        tokenHash: createHash("sha256").update(ATTEMPT_TOKEN).digest("hex"),
        proctorMode: "ADVISORY",
        status: "IN_PROGRESS",
      },
      select: { id: true },
    });
    ids.submitAttempt = submitAttempt.id;
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    try {
      const userIds = ids.user ? [ids.user] : [];
      const problemIds = [ids.problem, ids.draftProblem].filter(Boolean);
      const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
      const versionScope = `SELECT "id" FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`;
      const frozen = ["TestCase", "ReferenceSolution", "Hint", "Editorial", "StarterCode", "Subtask", "ProblemLanguageLimit", "ProblemVersion"];
      const xp = await db.xpEvent.count({ where: { userId: { in: userIds } } });
      await db.$transaction([
        // Frozen rows and the XP ledger refuse DELETE by trigger; lifted only inside this transaction.
        ...frozen.map((t) => raw(`ALTER TABLE "public"."${t}" DISABLE TRIGGER "${t}_frozen_guard"`)),
        ...(xp > 0 ? [raw(`ALTER TABLE "public"."XpEvent" DISABLE TRIGGER "XpEvent_append_only"`)] : []),
        raw(`DELETE FROM "public"."XpEvent" WHERE "userId" = ANY($1::text[])`, userIds),
        ...[
          "XpBucket",
          "UserStats",
          "UserBadge",
          "Notification",
          "HintReveal",
          "EditorialView",
          "ProblemActivity",
          "ActivityDay",
          "UserProblemStatus",
          "Bookmark",
          "Note",
          "CodeDraft",
          "StudyPlanEnrollment",
          "UserJudgeUsage",
          "Submission",
          "RunRequest",
          "Session",
          // Phase 8a. `account#requestLeaveException` is exercised as S, so
          // the fixture user owns a leave row by the time this runs — and
          // LeaveException_userId_fkey is RESTRICT, because a student is
          // never hard-deleted in production. Without this line every test
          // in the file passes and the SUITE fails in teardown, which is the
          // failure mode docs/CONVENTIONS.md warns about by name.
          "LeaveException",
        ].map((t) => raw(`DELETE FROM "public"."${t}" WHERE "userId" = ANY($1::text[])`, userIds)),
        // Phase 5 contest fixture. ContestProblem_frozen_version refuses an
        // UPDATE but not a DELETE, so only the contest's own guards come off.
        raw(`ALTER TABLE "public"."Contest" DISABLE TRIGGER "Contest_rating_once"`),
        raw(`DELETE FROM "public"."ContestStanding" WHERE "contestId" = $1`, ids.contest),
        raw(`DELETE FROM "public"."ContestProblemAttempt" WHERE "contestId" = $1`, ids.contest),
        raw(`DELETE FROM "public"."ContestRegistration" WHERE "contestId" = $1`, ids.contest),
        raw(`DELETE FROM "public"."ContestProblem" WHERE "contestId" = $1`, ids.contest),
        raw(`DELETE FROM "public"."Contest" WHERE "id" = $1`, ids.contest),
        raw(`ALTER TABLE "public"."Contest" ENABLE TRIGGER "Contest_rating_once"`),
        // Phase 6b assessment fixture. The attempt refuses DELETE by trigger
        // (it is the record of a sitting), and a published assessment refuses
        // UPDATE, so both guards come off for the delete.
        raw(`ALTER TABLE "public"."AssessmentAttempt" DISABLE TRIGGER "AssessmentAttempt_machine"`),
        // By user, not by id: the attempt page's own sweep starts a further
        // sitting whose id this fixture never learns.
        raw(
          `DELETE FROM "public"."ProctorEvent" WHERE "attemptId" IN (SELECT "id" FROM "public"."AssessmentAttempt" WHERE "userId" = ANY($1::text[]))`,
          userIds,
        ),
        raw(
          `DELETE FROM "public"."AttemptSnapshot" WHERE "attemptId" IN (SELECT "id" FROM "public"."AssessmentAttempt" WHERE "userId" = ANY($1::text[]))`,
          userIds,
        ),
        raw(`DELETE FROM "public"."AssessmentAttempt" WHERE "userId" = ANY($1::text[])`, userIds),
        raw(`ALTER TABLE "public"."AssessmentAttempt" ENABLE TRIGGER "AssessmentAttempt_machine"`),
        raw(`ALTER TABLE "public"."Assessment" DISABLE TRIGGER "Assessment_published_immutable"`),
        raw(`DELETE FROM "public"."AssessmentProblem" WHERE "assessmentId" = $1`, ids.assessment),
        raw(`DELETE FROM "public"."ExamSession" WHERE "id" = $1`, ids.examSession),
        raw(`DELETE FROM "public"."Assessment" WHERE "id" = $1`, ids.assessment),
        raw(`ALTER TABLE "public"."Assessment" ENABLE TRIGGER "Assessment_published_immutable"`),
        // Phase 7 aptitude fixture. A finalised sitting refuses DELETE by
        // trigger (its result and its XP are permanent), a sat pattern
        // refuses edits, and a published question refuses both — so all
        // three guards come off for the teardown and go back on after.
        raw(`ALTER TABLE "public"."MockAttempt" DISABLE TRIGGER "MockAttempt_written_once"`),
        raw(`ALTER TABLE "public"."MockAttemptAnswer" DISABLE TRIGGER "MockAttemptAnswer_closed_section"`),
        raw(`ALTER TABLE "public"."AptitudeSection" DISABLE TRIGGER "AptitudeSection_pattern_frozen"`),
        raw(`ALTER TABLE "public"."MockPattern" DISABLE TRIGGER "MockPattern_scoring_frozen"`),
        raw(`ALTER TABLE "public"."AptitudeQuestion" DISABLE TRIGGER "AptitudeQuestion_published_immutable"`),
        raw(
          `DELETE FROM "public"."MockAttemptAnswer" WHERE "attemptId" IN (SELECT "id" FROM "public"."MockAttempt" WHERE "userId" = ANY($1::text[]))`,
          userIds,
        ),
        raw(
          `DELETE FROM "public"."MockSectionState" WHERE "attemptId" IN (SELECT "id" FROM "public"."MockAttempt" WHERE "userId" = ANY($1::text[]))`,
          userIds,
        ),
        raw(`DELETE FROM "public"."MockAttempt" WHERE "userId" = ANY($1::text[])`, userIds),
        raw(`DELETE FROM "public"."AptitudeUserTopicStat" WHERE "userId" = ANY($1::text[])`, userIds),
        raw(`DELETE FROM "public"."AptitudeQuestionStat" WHERE "questionId" = $1`, ids.aptitudeQuestion),
        // The status comes DOWN before the section goes: deleting the only
        // section of a PUBLISHED pattern drives totalQuestions to zero and
        // `MockPattern_published_has_paper` refuses it — which is the CHECK
        // doing its job, since that write would otherwise turn something a
        // student can open into an empty page.
        raw(`UPDATE "public"."MockPattern" SET "status" = 'DRAFT' WHERE "id" = $1`, ids.aptitudePattern),
        raw(`DELETE FROM "public"."AptitudeSection" WHERE "patternId" = $1`, ids.aptitudePattern),
        raw(`DELETE FROM "public"."MockPattern" WHERE "id" = $1`, ids.aptitudePattern),
        raw(`DELETE FROM "public"."AptitudeQuestion" WHERE "id" = $1`, ids.aptitudeQuestion),
        raw(`ALTER TABLE "public"."AptitudeQuestion" ENABLE TRIGGER "AptitudeQuestion_published_immutable"`),
        raw(`ALTER TABLE "public"."MockPattern" ENABLE TRIGGER "MockPattern_scoring_frozen"`),
        raw(`ALTER TABLE "public"."AptitudeSection" ENABLE TRIGGER "AptitudeSection_pattern_frozen"`),
        raw(`ALTER TABLE "public"."MockAttemptAnswer" ENABLE TRIGGER "MockAttemptAnswer_closed_section"`),
        raw(`ALTER TABLE "public"."MockAttempt" ENABLE TRIGGER "MockAttempt_written_once"`),
        raw(`DELETE FROM "public"."StudyPlan" WHERE "slug" = ANY($1::text[])`, [ids.sheetSlug, ids.trackSlug]),
        raw(`DELETE FROM "public"."ProblemStat" WHERE "problemId" = ANY($1::text[])`, problemIds),
        ...["TestCase", "ReferenceSolution", "Hint", "Editorial", "StarterCode", "Subtask", "ProblemLanguageLimit"].map((t) =>
          raw(`DELETE FROM "public"."${t}" WHERE "problemVersionId" IN (${versionScope})`, problemIds),
        ),
        raw(`UPDATE "public"."Problem" SET "liveVersionId" = NULL WHERE "id" = ANY($1::text[])`, problemIds),
        raw(`DELETE FROM "public"."ProblemVersion" WHERE "problemId" = ANY($1::text[])`, problemIds),
        raw(`DELETE FROM "public"."Problem" WHERE "id" = ANY($1::text[])`, problemIds),
        raw(`DELETE FROM "public"."TestBlob" WHERE "sha256" = ANY($1::text[])`, blobShas),
        raw(`DELETE FROM "public"."User" WHERE "id" = ANY($1::text[])`, userIds),
        ...(xp > 0 ? [raw(`ALTER TABLE "public"."XpEvent" ENABLE TRIGGER "XpEvent_append_only"`)] : []),
        ...frozen.map((t) => raw(`ALTER TABLE "public"."${t}" ENABLE TRIGGER "${t}_frozen_guard"`)),
      ]);
      const disabled = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
        `SELECT "tgname" FROM pg_trigger WHERE NOT "tgisinternal" AND "tgenabled" <> 'O' ORDER BY 1`,
      );
      expect(disabled.map((r) => r.tgname)).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  }, 120_000);

  // ── Routes ─────────────────────────────────────────────────────────────

  const studentRequest = (url: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost");
    headers.set("cookie", "recx_session=student-exposure");
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    return new Request(`http://localhost${url}`, { ...init, headers, body });
  };

  /** The body of a response; an SSE stream is read until it closes, or 2 s. */
  async function bodyOf(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 2_000;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remaining)),
      ]);
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    return text;
  }

  type RouteCall = (handler: (...args: unknown[]) => Promise<Response>) => Promise<{ status: number; body: string }>;
  const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
  const call =
    (request: () => Request, context?: () => object): RouteCall =>
    async (handler) => {
      const response = await handler(request(), context?.());
      return { status: response.status, body: await bodyOf(response) };
    };
  const JUDGE_REFUSED = [401, 426];

  /** `<file under src/app>#<METHOD>` → how S calls it, and what it must answer. */
  const ROUTE_CALLS: Record<string, { call: RouteCall; status?: readonly number[] }> = {
    "api/activity/route.ts#POST": { call: call(() => studentRequest("/api/activity", { method: "POST", json: { problemId: ids.problem, seconds: 30 } })) },
    "api/admin/problems/import/route.ts#POST": {
      call: call(() => studentRequest("/api/admin/problems/import", { method: "POST", headers: { "content-type": "application/zip" }, body: "PK" })),
      status: [403],
    },
    "api/auth/login/route.ts#POST": {
      call: call(() =>
        studentRequest("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `identifier=${encodeURIComponent(tag.toUpperCase())}&password=wrong-password`,
        }),
      ),
    },
    "api/drafts/route.ts#POST": {
      call: call(() =>
        studentRequest("/api/drafts", { method: "POST", json: { problemId: ids.problem, language: "cpp20", source: "// draft\n", clientUpdatedAt: Date.now() } }),
      ),
    },
    "api/exam/[attemptId]/events/route.ts#POST": {
      call: call(
        () =>
          studentRequest(`/api/exam/${ids.attempt}/events`, {
            method: "POST",
            headers: { "x-attempt-token": ATTEMPT_TOKEN },
            json: { events: [{ kind: "COPY", clientSeq: 1, atMs: 0 }] },
          }),
        () => params({ attemptId: ids.attempt }),
      ),
      status: [200],
    },
    "api/exam/[attemptId]/snapshot/route.ts#POST": {
      call: call(
        () =>
          studentRequest(`/api/exam/${ids.attempt}/snapshot`, {
            method: "POST",
            headers: { "x-attempt-token": ATTEMPT_TOKEN },
            json: { questionId: ids.assessmentProblem, language: "cpp20", source: "int main(){}", trigger: "TICK", atMs: 1000 },
          }),
        () => params({ attemptId: ids.attempt }),
      ),
      status: [200],
    },
    "api/admin/invigilate/[sessionId]/live/route.ts#GET": {
      call: call(
        () => studentRequest(`/api/admin/invigilate/${ids.examSession}/live`),
        () => params({ sessionId: ids.examSession }),
      ),
      // A student may not watch an invigilator's hall. The route answers
      // 403 rather than redirecting: an EventSource cannot follow a redirect
      // into a login page.
      status: [403],
    },
    "api/exam/[attemptId]/submit/route.ts#POST": {
      call: call(
        () =>
          studentRequest(`/api/exam/${ids.submitAttempt}/submit`, {
            method: "POST",
            headers: { "x-attempt-token": ATTEMPT_TOKEN },
            // No answers: the canary sweep must not finalise the fixture's
            // sitting, which the heartbeat row above still needs live.
            json: { answers: [] },
          }),
        () => params({ attemptId: ids.submitAttempt }),
      ),
      status: [200],
    },
    "api/exam/device/assert/route.ts#POST": {
      call: call(() =>
        studentRequest("/api/exam/device/assert", { method: "POST", json: { step: "options", slug: ids.assessmentSlug } }),
      ),
      // The fixture's assessment is ADVISORY, so no device is required: 200
      // with { required: false }.
      status: [200],
    },
    "api/exam/device/enrol/route.ts#POST": {
      call: call(() =>
        studentRequest("/api/exam/device/enrol", { method: "POST", json: { step: "options", userId: ids.user } }),
      ),
      // A student may not enrol a device, not even their own.
      status: [403],
    },
    "api/exam/[attemptId]/hb/route.ts#POST": {
      call: call(
        () =>
          studentRequest(`/api/exam/${ids.attempt}/hb`, {
            method: "POST",
            // The in-memory mirror of the attempt token (SPEC §5), which is
            // how the call reaches the authenticated path without a cookie jar.
            headers: { "x-attempt-token": ATTEMPT_TOKEN },
            json: { clientSeq: 0 },
          }),
        () => params({ attemptId: ids.attempt }),
      ),
      status: [200],
    },
    // Phase 7: the section clock. A student's own sitting, so it answers 200
    // — and what it answers is a clock and a status, never a question.
    "api/aptitude/attempts/[attemptId]/clock/route.ts#GET": {
      call: call(
        () => studentRequest(`/api/aptitude/attempts/${ids.mockAttempt}/clock`),
        () => params({ attemptId: ids.mockAttempt }),
      ),
      status: [200],
    },
    // Phase 7d. Both carry the answer key and the worked explanations in one
    // direction or the other, so a student has to be refused before either
    // reads a byte.
    "api/admin/aptitude/import/route.ts#POST": {
      call: call(() =>
        studentRequest("/api/admin/aptitude/import", {
          method: "POST",
          headers: { "content-type": "text/csv", "x-recx-file-name": "probe.csv" },
          body: "type,text,explanation",
        }),
      ),
      status: [403],
    },
    "api/admin/aptitude/export/route.ts#GET": {
      call: call(() => studentRequest("/api/admin/aptitude/export")),
      status: [403],
    },
    "api/judge/blob/[sha256]/route.ts#GET": {
      call: call(() => studentRequest(`/api/judge/blob/${blobShas[2]}`), () => params({ sha256: blobShas[2]! })),
      status: JUDGE_REFUSED,
    },
    "api/judge/claim/route.ts#POST": { call: call(() => studentRequest("/api/judge/claim", { method: "POST", json: { id: ids.submission, kind: "submission" } })), status: JUDGE_REFUSED },
    "api/judge/heartbeat/route.ts#POST": { call: call(() => studentRequest("/api/judge/heartbeat", { method: "POST", json: {} })), status: JUDGE_REFUSED },
    "api/judge/release/route.ts#POST": { call: call(() => studentRequest("/api/judge/release", { method: "POST", json: { id: ids.submission } })), status: JUDGE_REFUSED },
    "api/judge/result/route.ts#POST": { call: call(() => studentRequest("/api/judge/result", { method: "POST", json: { id: ids.submission } })), status: JUDGE_REFUSED },
    "api/runs/[id]/route.ts#GET": { call: call(() => studentRequest(`/api/runs/${ids.run}`), () => params({ id: ids.run })), status: [200] },
    "api/runs/[id]/stream/route.ts#GET": { call: call(() => studentRequest(`/api/runs/${ids.run}/stream`), () => params({ id: ids.run })), status: [200] },
    "api/search/route.ts#GET": { call: call(() => studentRequest(`/api/search?q=${encodeURIComponent(`Exposure ${tag}`)}`)), status: [200] },
    "api/submissions/[id]/route.ts#GET": { call: call(() => studentRequest(`/api/submissions/${ids.submission}`), () => params({ id: ids.submission })), status: [200] },
    "api/submissions/[id]/stream/route.ts#GET": {
      call: call(() => studentRequest(`/api/submissions/${ids.submission}/stream`), () => params({ id: ids.submission })),
      status: [200],
    },
    "super/data/exports/[id]/route.ts#GET": { call: call(() => studentRequest(`/super/data/exports/${ids.submission}`), () => params({ id: ids.submission })), status: [401, 403, 404] },
  };

  it("ROUTE_CALLS covers every exported method of every route.ts", async () => {
    const found: string[] = [];
    for (const rel of routeFiles) {
      const mod = await load(path.join(APP, rel));
      for (const method of HTTP_METHODS) if (typeof mod[method] === "function") found.push(`${rel}#${method}`);
    }
    expect(found.length).toBeGreaterThan(10);
    expect(Object.keys(ROUTE_CALLS).sort()).toEqual(found.sort());
  }, 120_000);

  it("every route, called as S, returns no canary (judge routes refuse, the import route is 403)", async () => {
    const problems: string[] = [];
    for (const [key, spec] of Object.entries(ROUTE_CALLS)) {
      const [rel, method] = key.split("#") as [string, string];
      const mod = await load(path.join(APP, rel));
      const result = await spec.call(mod[method] as (...args: unknown[]) => Promise<Response>);
      const text = record(`route ${key}`, result);
      if (spec.status && !spec.status.includes(result.status)) problems.push(`${key}: status ${result.status}, expected ${spec.status.join(" or ")}`);
      const leaked = leaks(text);
      if (leaked.length > 0) problems.push(`${key}: leaked ${leaked.join(", ")}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("the exam heartbeat canary sweep really reached the authenticated path", async () => {
    // Every heartbeat answers 200, including a refusal (a candidate mid-exam
    // must get a body they can render, not an error status). So `status:
    // [200]` above does NOT prove the sweep got past the attempt guard, and
    // a sweep over a refusal would prove nothing about leaking the paper.
    // This asserts the authenticated path specifically.
    const mod = await load(path.join(APP, "api/exam/[attemptId]/hb/route.ts"));
    const response = await (mod.POST as (...args: unknown[]) => Promise<Response>)(
      studentRequest(`/api/exam/${ids.attempt}/hb`, {
        method: "POST",
        headers: { "x-attempt-token": ATTEMPT_TOKEN },
        json: { clientSeq: 1 },
      }),
      params({ attemptId: ids.attempt }),
    );
    const body = (await response.json()) as { revokeReason: string | null; status: string; msRemaining: number };
    expect(body.revokeReason).toBeNull();
    expect(body.status).toBe("IN_PROGRESS");
    expect(body.msRemaining).toBeGreaterThan(0);
  }, 60_000);

  it("api/judge/* with the protocol header but no node credentials refuses S with 401", async () => {
    const { JUDGE_HEADERS, JUDGE_PROTOCOL_VERSION } = await import("@recx/shared");
    const judgeKeys = Object.keys(ROUTE_CALLS).filter((k) => k.startsWith("api/judge/"));
    expect(judgeKeys.length).toBeGreaterThanOrEqual(5);
    const problems: string[] = [];
    for (const key of judgeKeys) {
      const [rel, method] = key.split("#") as [string, string];
      const mod = await load(path.join(APP, rel));
      const url = `/${rel.replace(/\/route\.ts$/, "").replace("[sha256]", blobShas[2]!)}`;
      const request = studentRequest(url, {
        method,
        headers: { [JUDGE_HEADERS.protocol]: String(JUDGE_PROTOCOL_VERSION), [JUDGE_HEADERS.node]: `${tag}-not-a-node` },
        ...(method === "POST" ? { json: { id: ids.submission, kind: "submission" } } : {}),
      });
      const response = await (mod[method] as (r: Request, c: object) => Promise<Response>)(request, params({ sha256: blobShas[2]! }));
      const text = record(`route ${key} (protocol header)`, { status: response.status, body: await bodyOf(response) });
      if (response.status !== 401) problems.push(`${key}: status ${response.status}, expected 401`);
      if (leaks(text).length > 0) problems.push(`${key}: leaked ${leaks(text).join(", ")}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("the submission routes drop the polluted keys and show the sample", async () => {
    const mod = await load(path.join(APP, "api/submissions/[id]/route.ts"));
    const response = await (mod.GET as (r: Request, c: object) => Promise<Response>)(studentRequest(`/api/submissions/${ids.submission}`), params({ id: ids.submission }));
    const view = (await response.json()) as { tests: Array<Record<string, unknown>> };
    const hidden = view.tests.find((t) => t.i === 1)!;
    expect(Object.keys(hidden).sort()).toEqual(["i", "kb", "ms", "v"]);
    expect(JSON.stringify(view)).toContain(C.sampleIn);
  }, 120_000);

  // ── Queries ────────────────────────────────────────────────────────────

  const QUERIES_DIR = path.join(SRC, "server/queries");
  const queryModules = readdirSync(QUERIES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("admin-") && !f.startsWith("super-"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();

  const viewer = () => ({ id: ids.user, role: "STUDENT" as const });
  /** `<module>#<export>` → a call as S over the fixture. */
  const QUERY_CALLS: Record<string, () => Promise<unknown>> = {
    "announcements#getActiveAnnouncements": async () => (await load(path.join(QUERIES_DIR, "announcements.ts"))).getActiveAnnouncements!,
    "dashboard#getDashboard": async () => (await load(path.join(QUERIES_DIR, "dashboard.ts"))).getDashboard!,
    "calendar#myLeaveRequests": async () => (await load(path.join(QUERIES_DIR, "calendar.ts"))).myLeaveRequests!,
    "judge-languages#getPublicLanguageRows": async () => (await load(path.join(QUERIES_DIR, "judge-languages.ts"))).getPublicLanguageRows!,
    "leaderboard#getLeaderboard": async () => (await load(path.join(QUERIES_DIR, "leaderboard.ts"))).getLeaderboard!,
    "problems#listCatalog": async () => (await load(path.join(QUERIES_DIR, "problems.ts"))).listCatalog!,
    "problems#listCatalogCompanies": async () => (await load(path.join(QUERIES_DIR, "problems.ts"))).listCatalogCompanies!,
    "problems#getProblemWorkspace": async () => (await load(path.join(QUERIES_DIR, "problems.ts"))).getProblemWorkspace!,
    // Phase 7. Every one reads through APTITUDE_PUBLIC_SELECT except the
    // review, which checks `finalizedAt` in its WHERE before it selects.
    "aptitude#topicProgressFor": async () => (await load(path.join(QUERIES_DIR, "aptitude.ts"))).topicProgressFor!,
    "aptitude#patternCardsFor": async () => (await load(path.join(QUERIES_DIR, "aptitude.ts"))).patternCardsFor!,
    "aptitude#patternCoverFor": async () => (await load(path.join(QUERIES_DIR, "aptitude.ts"))).patternCoverFor!,
    "aptitude#nextPracticeQuestion": async () =>
      (await load(path.join(QUERIES_DIR, "aptitude.ts"))).nextPracticeQuestion!,
    "aptitude#practiceCountFor": async () => (await load(path.join(QUERIES_DIR, "aptitude.ts"))).practiceCountFor!,
    "aptitude-sitting#sittingViewFor": async () =>
      (await load(path.join(QUERIES_DIR, "aptitude-sitting.ts"))).sittingViewFor!,
    "aptitude-sitting#sittingReviewFor": async () =>
      (await load(path.join(QUERIES_DIR, "aptitude-sitting.ts"))).sittingReviewFor!,
    "profile#getOwnProfile": async () => (await load(path.join(QUERIES_DIR, "profile.ts"))).getOwnProfile!,
    "profile#findPublicProfile": async () => (await load(path.join(QUERIES_DIR, "profile.ts"))).findPublicProfile!,
    "profile#profileSettingsOf": async () => (await load(path.join(QUERIES_DIR, "profile.ts"))).profileSettingsOf!,
    "submissions#getSubmissionView": async () => (await load(path.join(QUERIES_DIR, "submissions.ts"))).getSubmissionView!,
    "submissions#getSubmissionDetail": async () => (await load(path.join(QUERIES_DIR, "submissions.ts"))).getSubmissionDetail!,
    "submissions#getRunView": async () => (await load(path.join(QUERIES_DIR, "submissions.ts"))).getRunView!,
    "submissions#getStudentView": async () => (await load(path.join(QUERIES_DIR, "submissions.ts"))).getStudentView!,
    "submissions#recentSubmissions": async () => (await load(path.join(QUERIES_DIR, "submissions.ts"))).recentSubmissions!,
    "assessments#listMyAssessments": async () => (await load(path.join(QUERIES_DIR, "assessments.ts"))).listMyAssessments!,
    "sitting-report#getStudentReport": async () => (await load(path.join(QUERIES_DIR, "sitting-report.ts"))).getStudentReport!,
    "exam#getExamPaper": async () => (await load(path.join(QUERIES_DIR, "exam.ts"))).getExamPaper!,
    "contests#listContests": async () => (await load(path.join(QUERIES_DIR, "contests.ts"))).listContests!,
    "contests#getContest": async () => (await load(path.join(QUERIES_DIR, "contests.ts"))).getContest!,
    "contests#getStandings": async () => (await load(path.join(QUERIES_DIR, "contests.ts"))).getStandings!,
    "contests#getRatingSummary": async () => (await load(path.join(QUERIES_DIR, "contests.ts"))).getRatingSummary!,
  };
  /** How each query in QUERY_CALLS is invoked (several calls where the fixture has several targets). */
  const QUERY_ARGS: Record<string, () => unknown[][]> = {
    "announcements#getActiveAnnouncements": () => [[ids.user]],
    "dashboard#getDashboard": () => [[ids.user]],
    "aptitude#topicProgressFor": () => [[ids.user]],
    "aptitude#patternCardsFor": () => [[ids.user]],
    "aptitude#patternCoverFor": () => [[ids.aptitudePatternSlug, ids.user]],
    "aptitude#nextPracticeQuestion": () => [[{ userId: ids.user, topic: "PERCENTAGES" }]],
    "aptitude#practiceCountFor": () => [["PERCENTAGES"]],
    "aptitude-sitting#sittingViewFor": () => [[ids.mockAttempt, ids.user, new Date()]],
    // The sitting is IN_PROGRESS, so the review returns null — which is the
    // point: the key is unreachable until the paper is finalised.
    "aptitude-sitting#sittingReviewFor": () => [[ids.mockAttempt, ids.user]],
    // Phase 8a. The row carries a medical reason in the student's own
    // words. `userId` is a where clause rather than a parameter, so what is
    // swept here is what the caller's OWN row renders; the page that shows
    // it is swept too, in PAGE_CALLS.
    "calendar#myLeaveRequests": () => [[ids.user]],
    "judge-languages#getPublicLanguageRows": () => [[]],
    "leaderboard#getLeaderboard": () => {
      const user = h.state.user!;
      const cohort = { batchYear: 2027, departmentCode: "CSE", section: "A" };
      return [
        [user, boardModel.parseBoardQuery({ scope: "college", period: "all", view: "full" }, cohort)],
        [user, boardModel.parseBoardQuery({ scope: "section", period: "last-week" }, cohort)],
      ];
    },
    "problems#listCatalog": () => [
      [ids.user, { ...catalogFilters.parseCatalogFilters({ q: `Exposure ${tag}` }), companyId: null }],
      [ids.user, { ...catalogFilters.parseCatalogFilters({}), companyId: null }],
    ],
    "problems#listCatalogCompanies": () => [[]],
    "problems#getProblemWorkspace": () => [[ids.slug], [ids.draftSlug]],
    "profile#getOwnProfile": () => [[h.state.user]],
    "profile#findPublicProfile": () => [[ids.handle, ids.user], [ids.handle, null]],
    "profile#profileSettingsOf": () => [[h.state.user]],
    "submissions#getSubmissionView": () => [[ids.submission, viewer()]],
    "submissions#getSubmissionDetail": () => [[ids.submission, ids.slug, viewer()]],
    "submissions#getRunView": () => [[ids.run, viewer()]],
    "submissions#getStudentView": () => [["submission", ids.submission, viewer()], ["run", ids.run, viewer()]],
    "submissions#recentSubmissions": () => [[ids.user, ids.problem]],
    "assessments#listMyAssessments": () => [
      [{ id: ids.user, batchYear: 2027, departmentCode: "CSE", section: null }],
    ],
    // The student's own report on their own sitting. Never a band, never a
    // points total — the fence over the student tree checks for both.
    "sitting-report#getStudentReport": () => [[{ attemptId: ids.attempt, userId: ids.user }]],
    // The paper for the fixture's own attempt, which pins the canary-bearing
    // frozen version: this is the query that would leak a hidden test if the
    // exam surface ever read more of a ProblemVersion than it needs.
    "exam#getExamPaper": () => [
      [{ v: 1, questions: [{ questionId: ids.assessmentProblem, problemVersionId: ids.live, sourcePosition: 1, points: 1, seed: 1 }] }],
    ],
    "contests#listContests": () => [[{ id: ids.user, batchYear: 2027, departmentCode: "CSE" }]],
    "contests#getContest": () => [[ids.contestSlug, { id: ids.user, batchYear: 2027, departmentCode: "CSE" }]],
    "contests#getStandings": () => [
      [ids.contestSlug, { id: ids.user, role: "STUDENT", batchYear: 2027, departmentCode: "CSE" }],
      // Also as staff, which bypasses the freeze and reads the live board.
      [ids.contestSlug, { id: ids.user, role: "ADMIN", batchYear: 2027, departmentCode: "CSE" }],
    ],
    "contests#getRatingSummary": () => [[ids.user]],
  };
  /** Exports that read nothing problem-scoped, with the reason. */
  const NOT_PROBLEM_SCOPED: Record<string, string> = {
    // Phase 7's select vocabulary. Not queries: they are the column lists the
    // queries select THROUGH, and tests/repo/aptitude-answer-exposure.test.ts
    // asserts what each one may and may not name. Keeping them beside the
    // queries they govern is the point — a select constant in lib/ is a
    // select constant nobody looks at when adding a query here.
    "aptitude-select#APTITUDE_PUBLIC_SELECT": "column list: everything needed to ASK a question and nothing needed to answer it",
    "aptitude-select#APTITUDE_ANSWER_SELECT": "column list: the key and the working, for a student who has already answered",
    "aptitude-select#APTITUDE_POOL_SELECT": "column list: the least a seeded draw needs",
    "aptitude-select#APTITUDE_PASSAGE_SELECT": "column list: a passage, which carries no key at all",
    "aptitude-select#APTITUDE_ANSWER_KEY_FIELDS": "constant: the four fields that must never reach a student before they answer",
    "aptitude#topicsByArea": "pure: groups rows this module already returned; no database access",
    "aptitude-select#APTITUDE_IDENTITY_SELECT": "column list: just enough to recognise a question an import might be about",
    "calendar#dayToDate": "pure: a campus day as the UTC-midnight Date a @db.Date column holds",
    "calendar#MY_LEAVE_LIMIT": "constant",
    "judge-languages#LANGUAGE_CONFIG_TAG": "cache tag constant",
    "judge-languages#revalidateLanguageConfigs": "cache invalidation; returns nothing",
    "leaderboard#FULL_BOARD_CAP": "constant",
    "leaderboard#bucketScopeSql": "pure SQL builder over XpBucket; executed through getLeaderboard (called)",
    "leaderboard#standingSql": "pure SQL builder over XpBucket; executed through getLeaderboard (called)",
    "leaderboard#topRowsSql": "pure SQL builder over XpBucket; executed through getLeaderboard (called)",
    "leaderboard#aheadRowsSql": "pure SQL builder over XpBucket; executed through getLeaderboard (called)",
    "leaderboard#behindRowsSql": "pure SQL builder over XpBucket; executed through getLeaderboard (called)",
    "leaderboard#peerProfileHref": "pure link builder",
    "leaderboard#snapshotTopSchema": "zod schema",
    "leaderboard#isHidden": "pure predicate on a user row",
    "leaderboard#boardPeriodKey": "pure period-key builder",
    "profile#MIN_COHORT_FOR_MEDIAN": "constant",
    "profile#TIME_TO_SOLVE_LIMIT": "constant",
    "profile#topicCounts": "pure transform of UserStats JSON",
    "profile#languageLabel": "pure label lookup",
    "profile#languageShares": "pure transform of UserStats JSON",
    "profile#cohortMedianSql": "pure SQL builder; executed through getOwnProfile (called)",
    "submissions#HISTORY_LIMIT": "constant",
    "contests#elapsedMinutes": "pure arithmetic on a window and a clock",
  };

  it("QUERY_CALLS and NOT_PROBLEM_SCOPED cover every export of the student query modules", async () => {
    expect(queryModules).toEqual(expect.arrayContaining(["problems", "submissions", "profile", "dashboard"]));
    const exported: string[] = [];
    for (const name of queryModules) {
      const mod = await load(path.join(QUERIES_DIR, `${name}.ts`));
      for (const key of Object.keys(mod)) exported.push(`${name}#${key}`);
    }
    const listed = [...Object.keys(QUERY_CALLS), ...Object.keys(NOT_PROBLEM_SCOPED)];
    expect(new Set(listed).size, "an export is listed twice").toBe(listed.length);
    expect(listed.sort()).toEqual(exported.sort());
    expect(Object.keys(QUERY_ARGS).sort()).toEqual(Object.keys(QUERY_CALLS).sort());
  }, 120_000);

  it("every student query, called as S, returns no canary; the workspace carries the sample", async () => {
    const problems: string[] = [];
    let workspace = "";
    for (const [key, get] of Object.entries(QUERY_CALLS)) {
      const fn = (await get()) as (...args: unknown[]) => Promise<unknown>;
      for (const args of QUERY_ARGS[key]!()) {
        const text = record(`query ${key}`, await fn(...args));
        if (key === "problems#getProblemWorkspace" && args[0] === ids.slug) workspace = text;
        const leaked = leaks(text);
        if (leaked.length > 0) problems.push(`${key}(${JSON.stringify(args).slice(0, 80)}): leaked ${leaked.join(", ")}`);
      }
    }
    expect(problems).toEqual([]);
    expect(workspace, "positive control: the workspace query returns the sample input").toContain(C.sampleIn);
  }, 120_000);

  it("the stored polluted keys never reach the submission or run view", async () => {
    const q = await load(path.join(QUERIES_DIR, "submissions.ts"));
    const sub = (await (q.getSubmissionView as (id: string, v: object) => Promise<{ tests: Array<Record<string, unknown>> }>)(ids.submission, viewer()))!;
    expect(Object.keys(sub.tests.find((t) => t.i === 1)!).sort()).toEqual(["i", "kb", "ms", "v"]);
    const run = (await (q.getRunView as (id: string, v: object) => Promise<{ tests: Array<Record<string, unknown>> }>)(ids.run, viewer()))!;
    expect(Object.keys(run.tests.find((t) => t.i === 1)!).sort()).toEqual(["i", "kb", "ms", "v"]);
    expect(JSON.stringify(sub)).toContain(C.sampleIn);
  }, 120_000);

  // ── Pages ──────────────────────────────────────────────────────────────

  /** `<file under src/app>` → its params and searchParams. */
  const PAGE_CALLS: Record<string, () => { params?: Record<string, string>; searchParams?: Record<string, string> }> = {
    "(public)/judge/page.tsx": () => ({}),
    "(public)/layout.tsx": () => ({}),
    "(student)/accessibility/page.tsx": () => ({}),
    "(student)/bookmarks/page.tsx": () => ({}),
    "(student)/dashboard/loading.tsx": () => ({}),
    "(exam)/layout.tsx": () => ({}),
    "(exam)/assessments/[slug]/readiness/page.tsx": () => ({ params: { slug: ids.assessmentSlug }, searchParams: {} }),
    // The single most important leak surface in Phase 6: it renders the
    // candidate's whole paper from a frozen ProblemVersion that carries a
    // canary in every hidden test, checker and reference solution. It starts
    // a sitting as a side effect, which the mocked cookie jar absorbs.
    "(exam)/assessments/[slug]/attempt/page.tsx": () => ({ params: { slug: ids.assessmentSlug } }),
    // Phase 7e. The sitting page is the one that renders a whole paper, and
    // the review is the only student page that may show an answer key — so
    // both are swept, and the sitting's canary is the worked explanation.
    // Phase 8a. Renders the caller's own leave reasons, which is exactly
    // the kind of text that must not be somebody else's.
    "(student)/account/leave/page.tsx": () => ({}),
    "(student)/aptitude/page.tsx": () => ({}),
    "(student)/aptitude/[topic]/page.tsx": () => ({ params: { topic: "percentages" } }),
    "(student)/aptitude/mock/[slug]/page.tsx": () => ({ params: { slug: ids.aptitudePatternSlug } }),
    "(student)/aptitude/mock/attempt/[attemptId]/page.tsx": () => ({ params: { attemptId: ids.mockAttempt } }),
    "(student)/aptitude/mock/attempt/[attemptId]/review/page.tsx": () => ({
      params: { attemptId: ids.mockAttempt },
    }),
    "(student)/assessments/page.tsx": () => ({}),
    "(student)/sittings/[attemptId]/page.tsx": () => ({ params: { attemptId: ids.attempt } }),
    "(student)/contests/page.tsx": () => ({}),
    "(student)/contests/[slug]/page.tsx": () => ({ params: { slug: ids.contestSlug } }),
    "(student)/contests/[slug]/analysis/page.tsx": () => ({ params: { slug: ids.contestSlug } }),
    "(student)/contests/[slug]/arena/layout.tsx": () => ({}),
    "(student)/contests/[slug]/arena/page.tsx": () => ({ params: { slug: ids.contestSlug }, searchParams: { p: "A" } }),
    "(student)/contests/[slug]/standings/page.tsx": () => ({ params: { slug: ids.contestSlug } }),
    "(student)/dashboard/page.tsx": () => ({}),
    "(student)/help/page.tsx": () => ({}),
    "(student)/layout.tsx": () => ({}),
    "(student)/leaderboard/loading.tsx": () => ({}),
    "(student)/leaderboard/page.tsx": () => ({ searchParams: { scope: "college", period: "all" } }),
    "(student)/learn/[slug]/page.tsx": () => ({ params: { slug: ids.trackSlug } }),
    "(student)/learn/page.tsx": () => ({}),
    "(student)/notes/[id]/edit/page.tsx": () => ({ params: { id: ids.note } }),
    "(student)/notes/[id]/page.tsx": () => ({ params: { id: ids.note } }),
    "(student)/notes/new/page.tsx": () => ({ searchParams: { problem: ids.slug } }),
    "(student)/notes/page.tsx": () => ({ searchParams: { problem: ids.slug } }),
    "(student)/notifications/page.tsx": () => ({}),
    "(student)/problems/[slug]/not-found.tsx": () => ({}),
    "(student)/problems/[slug]/page.tsx": () => ({ params: { slug: ids.slug } }),
    "(student)/problems/[slug]/submissions/[id]/not-found.tsx": () => ({}),
    "(student)/problems/[slug]/submissions/[id]/page.tsx": () => ({ params: { slug: ids.slug, id: ids.submission } }),
    "(student)/problems/page.tsx": () => ({ searchParams: { q: `Exposure ${tag}` } }),
    "(student)/profile/loading.tsx": () => ({}),
    "(student)/profile/page.tsx": () => ({}),
    "(student)/profile/settings/loading.tsx": () => ({}),
    "(student)/profile/settings/page.tsx": () => ({}),
    "(student)/sheets/[slug]/page.tsx": () => ({ params: { slug: ids.sheetSlug } }),
    "(student)/sheets/page.tsx": () => ({}),
    "layout.tsx": () => ({}),
    "not-found.tsx": () => ({}),
    "offline/page.tsx": () => ({}),
    "page.tsx": () => ({}),
    "u/[handle]/not-found.tsx": () => ({}),
    "u/[handle]/page.tsx": () => ({ params: { handle: ids.handle } }),
    "u/layout.tsx": () => ({}),
  };
  /** Extra renders of a page for other fixture targets (draft problem, other slugs). */
  const EXTRA_PAGE_CALLS: Array<[string, () => { params?: Record<string, string>; searchParams?: Record<string, string> }]> = [
    ["(student)/problems/[slug]/page.tsx", () => ({ params: { slug: ids.draftSlug } })],
    ["(student)/problems/page.tsx", () => ({ searchParams: {} })],
    ["(student)/notes/page.tsx", () => ({ searchParams: {} })],
  ];
  /** Entries not rendered here, with the reason (the static fence still covers them). */
  const PAGE_SKIPS: Record<string, string> = {
    "(student)/learn/error.tsx": "client error boundary (hooks); renders only the error prop",
    "(student)/problems/error.tsx": "client error boundary (hooks); renders only the error prop",
    "(student)/sheets/error.tsx": "client error boundary (hooks); renders only the error prop",
    "error.tsx": "client error boundary (hooks); renders only the error prop",
    "global-error.tsx": "client error boundary (hooks); renders only the error prop",
  };
  /** Pages that must render (no redirect or not-found) for S. */
  const MUST_RENDER = [
    "(student)/problems/[slug]/page.tsx",
    "(student)/problems/[slug]/submissions/[id]/page.tsx",
    "(student)/bookmarks/page.tsx",
    "(student)/dashboard/page.tsx",
    "(student)/notes/[id]/page.tsx",
    "(student)/profile/page.tsx",
    "(student)/sheets/[slug]/page.tsx",
    "(student)/learn/[slug]/page.tsx",
    "u/[handle]/page.tsx",
  ];

  it("PAGE_CALLS and PAGE_SKIPS cover every student page, layout and boundary", () => {
    expect(studentEntries.length).toBeGreaterThan(20);
    const listed = [...Object.keys(PAGE_CALLS), ...Object.keys(PAGE_SKIPS)];
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual([...studentEntries].sort());
    for (const skipped of Object.keys(PAGE_SKIPS)) expect(isClientModule(skipped), `${skipped} is skipped as a client boundary`).toBe(true);
  });

  async function renderEntry(rel: string, input: { params?: Record<string, string>; searchParams?: Record<string, string> }) {
    const mod = await load(path.join(APP, rel));
    const props = {
      params: Promise.resolve(input.params ?? {}),
      searchParams: Promise.resolve(input.searchParams ?? {}),
      children: null,
    };
    const thrown: string[] = [];
    let outcome = "rendered";
    let strings: string[] = [];
    try {
      const tree = await (mod.default as (p: object) => unknown)(props);
      strings = await collectStrings(tree, { onThrow: (name, error) => thrown.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) });
    } catch (error) {
      if (error instanceof h.RedirectSentinel) outcome = `redirect ${error.url}`;
      else if (error instanceof h.NotFoundSentinel) outcome = "not-found";
      else throw error;
    }
    if (typeof mod.generateMetadata === "function") {
      try {
        strings.push(JSON.stringify(await (mod.generateMetadata as (p: object) => Promise<unknown>)(props)));
      } catch (error) {
        if (!(error instanceof h.RedirectSentinel) && !(error instanceof h.NotFoundSentinel)) throw error;
      }
    }
    return { outcome, strings, thrown };
  }

  it("every student page and layout, rendered as S, carries no canary; the workspace carries the sample", async () => {
    const problems: string[] = [];
    const outcomes: Record<string, string> = {};
    let workspace = "";
    const calls: Array<[string, () => { params?: Record<string, string>; searchParams?: Record<string, string> }]> = [
      ...Object.entries(PAGE_CALLS),
      ...EXTRA_PAGE_CALLS,
    ];
    for (const [rel, input] of calls) {
      const args = input();
      const { outcome, strings, thrown } = await renderEntry(rel, args);
      const text = record(`page ${rel} ${JSON.stringify(args)}`, strings);
      outcomes[`${rel} ${JSON.stringify(args)}`] = outcome;
      if (rel === "(student)/problems/[slug]/page.tsx" && args.params?.slug === ids.slug) workspace = text;
      for (const t of thrown) problems.push(`${rel}: async component threw ${t}`);
      const leaked = leaks(text);
      if (leaked.length > 0) problems.push(`${rel}: leaked ${leaked.join(", ")}`);
    }
    expect(problems).toEqual([]);
    for (const rel of MUST_RENDER) {
      const key = Object.keys(outcomes).find((k) => k.startsWith(`${rel} `) && !k.includes(ids.draftSlug))!;
      expect(outcomes[key], rel).toBe("rendered");
    }
    expect(outcomes[`page.tsx {}`]).toBe("redirect /dashboard");
    expect(Object.entries(outcomes).find(([k]) => k.includes(ids.draftSlug))?.[1]).toBe("not-found");
    expect(workspace, "positive control: the workspace page renders the sample input").toContain(C.sampleIn);
  }, 120_000);

  // ── Server actions ─────────────────────────────────────────────────────

  const ACTIONS_DIR = path.join(SRC, "server/actions");
  const form = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };
  /** `<module>#<export>` → fixture calls as S, in order (later calls may use earlier results). */
  const SELF_SERVICE_CALLS: Record<string, Array<() => unknown[]>> = {
    "auth#logout": [() => []],
    // A student appealing their own decision. The fixture flag does not
    // exist, so the action refuses with "not found" — which is the right
    // answer and still exercises the path as S.
    "appeals#submitAppeal": [
      () => [{ flagId: `${tag}-no-such-flag`, reason: "I wrote this myself and the timeline shows it." }],
    ],
    // Phase 8a. Raising a leave for yourself, and calling it off. The
    // cancel fixture names an id that is not the caller's, so the
    // "not one of yours" path is the one exercised as S.
    "account#requestLeaveException": [
      () => [
        {
          kind: "MEDICAL",
          startDate: "2026-10-01",
          endDate: "2026-10-03",
          reason: "Admitted with dengue; discharge summary with the health centre.",
        },
      ],
    ],
    "account#cancelLeaveException": [() => [{ leaveId: `${tag}-no-such-leave` }]],
    "bookmarks#toggleBookmark": [() => [{ problemId: ids.problem, bookmarked: false }], () => [{ problemId: ids.problem, bookmarked: true }]],
    "drafts#saveDraft": [() => [{ problemId: ids.problem, language: "py312", source: "print(input())\n", clientUpdatedAt: Date.now() }]],
    "help#revealHint": [() => [{ problemId: ids.problem, tier: 1 }], () => [{ problemId: ids.draftProblem, tier: 1 }]],
    "help#viewEditorial": [() => [{ problemId: ids.problem }], () => [{ problemId: ids.draftProblem }]],
    "judge#runCode": [
      () => [{ slug: ids.slug, language: "py312", source: "print(input())\n", customInput: null }],
      () => [{ slug: ids.draftSlug, language: "py312", source: "print(input())\n", customInput: null }],
    ],
    "judge#submitSolution": [
      () => [{ slug: ids.slug, language: "py312", source: "print(input())\n" }],
      () => [{ slug: ids.draftSlug, language: "py312", source: "print(input())\n" }],
    ],
    // Phase 5: a student registers themselves for a contest, and starts
    // their own virtual run. Both are self-service, so both are called as S
    // and must leak no canary. The contest fixture is RUNNING, so
    // registering succeeds; a virtual run of a running contest is refused by
    // the action's own rule, which is still a non-Forbidden answer and so
    // still has to be canary-clean.
    "contests#registerForContest": [() => [{ slug: ids.contestSlug }]],
    "contests#startVirtualContest": [() => [{ slug: ids.contestSlug }]],
    "notes#createNote": [() => [{ title: `Second ${tag}`, contentMd: "Another note.", problemId: ids.problem }]],
    "notes#updateNote": [() => [{ id: ids.note, title: `Note ${tag}`, contentMd: "Edited.", problemId: ids.problem }]],
    "notes#previewNote": [() => [{ contentMd: "# Preview" }]],
    "notes#deleteNote": [() => [{ id: createdNoteIds[0] ?? "missing" }]],
    "notifications#markNotificationRead": [() => [{ id: "missing-notification" }]],
    "notifications#markAllNotificationsRead": [() => []],
    "plans#enrollInPlan": [() => [{ planId: ids.track }]],
    "plans#leavePlan": [() => [{ planId: ids.track }]],
    "plans#changeEnrollment": [() => [null, form({ planId: ids.track, intent: "enroll" })]],
    /**
     * Phase 7: a student practising aptitude and sitting a mock. All seven
     * are self-service, so all seven are called AS S and every answer has to
     * be canary-clean — which for this phase means it must not carry the
     * worked explanation or the answer key.
     *
     * `startMock` really starts a sitting (the pattern is PUBLISHED and its
     * one section draws on the one published question), so `serveMockQuestion`
     * and `saveMockAnswer` run against a real paper rather than being refused
     * before they read anything. A refusal proves nothing here: it never
     * reaches the question.
     */
    "aptitude#startMock": [() => [{ slug: ids.aptitudePatternSlug }]],
    "aptitude#serveMockQuestion": [() => [{ attemptId: ids.mockAttempt, index: 0 }]],
    "aptitude#saveMockAnswer": [
      () => [
        {
          attemptId: ids.mockAttempt,
          questionId: ids.aptitudeQuestion,
          shownIndexes: [0],
          numericValue: null,
          markedForReview: false,
        },
      ],
    ],
    // One section, so advancing is refused for having nowhere to go — still a
    // non-Forbidden answer, and still has to be canary-clean.
    "aptitude#advanceMockSection": [() => [{ attemptId: ids.mockAttempt }]],
    // Finalising returns the student's own result. The explanation is NOT
    // part of it: the review page is the only student path that may select
    // the key, and only once finalizedAt is set.
    "aptitude#finaliseMockAttempt": [() => [{ attemptId: ids.mockAttempt }]],
    // Topic practice commits an answer and THEN returns the working, so this
    // one legitimately carries the explanation. It is the single exception,
    // and it is asserted as a POSITIVE control below rather than exempted.
    "aptitude#answerPractice": [
      () => [
        {
          questionId: ids.aptitudeQuestion,
          selectedIndexes: [0],
          numericValue: null,
          seenAtMs: 0,
          answeredAtMs: 2_000,
        },
      ],
    ],
    "aptitude#recordPracticeQuestionServed": [() => [{ questionId: ids.aptitudeQuestion }]],
    "profile#saveProfileSettings": [
      () => [null, form({ handle: ids.handle, visibility: "PUBLIC", bio: "", fontSize: "14", tabSize: "4", keymap: "default" })],
    ],
  };
  const READ_ONLY_UNWRAPPED = new Set(["super-impersonate#endImpersonation"]);

  it("every server-action export, called as S: self-service ones leak no canary, every other one is Forbidden", async () => {
    const { ForbiddenError } = await import("@/lib/errors");
    const FORBIDDEN = new ForbiddenError().message;
    const modules = readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts")).sort();
    const problems: string[] = [];
    const called = new Set<string>();
    for (const file of modules) {
      const name = file.replace(/\.ts$/, "");
      const mod = await load(path.join(ACTIONS_DIR, file));
      for (const [exportName, fn] of Object.entries(mod)) {
        const key = `${name}#${exportName}`;
        if (typeof fn !== "function") {
          problems.push(`${key}: not a function`);
          continue;
        }
        const action = fn as (...args: unknown[]) => Promise<unknown>;
        const fixtures = SELF_SERVICE_CALLS[key];
        if (fixtures) {
          called.add(key);
          for (const args of fixtures) {
            let result: unknown;
            try {
              result = await action(...args());
            } catch (error) {
              if (error instanceof h.RedirectSentinel) result = { redirect: error.url };
              else throw error;
            }
            const text = record(`action ${key}`, result);
            if (key === "notes#createNote") {
              const created = result as { ok: boolean; data?: { id: string } };
              if (created.ok && created.data) createdNoteIds.push(created.data.id);
            }
            const leaked = leaks(text).filter(
              (secret) => !(secret === C.aptExplain && `action ${key}` === EXPLANATION_CARRIER),
            );
            if (leaked.length > 0) problems.push(`${key}: leaked ${leaked.join(", ")}`);
            if (`action ${key}` === EXPLANATION_CARRIER && !text.includes(C.aptExplain)) {
              problems.push(
                `${key}: positive control — a committed practice answer must return the worked explanation, which is the point of the phase`,
              );
            }
          }
          continue;
        }
        // Not self-service: S must be refused before anything runs.
        let result: unknown;
        try {
          result = await action({}, new FormData());
        } catch (error) {
          if (READ_ONLY_UNWRAPPED.has(key) && error instanceof ForbiddenError) continue;
          problems.push(`${key}: threw ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        record(`action ${key}`, result);
        const r = result as { ok?: boolean; error?: string };
        if (r?.ok !== false || r.error !== FORBIDDEN) {
          problems.push(`${key}: S was not refused with Forbidden (got ${JSON.stringify(result).slice(0, 120)}); add it to SELF_SERVICE_CALLS if students may call it`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect([...called].sort()).toEqual(Object.keys(SELF_SERVICE_CALLS).sort());
    // The actions really ran against the fixture.
    expect(h.enqueued.some((e) => e.kind === "submission")).toBe(true);
    expect(h.enqueued.some((e) => e.kind === "run")).toBe(true);
  }, 120_000);

  it("detector control: the staff path does return the canaries, and refuses S", async () => {
    const admin = await load(path.join(QUERIES_DIR, "admin-problems.ts"));
    const getAdminProblem = admin.getAdminProblem as (v: object, id: string, rev: number | null) => Promise<unknown>;
    const getDraftTests = admin.getDraftTests as (v: object, id: string, rev: number | null) => Promise<unknown>;
    const staff = { id: ids.user, role: "ADMIN" };
    const seen = leaks(JSON.stringify([await getAdminProblem(staff, ids.problem, 1), await getDraftTests(staff, ids.problem, 1), await getAdminProblem(staff, ids.problem, 2)]));
    expect(seen).toEqual(expect.arrayContaining([C.refSrc, C.hiddenIn, C.hiddenOut, C.draftStmt]));
    await expect(getAdminProblem(viewer(), ids.problem, 1)).rejects.toThrow();
    await expect(getDraftTests(viewer(), ids.problem, 1)).rejects.toThrow();
  }, 120_000);

  it("no output collected anywhere carries a secret canary", () => {
    expect(outputs.length).toBeGreaterThan(80);
    const leaked = outputs.flatMap((o) =>
      leaks(o.text)
        .filter((secret) => !(secret === C.aptExplain && o.where === EXPLANATION_CARRIER))
        .map((s) => `${o.where}: ${s}`),
    );
    expect(leaked).toEqual([]);
    // The carrier really ran, so the exclusion above is not excusing silence.
    expect(
      outputs.some((o) => o.where === EXPLANATION_CARRIER && o.text.includes(C.aptExplain)),
      "positive control: the practice action returned the worked explanation",
    ).toBe(true);
  });

  it("canary self-check: the fixture really holds every secret where only staff and judges may read it", async () => {
    const refs = await db.referenceSolution.findMany({ where: { problemVersionId: ids.live }, select: { source: true } });
    expect(refs.filter((r) => r.source.includes(C.refSrc))).toHaveLength(2);
    const blobs = await db.testBlob.findMany({ where: { sha256: { in: blobShas } }, select: { inline: true, storageKey: true } });
    const inline = blobs.map((b) => b.inline ?? "").join("\n");
    for (const s of [C.hiddenIn, C.hiddenOut, C.checkerSrc]) expect(inline).toContain(s);
    const stored = blobs.find((b) => b.storageKey);
    expect((await h.store.get(stored!.storageKey!)).toString("utf8")).toContain(C.hiddenBig);
    const draft = await db.problemVersion.findUniqueOrThrow({ where: { id: ids.draft }, select: { statementMd: true, frozenAt: true } });
    expect(draft.statementMd).toContain(C.draftStmt);
    expect(draft.frozenAt).toBeNull();
    const live = await db.problemVersion.findUniqueOrThrow({ where: { id: ids.live }, select: { frozenAt: true, compareMode: true } });
    expect(live.frozenAt).not.toBeNull();
    expect(live.compareMode).toBe("CHECKER");
  }, 120_000);
});
