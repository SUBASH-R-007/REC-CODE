import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Authoring an assessment against the real tables (Phase 12a).
 *
 * The sitting engine has existed since Phase 6 and nothing could create the
 * thing it runs; these are the actions that now can. What they are tested
 * for is mostly what they REFUSE, because an assessment is the one surface
 * where a mistake lands on a cohort at once:
 *
 *   * an unproctored assessment cannot be made at all — not through the
 *     action, not through the database;
 *   * a placement-bearing one must be lab-supervised;
 *   * publishing is refused on an empty paper, and on a lab assessment with
 *     no hall to enforce it;
 *   * once published, the terms are the database's to protect, and this
 *     file checks it still does.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "admin-assessments-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

let actorId = "";
vi.mock("@/lib/auth/guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guards")>();
  return { ...actual, requireActionRole: async () => ({ id: actorId, role: "SUPER_ADMIN" as const }) };
});

describe.skipIf(!ENABLED)("authoring an assessment against recx_test", () => {
  const tag = `asmt-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let actions: typeof import("@/server/actions/admin-assessments");
  const slugs: string[] = [];
  let publishedProblemSlug = "";

  const OPENS = new Date(Date.now() + 3_600_000).toISOString().slice(0, 16);
  const CLOSES = new Date(Date.now() + 7_200_000).toISOString().slice(0, 16);

  const base = (over: Record<string, unknown> = {}) => {
    const slug = `${tag}-${slugs.length}`;
    slugs.push(slug);
    return {
      slug,
      title: `Assessment ${slug}`,
      instructions: "Answer every question.",
      proctorMode: "LAB_SUPERVISED",
      affectsPlacementEligibility: false,
      opensAt: OPENS,
      closesAt: CLOSES,
      durationMinutes: "60",
      maxAttempts: "1",
      maxFocusWarnings: "3",
      onLimit: "AUTOSUBMIT" as const,
      strictMode: false,
      ...over,
    };
  };

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    actions = await import("@/server/actions/admin-assessments");

    const admin = await db.user.create({
      data: {
        collegeId: `${tag}-OWNER`.toUpperCase().slice(0, 32),
        email: `${tag}-owner@rajalakshmi.edu.invalid`,
        firstName: "Paper",
        lastName: "Owner",
        handle: `${tag}-owner`.slice(0, 30),
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    actorId = admin.id;

    const problem = await db.problem.findFirst({
      where: { liveVersionId: { not: null }, liveVersion: { frozenAt: { not: null } } },
      select: { slug: true },
    });
    publishedProblemSlug = problem?.slug ?? "";
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED) return;
    const ids = (await db.assessment.findMany({ where: { slug: { in: slugs } }, select: { id: true } })).map((a) => a.id);
    await db.examSession.deleteMany({ where: { assessmentId: { in: ids } } });
    await db.assessmentProblem.deleteMany({ where: { assessmentId: { in: ids } } });
    // A published assessment cannot be deleted — the database says so, and it
    // is right — so those are archived instead and left tagged.
    await db.assessment.updateMany({ where: { id: { in: ids }, status: { not: "DRAFT" } }, data: { status: "ARCHIVED" } });
    await db.assessment.deleteMany({ where: { id: { in: ids }, status: "DRAFT" } });
    await db.auditLog.deleteMany({ where: { actorId } });
    await db.user.deleteMany({ where: { id: actorId } }).catch(() => undefined);
  }, 60_000);

  it("creates a draft under a proctored mode", async () => {
    const result = await actions.createAssessment(base({ proctorMode: "ADVISORY" }));
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    const row = await db.assessment.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { status: true, proctorMode: true, durationSec: true },
    });
    expect(row.status).toBe("DRAFT");
    expect(row.proctorMode).toBe("ADVISORY");
    expect(row.durationSec).toBe(3600);
  }, 60_000);

  it("refuses an unproctored assessment, and so does the database", async () => {
    const result = await actions.createAssessment(base({ proctorMode: "NONE" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/always proctored|contest|practice/i);

    // And by the other door: the CHECK, with no action in the way.
    await expect(
      db.assessment.create({
        data: {
          slug: `${tag}-raw`,
          title: "Raw",
          instructions: "x",
          proctorMode: "NONE",
          opensAt: new Date(Date.now() + 3_600_000),
          closesAt: new Date(Date.now() + 7_200_000),
          durationSec: 3600,
          createdById: actorId,
        },
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("refuses placement eligibility unless it is lab-supervised", async () => {
    for (const mode of ["ADVISORY", "REMOTE_MONITORED", "KIOSK_SEB"]) {
      const result = await actions.createAssessment(base({ proctorMode: mode, affectsPlacementEligibility: true }));
      expect(result.ok, `${mode} should be refused`).toBe(false);
    }
    const lab = await actions.createAssessment(base({ proctorMode: "LAB_SUPERVISED", affectsPlacementEligibility: true }));
    expect(lab.ok, lab.ok ? "" : lab.error).toBe(true);
  }, 120_000);

  it("refuses publishing an empty paper, and a lab assessment with no hall", async () => {
    const created = await actions.createAssessment(base({ proctorMode: "LAB_SUPERVISED" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    const empty = await actions.setAssessmentStatus({ assessmentId: id, to: "PUBLISHED" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/empty paper|at least one question/i);

    if (publishedProblemSlug) {
      const added = await actions.addAssessmentProblem({
        assessmentId: id,
        problemSlug: publishedProblemSlug,
        position: "1",
        points: "1",
      });
      expect(added.ok, added.ok ? "" : added.error).toBe(true);

      const noHall = await actions.setAssessmentStatus({ assessmentId: id, to: "PUBLISHED" });
      expect(noHall.ok).toBe(false);
      if (!noHall.ok) expect(noHall.error).toMatch(/hall|allowlist/i);

      // A lab hall with no allowlist is refused: the allowlist IS the
      // enforcement, so an empty one is a lab sitting with nothing watching.
      const bare = await actions.scheduleExamSession({
        assessmentId: id,
        label: "Lab 1",
        room: null,
        startsAt: OPENS,
        endsAt: CLOSES,
        capacity: "30",
        allowedCidrs: [],
      });
      expect(bare.ok).toBe(false);

      const bad = await actions.scheduleExamSession({
        assessmentId: id,
        label: "Lab 1",
        room: null,
        startsAt: OPENS,
        endsAt: CLOSES,
        capacity: "30",
        allowedCidrs: ["not-a-network"],
      });
      expect(bad.ok).toBe(false);

      const hall = await actions.scheduleExamSession({
        assessmentId: id,
        label: "Lab 1",
        room: "AB1-304",
        startsAt: OPENS,
        endsAt: CLOSES,
        capacity: "30",
        allowedCidrs: ["10.21.0.0/16"],
      });
      expect(hall.ok, hall.ok ? "" : hall.error).toBe(true);

      const published = await actions.setAssessmentStatus({ assessmentId: id, to: "PUBLISHED" });
      expect(published.ok, published.ok ? "" : published.error).toBe(true);

      // Published: the question set is fixed, and so are the terms.
      const late = await actions.addAssessmentProblem({
        assessmentId: id,
        problemSlug: publishedProblemSlug,
        position: "2",
        points: "1",
      });
      expect(late.ok).toBe(false);
      await expect(
        db.assessment.update({ where: { id }, data: { proctorMode: "ADVISORY" } }),
      ).rejects.toThrow();
    }
  }, 180_000);

  it("walks DRAFT → PUBLISHED → OPEN → CLOSED and refuses a jump", async () => {
    const created = await actions.createAssessment(base({ proctorMode: "ADVISORY" }));
    expect(created.ok).toBe(true);
    if (!created.ok || !publishedProblemSlug) return;
    const id = created.data.id;
    await actions.addAssessmentProblem({ assessmentId: id, problemSlug: publishedProblemSlug, position: "1", points: "1" });

    const jump = await actions.setAssessmentStatus({ assessmentId: id, to: "OPEN" });
    expect(jump.ok).toBe(false);

    for (const to of ["PUBLISHED", "OPEN", "CLOSED"] as const) {
      const step = await actions.setAssessmentStatus({ assessmentId: id, to });
      expect(step.ok, step.ok ? "" : `${to}: ${step.error}`).toBe(true);
    }
    const back = await actions.setAssessmentStatus({ assessmentId: id, to: "OPEN" });
    expect(back.ok).toBe(false);
  }, 180_000);
});
