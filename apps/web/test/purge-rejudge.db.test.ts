import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A submission purge keeps the verdict rows forever; a rejudge must never
 * overwrite them (it would compile the empty, archived source). Against a
 * real Postgres (recx_test): the purge archives one student's non-accepted
 * PRACTICE sources, the global rejudge then resets only the submission that
 * still has its code, the request count agrees, and a single rejudge of a
 * purged submission is refused. Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

const state = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  return { user: null as unknown };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user, destroyAllSessions: async () => undefined }));
vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined, auditMany: async () => undefined }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: async () => false }));

type M = {
  db: (typeof import("@/lib/db"))["db"];
  purge: typeof import("@/lib/privileged/executors/submission-purge");
  rejudge: typeof import("@/lib/privileged/executors/global-rejudge");
  adminJudge: typeof import("@/server/actions/admin-judge");
};

describe.skipIf(!ENABLED)("purge then rejudge (recx_test)", () => {
  const tag = `pr-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: M;
  const ids = { user: "", admin: "", problem: "", version: "", config: "", purged: "", kept: "" };

  beforeAll(async () => {
    m = {
      db: (await import("@/lib/db")).db,
      purge: await import("@/lib/privileged/executors/submission-purge"),
      rejudge: await import("@/lib/privileged/executors/global-rejudge"),
      adminJudge: await import("@/server/actions/admin-judge"),
    };
    const { db } = m;
    const { LANGUAGE_CATALOG } = await import("@recx/shared");
    const rt = LANGUAGE_CATALOG.cpp20;
    const fields = { label: rt.label, version: rt.version, runtime: JSON.parse(JSON.stringify(rt)), enabled: true, isCurrent: true };
    ids.config = (
      await db.languageConfig.upsert({
        where: { key_toolchainId: { key: "cpp20", toolchainId: rt.toolchainId } },
        create: { key: "cpp20", toolchainId: rt.toolchainId, ...fields },
        update: fields,
        select: { id: true },
      })
    ).id;
    const mk = (key: string, role: "STUDENT" | "SUPER_ADMIN") =>
      db.user.create({
        data: { collegeId: `${tag}-${key}`.toUpperCase(), email: `${tag}-${key}@example.test`, handle: `${tag}-${key}`, firstName: key, lastName: "PR", role },
        select: { id: true },
      });
    ids.user = (await mk("stu", "STUDENT")).id;
    ids.admin = (await mk("sup", "SUPER_ADMIN")).id;
    ids.problem = (
      await db.problem.create({
        data: { slug: tag, displayCode: tag.toUpperCase(), title: `Purge ${tag}`, difficulty: "EASY" },
        select: { id: true },
      })
    ).id;
    ids.version = (
      await db.problemVersion.create({
        data: { problemId: ids.problem, revision: 1, title: `Purge ${tag}`, difficulty: "EASY", statementMd: "x", ioMode: "STDIN", timeLimitMs: 1000 },
        select: { id: true },
      })
    ).id;
    const submission = (verdict: "WA" | "AC") =>
      db.submission.create({
        data: {
          userId: ids.user,
          problemId: ids.problem,
          problemVersionId: ids.version,
          languageConfigId: ids.config,
          language: "cpp20",
          status: "DONE",
          judgeState: "DONE",
          verdict,
          passedCases: 1,
          totalCases: 2,
          sourceSha256: "2".repeat(64),
          sourceBytes: 24,
          judgedAt: new Date(),
          queuedAt: new Date(Date.now() - 60_000),
          source: { create: { source: "int main() { return 0; }\n" } },
        },
        select: { id: true },
      });
    ids.purged = (await submission("WA")).id;
    ids.kept = (await submission("AC")).id;
  });

  afterAll(async () => {
    if (!m) return;
    try {
      const subs = [ids.purged, ids.kept].filter(Boolean);
      await m.db.submissionTestDetail.deleteMany({ where: { submissionId: { in: subs } } });
      await m.db.submissionSource.deleteMany({ where: { submissionId: { in: subs } } });
      await m.db.submission.deleteMany({ where: { id: { in: subs } } });
      if (ids.version) await m.db.problemVersion.deleteMany({ where: { id: ids.version } });
      if (ids.problem) await m.db.problem.deleteMany({ where: { id: ids.problem } });
      await m.db.session.deleteMany({ where: { userId: { in: [ids.user, ids.admin] } } });
      await m.db.user.deleteMany({ where: { id: { in: [ids.user, ids.admin].filter(Boolean) } } });
    } finally {
      await m.db.$disconnect();
    }
  });

  it("the purge archives the non-accepted source and keeps the verdict", async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const out = await m.purge.executeSubmissionPurge(
      { id: `${tag}-op1`, payload: { userId: ids.user, before: tomorrow, includeAccepted: false }, requestedById: ids.admin, decidedAt: new Date() },
      { id: ids.admin, ipHash: null },
    );
    expect(out.result).toMatchObject({ sources: 1 });
    const purged = await m.db.submission.findUniqueOrThrow({ where: { id: ids.purged }, include: { source: true } });
    expect(purged).toMatchObject({ status: "DONE", verdict: "WA" });
    expect(purged.source).toMatchObject({ source: "" });
    expect(purged.source?.archivedAt).not.toBeNull();
  });

  it("a global rejudge skips the purged submission and resets the one that kept its code", async () => {
    const out = await m.rejudge.executeGlobalRejudge(
      {
        id: `${tag}-op2`,
        payload: { problemId: ids.problem, problemVersionId: null, languages: [], verdicts: [] },
        requestedById: ids.admin,
        decidedAt: new Date(),
      },
      { id: ids.admin, ipHash: null },
    );
    expect(out.result).toMatchObject({ reset: 1 });
    expect(await m.db.submission.findUniqueOrThrow({ where: { id: ids.purged } })).toMatchObject({ status: "DONE", verdict: "WA" });
    expect(await m.db.submission.findUniqueOrThrow({ where: { id: ids.kept } })).toMatchObject({ status: "QUEUED", verdict: null });
  });

  it("a single rejudge of a purged submission is refused, and its verdict stays", async () => {
    state.user = { id: ids.admin, role: "SUPER_ADMIN", status: "ACTIVE" };
    const result = await m.adminJudge.rejudgeSubmission({ submissionId: ids.purged });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/purged/);
    expect(await m.db.submission.findUniqueOrThrow({ where: { id: ids.purged } })).toMatchObject({ status: "DONE", verdict: "WA" });
  });
});
