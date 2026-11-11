import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin stream's rows of the role × capability matrix. Every admin action
 * (and the retrofitted /admin/judge actions) is refused for STUDENT,
 * TA_MENTOR and PLACEMENT_OFFICER before the database is touched. ADMIN may
 * run everything except approving, rejecting and revoking an accommodation
 * and granting a judge-cap override (requireSuperAdmin). Every successful
 * mutation is audited with the expected action and sensitivity, and
 * accommodation audit metadata never carries `kinds`, `reason` or
 * `decisionNote`.
 *
 * The database is a recording fake: each action's happy path is stubbed below.
 */

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  const fn = (key: string) => {
    let f = fns.get(key);
    if (!f) {
      f = vi.fn();
      fns.set(key, f);
    }
    return f;
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method) =>
          typeof method === "string"
            ? (...args: unknown[]) => {
                calls.push(`${name}.${method}`);
                return fn(`${name}.${method}`)(...args);
              }
            : undefined,
      },
    );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop === "$transaction") {
          return async (arg: unknown) => {
            calls.push("$transaction");
            return typeof arg === "function" ? (arg as (tx: unknown) => unknown)(db) : Promise.all(arg as unknown[]);
          };
        }
        if (prop.startsWith("$")) {
          return (...args: unknown[]) => {
            calls.push(prop);
            return fn(prop)(...args);
          };
        }
        return model(prop);
      },
    },
  );
  return {
    db,
    fn,
    fns,
    calls,
    actor: { id: "actor_1", role: "ADMIN" as string, firstName: "A", lastName: "B" },
    audit: vi.fn(),
    destroyAllSessions: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "iphash" }));
vi.mock("@/lib/rate-limit", () => ({ hitRateLimit: async () => ({ allowed: true, remaining: 9, retryAfterMs: 0 }) }));
vi.mock("@/lib/auth/session", () => ({ destroyAllSessions: h.destroyAllSessions }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined, unstable_cache: (f: unknown) => f }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const e = new Error("NEXT_REDIRECT") as Error & { digest: string };
    e.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw e;
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: async () => true }));
vi.mock("@/lib/judge/lanes", () => ({ allowUnhardenedNodes: () => false }));
vi.mock("@/lib/judge/rejudge", () => ({ resetForRejudge: async () => 1 }));
vi.mock("@/server/queries/judge-languages", () => ({ revalidateLanguageConfigs: () => undefined }));
vi.mock("@/lib/auth/guards", async () => {
  const { ForbiddenError } = await import("@/lib/errors");
  const requireActionRole = async (...roles: string[]) => {
    if (!roles.includes(h.actor.role)) throw new ForbiddenError();
    return h.actor;
  };
  return {
    requireActionRole,
    requireSuperAdmin: () => requireActionRole("SUPER_ADMIN"),
    requireActionUser: async () => h.actor,
    requirePageRole: requireActionRole,
  };
});

const { ROSTER_COLUMNS } = await import("@recx/shared");
const roster = await import("@/server/actions/admin-roster");
const students = await import("@/server/actions/admin-students");
const plans = await import("@/server/actions/admin-plans");
const announcements = await import("@/server/actions/admin-announcements");
const accommodations = await import("@/server/actions/admin-accommodations");
const judge = await import("@/server/actions/admin-judge");
const { buildStudentScope } = await import("@/lib/auth/scope-where");
const { planRosterImport, rosterPlanSha256 } = await import("@/lib/admin/roster-plan");
const { validateRosterLines } = await import("@/lib/admin/roster-csv");

const FORBIDDEN = "You don't have permission to do that.";
const REASON = "Recorded for the audit trail";
const FUTURE = new Date(Date.now() + 30 * 86_400_000);
const stub = (key: string, value: unknown) => h.fn(key).mockResolvedValue(value);

const STUDENT_ROW = {
  id: "stu_1",
  collegeId: "2116231001001",
  lmsUserId: "lms-1",
  firstName: "Priya",
  lastName: "Sharma",
  email: "priya@example.edu",
  handle: "priya-s",
  status: "ACTIVE",
  batchYear: 2027,
  departmentCode: "CSE",
  section: "A",
  lastActiveAt: null,
  lastLoginAt: null,
  createdAt: new Date(),
};

const CSV_ROW = {
  lmsUserId: "lms-9",
  collegeId: "2116231009999",
  email: "new@example.edu",
  firstName: "New",
  lastName: "Student",
  batchYear: "2027",
  departmentCode: "CSE",
  section: "A",
};

function csvForm(): FormData {
  const text = `${ROSTER_COLUMNS.join(",")}\n${ROSTER_COLUMNS.map((c) => CSV_ROW[c]).join(",")}\n`;
  const form = new FormData();
  form.set("file", new File([text], "roster.csv", { type: "text/csv" }));
  return form;
}

/** The stored preview rows and the hash the commit must present (planned as SUPER would: whole college). */
function previewFixture() {
  const lines = validateRosterLines([{ line: 2, cells: { ...CSV_ROW } }]);
  const scope = buildStudentScope({ id: h.actor.id, role: "SUPER_ADMIN" }, []);
  return { lines, sha: rosterPlanSha256(planRosterImport(lines, [], scope)) };
}

const lockedPlan = (fields: Record<string, unknown> = {}) => [
  { id: "plan_1", slug: "plan-one", kind: "SHEET", seedManaged: false, published: false, itemsTotal: 3, ...fields },
];

const accommodationRow = (status: string) => [
  { id: "acc_1", userId: "stu_1", status, supersedesId: null, validUntil: FUTURE, requestedById: h.actor.id },
];

const TERMS = {
  kinds: ["SCREEN_READER" as const],
  exemptSignals: ["FOCUS_LOSS" as const],
  extraTimePercent: 0,
  extraTimeMinutes: 0,
  allowBreaks: false,
  breakMinutes: 0,
  fontScalePercent: 100,
  allowScribe: false,
  highContrast: false,
  validUntil: FUTURE,
};

function stubAccommodationAuditRow() {
  stub("accommodation.findFirstOrThrow", {
    id: "acc_1",
    userId: "stu_1",
    validUntil: FUTURE,
    extraTimePercent: 0,
    extraTimeMinutes: 0,
    exemptSignals: ["FOCUS_LOSS"],
    supersedesId: null,
  });
}

function stubAccommodationLock(status: string) {
  stub("accommodation.findFirst", { supersedesId: null });
  stub("$queryRaw", accommodationRow(status));
  stub("accommodation.updateMany", { count: 1 });
  stub("accommodation.count", 0);
  stubAccommodationAuditRow();
}

interface Row {
  name: string;
  run: () => Promise<{ ok: boolean; error?: string }>;
  /** requireSuperAdmin: ADMIN is refused. */
  superOnly?: boolean;
  /** Stubs for the happy path, and the audit it must write. Omitted: covered by test/admin-judge.test.ts. */
  setup?: () => void;
  audit?: { action: string; sensitivity: "NORMAL" | "SENSITIVE" | "SECURITY" };
  accommodation?: boolean;
}

/** Runs an action whose success path redirects (Next's redirect is an exception). */
async function settle(p: Promise<{ ok: boolean; error?: string }>): Promise<{ ok: boolean; error?: string }> {
  try {
    return await p;
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return { ok: true };
    throw error;
  }
}

const ADMIN_ACTION_MATRIX: Row[] = [
  // ── Students ──
  {
    name: "forceSignOutStudent",
    run: () => students.forceSignOutStudent({ userId: "stu_1", reason: REASON }),
    setup: () => stub("user.findFirst", STUDENT_ROW),
    audit: { action: "student.sessions.revoked", sensitivity: "SENSITIVE" },
  },
  // ── Roster ──
  {
    name: "previewRosterImport",
    run: () => settle(roster.previewRosterImport(null, csvForm())),
    setup: () => {
      stub("user.findMany", []);
      stub("rosterImport.updateMany", { count: 0 });
      stub("rosterImport.create", { id: "imp_1" });
    },
    audit: { action: "roster.import.previewed", sensitivity: "NORMAL" },
  },
  {
    name: "commitRosterImport",
    run: () => roster.commitRosterImport({ importId: "imp_1", diffSha256: previewFixture().sha }),
    setup: () => {
      stub("$executeRaw", 0);
      stub("rosterImport.findUnique", {
        id: "imp_1",
        status: "PREVIEWED",
        createdById: h.actor.id,
        expiresAt: FUTURE,
        rows: previewFixture().lines,
      });
      stub("user.findMany", []);
      stub("user.createManyAndReturn", [{ id: "new_1", collegeId: CSV_ROW.collegeId }]);
      stub("rosterImport.updateMany", { count: 1 });
    },
    audit: { action: "roster.import.committed", sensitivity: "SENSITIVE" },
  },
  {
    name: "discardRosterImport",
    run: () => roster.discardRosterImport({ importId: "imp_1" }),
    setup: () => {
      stub("rosterImport.findUnique", { id: "imp_1", createdById: h.actor.id });
      stub("rosterImport.updateMany", { count: 1 });
    },
    audit: { action: "roster.import.discarded", sensitivity: "NORMAL" },
  },
  // ── Plans ──
  {
    name: "createStudyPlan",
    run: () =>
      settle(plans.createStudyPlan({ kind: "SHEET", slug: "dp-basics", title: "DP basics", description: "Dynamic programming.", sortOrder: 1 })),
    setup: () => stub("studyPlan.create", { id: "plan_1" }),
    audit: { action: "plan.created", sensitivity: "NORMAL" },
  },
  {
    name: "updateStudyPlan",
    run: () => plans.updateStudyPlan({ planId: "plan_1", title: "DP basics", description: "Dynamic programming.", sortOrder: 2 }),
    setup: () => stub("$queryRaw", lockedPlan()),
    audit: { action: "plan.updated", sensitivity: "NORMAL" },
  },
  {
    name: "setStudyPlanPublished",
    run: () => plans.setStudyPlanPublished({ planId: "plan_1", published: true }),
    setup: () => {
      stub("$queryRaw", lockedPlan());
      stub("$executeRaw", 0);
    },
    audit: { action: "plan.published", sensitivity: "NORMAL" },
  },
  {
    name: "detachPlanFromSeed",
    run: () => plans.detachPlanFromSeed({ planId: "plan_1", reason: REASON }),
    setup: () => stub("$queryRaw", lockedPlan({ seedManaged: true })),
    audit: { action: "plan.detached_from_seed", sensitivity: "NORMAL" },
  },
  {
    name: "addPlanSection",
    run: () => plans.addPlanSection({ planId: "plan_1", title: "Warm-up" }),
    setup: () => {
      stub("$queryRaw", lockedPlan());
      stub("studyPlanSection.findFirst", null);
      stub("studyPlanSection.create", { id: "sec_1" });
    },
    audit: { action: "plan.section.added", sensitivity: "NORMAL" },
  },
  {
    name: "renamePlanSection",
    run: () => plans.renamePlanSection({ sectionId: "sec_1", title: "Warm-up" }),
    setup: () => {
      stub("studyPlanSection.findUnique", { id: "sec_1", planId: "plan_1", sortOrder: 0 });
      stub("$queryRaw", lockedPlan());
    },
    audit: { action: "plan.section.renamed", sensitivity: "NORMAL" },
  },
  {
    name: "movePlanSection",
    run: () => plans.movePlanSection({ sectionId: "sec_2", direction: "up" }),
    setup: () => {
      stub("studyPlanSection.findUnique", { id: "sec_2", planId: "plan_1", sortOrder: 1 });
      stub("$queryRaw", lockedPlan());
      stub("studyPlanSection.findMany", [
        { id: "sec_1", sortOrder: 0 },
        { id: "sec_2", sortOrder: 1 },
      ]);
    },
    audit: { action: "plan.section.moved", sensitivity: "NORMAL" },
  },
  {
    name: "deletePlanSection",
    run: () => plans.deletePlanSection({ sectionId: "sec_1" }),
    setup: () => {
      stub("studyPlanSection.findUnique", { id: "sec_1", planId: "plan_1", sortOrder: 0 });
      stub("$queryRaw", lockedPlan());
      stub("studyPlanItem.count", 2);
      stub("studyPlanSection.findMany", []);
      stub("$executeRaw", 0);
    },
    audit: { action: "plan.section.deleted", sensitivity: "NORMAL" },
  },
  {
    name: "addPlanItems",
    run: () => plans.addPlanItems({ planId: "plan_1", sectionId: "sec_1", problemCodes: ["REC-0001"] }),
    setup: () => {
      stub("$queryRaw", lockedPlan());
      stub("studyPlanSection.findUnique", { planId: "plan_1" });
      stub("problem.findMany", [{ id: "p1", displayCode: "REC-0001" }]);
      stub("studyPlanItem.findMany", []);
      stub("studyPlanItem.findFirst", null);
      stub("$executeRaw", 0);
    },
    audit: { action: "plan.items.added", sensitivity: "NORMAL" },
  },
  {
    name: "movePlanItem",
    run: () => plans.movePlanItem({ itemId: "item_1", sectionId: "sec_1", position: 0 }),
    setup: () => {
      stub("studyPlanItem.findUnique", { planId: "plan_1", sectionId: "sec_1" });
      stub("$queryRaw", lockedPlan());
      stub("studyPlanSection.findUnique", { planId: "plan_1" });
      stub("studyPlanItem.findMany", []);
    },
    audit: { action: "plan.item.moved", sensitivity: "NORMAL" },
  },
  {
    name: "removePlanItem",
    run: () => plans.removePlanItem({ itemId: "item_1" }),
    setup: () => {
      stub("studyPlanItem.findUnique", { planId: "plan_1", sectionId: "sec_1", problem: { displayCode: "REC-0001" } });
      stub("$queryRaw", lockedPlan());
      stub("studyPlanItem.findMany", []);
      stub("$executeRaw", 0);
    },
    audit: { action: "plan.item.removed", sensitivity: "NORMAL" },
  },
  // ── Announcements ──
  {
    name: "saveAnnouncementDraft",
    run: () =>
      announcements.saveAnnouncementDraft({
        title: "Lab closed",
        body: "The lab is closed on Friday.",
        tone: "INFO",
        audience: { batchYear: 2027, departmentCode: "CSE", section: null },
        endsAt: new Date(Date.now() + 3 * 86_400_000),
      }),
    setup: () => stub("announcement.create", { id: "ann_1" }),
    audit: { action: "announcement.draft_saved", sensitivity: "NORMAL" },
  },
  {
    name: "publishAnnouncement",
    run: () => announcements.publishAnnouncement({ id: "ann_1" }),
    setup: () => {
      stub("$queryRaw", [{ id: "ann_1" }]);
      stub("announcement.findUniqueOrThrow", {
        id: "ann_1",
        title: "Lab closed",
        body: "Body",
        link: null,
        tone: "INFO",
        createdById: h.actor.id,
        publishedAt: null,
        endsAt: FUTURE,
        audienceBatchYear: 2027,
        audienceDepartmentCode: "CSE",
        audienceSection: null,
      });
      stub("user.findMany", [{ id: "stu_1" }, { id: "stu_2" }]);
      stub("notification.createMany", { count: 2 });
      stub("announcement.update", {});
    },
    audit: { action: "announcement.published", sensitivity: "SENSITIVE" },
  },
  {
    name: "archiveAnnouncement",
    run: () => announcements.archiveAnnouncement({ id: "ann_1" }),
    setup: () => {
      stub("announcement.findUnique", {
        id: "ann_1",
        publishedAt: new Date(),
        archivedAt: null,
        audienceBatchYear: 2027,
        audienceDepartmentCode: "CSE",
      });
      stub("announcement.updateMany", { count: 1 });
    },
    audit: { action: "announcement.archived", sensitivity: "NORMAL" },
  },
  // ── Accommodations ──
  {
    name: "requestAccommodation",
    run: () => accommodations.requestAccommodation({ userId: "stu_1", terms: TERMS, reason: "Uses a screen reader for all coursework." }),
    setup: () => {
      stub("user.findFirst", STUDENT_ROW);
      stub("accommodation.count", 0);
      stub("accommodation.create", { id: "acc_1", status: "REQUESTED" });
      stubAccommodationAuditRow();
    },
    audit: { action: "accommodation.requested", sensitivity: "SENSITIVE" },
    accommodation: true,
  },
  {
    name: "withdrawAccommodation",
    run: () => accommodations.withdrawAccommodation({ id: "acc_1" }),
    setup: () => stubAccommodationLock("REQUESTED"),
    audit: { action: "accommodation.withdrawn", sensitivity: "SENSITIVE" },
    accommodation: true,
  },
  {
    name: "approveAccommodation",
    superOnly: true,
    run: () => accommodations.approveAccommodation({ id: "acc_1", note: "Confirmed by the accessibility office." }),
    setup: () => stubAccommodationLock("REQUESTED"),
    audit: { action: "accommodation.approved", sensitivity: "SENSITIVE" },
    accommodation: true,
  },
  {
    name: "rejectAccommodation",
    superOnly: true,
    run: () => accommodations.rejectAccommodation({ id: "acc_1", note: "No supporting document yet." }),
    setup: () => stubAccommodationLock("REQUESTED"),
    audit: { action: "accommodation.rejected", sensitivity: "SENSITIVE" },
    accommodation: true,
  },
  {
    name: "revokeAccommodation",
    superOnly: true,
    run: () => accommodations.revokeAccommodation({ id: "acc_1", reason: "Granted for the wrong term." }),
    setup: () => stubAccommodationLock("APPROVED"),
    audit: { action: "accommodation.revoked", sensitivity: "SENSITIVE" },
    accommodation: true,
  },
  // ── /admin/judge (retrofitted; success paths in test/admin-judge.test.ts) ──
  { name: "setJudgeNodeStatus", run: () => judge.setJudgeNodeStatus({ nodeId: "judge-01", action: "drain", reason: REASON }) },
  { name: "rejudgeSubmission", run: () => judge.rejudgeSubmission({ submissionId: "sub_1" }) },
  { name: "setLanguageEnabled", run: () => judge.setLanguageEnabled({ languageConfigId: "lc_1", enabled: false, reason: REASON }) },
  {
    name: "grantJudgeQuotaOverride",
    superOnly: true,
    run: () => judge.grantJudgeQuotaOverride({ collegeId: "2116231001001", reason: REASON }),
  },
];

beforeEach(() => {
  for (const f of h.fns.values()) f.mockReset();
  h.calls.length = 0;
  h.audit.mockReset();
  h.destroyAllSessions.mockReset();
  // An ADMIN with a college-wide grant.
  stub("adminScope.findMany", [{ departmentCode: null, batchYear: null }]);
});

const rows = ADMIN_ACTION_MATRIX.map((r) => [r.name, r] as const);

describe.each(["STUDENT", "TA_MENTOR", "PLACEMENT_OFFICER"])("%s", (role) => {
  it.each(rows)("is refused %s before any database access", async (_name, row) => {
    h.actor.role = role;
    row.setup?.();
    h.calls.length = 0;
    const result = await row.run();
    expect(result).toEqual({ ok: false, error: FORBIDDEN });
    expect(h.calls.filter((c) => c !== "adminScope.findMany")).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("ADMIN", () => {
  it.each(rows.filter(([, r]) => r.superOnly))("is refused %s (super-admin only)", async (_name, row) => {
    h.actor.role = "ADMIN";
    row.setup?.();
    const result = await row.run();
    expect(result).toEqual({ ok: false, error: FORBIDDEN });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each(rows.filter(([, r]) => !r.superOnly && r.setup))("may run %s, which is audited", async (_name, row) => {
    h.actor.role = "ADMIN";
    row.setup!();
    const result = await row.run();
    expect(result.ok, result.error).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: h.actor.id, action: row.audit!.action, sensitivity: row.audit!.sensitivity, ipHash: "iphash" }),
    );
  });

  it.each(rows.filter(([, r]) => !r.superOnly && !r.setup))("gets past the role guard of %s", async (_name, row) => {
    h.actor.role = "ADMIN";
    // Unstubbed database: the action fails after its guard (logged), which is all this checks.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await row.run();
    quiet.mockRestore();
    expect(result.ok || result.error).not.toBe(FORBIDDEN);
  });
});

describe("SUPER_ADMIN", () => {
  it.each(rows.filter(([, r]) => r.setup))("may run %s, which is audited", async (_name, row) => {
    h.actor.role = "SUPER_ADMIN";
    row.setup!();
    const result = await row.run();
    expect(result.ok, result.error).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: row.audit!.action, sensitivity: row.audit!.sensitivity }));
  });

  it("gets past the guard of grantJudgeQuotaOverride", async () => {
    h.actor.role = "SUPER_ADMIN";
    const result = await judge.grantJudgeQuotaOverride({ collegeId: "2116231001001", reason: REASON });
    expect(result.ok || result.error).not.toBe(FORBIDDEN);
  });
});

describe("accommodation audit metadata", () => {
  it.each(rows.filter(([, r]) => r.accommodation))("%s never records kinds, reason or the decision note", async (_name, row) => {
    h.actor.role = "SUPER_ADMIN";
    row.setup!();
    const result = await row.run();
    expect(result.ok, result.error).toBe(true);
    for (const [entry] of h.audit.mock.calls as [{ metadata: Record<string, unknown> }][]) {
      const keys = Object.keys(entry.metadata);
      expect(keys).not.toContain("kinds");
      expect(keys).not.toContain("reason");
      expect(keys).not.toContain("decisionNote");
      const text = JSON.stringify(entry.metadata);
      expect(text).not.toContain("SCREEN_READER");
      expect(text).not.toMatch(/screen reader for all coursework|accessibility office|supporting document/);
      expect(keys.every((k) => ["accommodationId", "from", "to", "validUntil", "extraTimePercent", "extraTimeMinutes", "exemptSignals", "supersedesId", "approvedNow", "revokeReason"].includes(k))).toBe(true);
    }
  });

  it("a revoke records its reason as revokeReason (the one allowed free text)", async () => {
    h.actor.role = "SUPER_ADMIN";
    stubAccommodationLock("APPROVED");
    await accommodations.revokeAccommodation({ id: "acc_1", reason: "Granted for the wrong term." });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ revokeReason: "Granted for the wrong term.", to: "REVOKED" }) }),
    );
  });

  it("approveNow is honoured only for a SUPER_ADMIN", async () => {
    h.actor.role = "ADMIN";
    stub("user.findFirst", STUDENT_ROW);
    stub("accommodation.count", 0);
    stub("accommodation.create", { id: "acc_1", status: "REQUESTED" });
    stubAccommodationAuditRow();
    const asAdmin = await accommodations.requestAccommodation({ userId: "stu_1", terms: TERMS, reason: "Needs a screen reader.", approveNow: true });
    expect(asAdmin).toEqual({ ok: true, data: { id: "acc_1", status: "REQUESTED" } });
    expect(h.fn("accommodation.updateMany")).not.toHaveBeenCalled();

    h.actor.role = "SUPER_ADMIN";
    stub("accommodation.updateMany", { count: 1 });
    const asSuper = await accommodations.requestAccommodation({ userId: "stu_1", terms: TERMS, reason: "Needs a screen reader.", approveNow: true });
    expect(asSuper).toEqual({ ok: true, data: { id: "acc_1", status: "APPROVED" } });
    expect(h.fn("accommodation.updateMany")).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "APPROVED", approvedBySuperAdminId: h.actor.id }) }),
    );
  });
});

describe("scope inside the actions", () => {
  it("an ADMIN with no grant cannot reach any student", async () => {
    h.actor.role = "ADMIN";
    stub("adminScope.findMany", []);
    stub("user.findFirst", null);
    const result = await students.forceSignOutStudent({ userId: "stu_1", reason: REASON });
    expect(result).toEqual({ ok: false, error: "That student was not found." });
    expect(h.fn("user.findFirst")).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ role: "STUDENT" }, { id: { in: [] } }, { id: "stu_1" }] } }),
    );
    expect(h.destroyAllSessions).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("an announcement audience outside the scope is refused", async () => {
    h.actor.role = "ADMIN";
    stub("adminScope.findMany", [{ departmentCode: "CSE", batchYear: null }]);
    const result = await announcements.saveAnnouncementDraft({
      title: "Hello",
      body: "World",
      tone: "INFO",
      audience: { batchYear: 2027, departmentCode: "ECE", section: null },
      endsAt: new Date(Date.now() + 86_400_000),
    });
    expect(result).toEqual({ ok: false, error: "That audience is outside your scope." });
    expect(h.calls.filter((c) => c.startsWith("announcement."))).toEqual([]);
  });

  it("an off-site announcement link is refused", async () => {
    h.actor.role = "ADMIN";
    const result = await announcements.saveAnnouncementDraft({
      title: "Hello",
      body: "World",
      tone: "INFO",
      link: "https://evil.example/phish",
      audience: { batchYear: null, departmentCode: null, section: null },
      endsAt: new Date(Date.now() + 86_400_000),
    });
    expect(result.ok).toBe(false);
    expect(result.ok || result.error).toMatch(/path on this site/);
  });

  it("the roster import never writes a role, status change or password beyond the new-account defaults", async () => {
    h.actor.role = "SUPER_ADMIN";
    ADMIN_ACTION_MATRIX.find((r) => r.name === "commitRosterImport")!.setup!();
    const result = await roster.commitRosterImport({ importId: "imp_1", diffSha256: previewFixture().sha });
    expect(result.ok, result.ok ? undefined : result.error).toBe(true);
    const [{ data }] = h.fn("user.createManyAndReturn").mock.calls[0] as [{ data: Record<string, unknown>[] }];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ role: "STUDENT", status: "ACTIVE", passwordHash: null, lmsUserId: "lms-9", handle: "new-s" });
  });

  it("a commit whose diff hash no longer matches is refused", async () => {
    h.actor.role = "SUPER_ADMIN";
    ADMIN_ACTION_MATRIX.find((r) => r.name === "commitRosterImport")!.setup!();
    const result = await roster.commitRosterImport({ importId: "imp_1", diffSha256: "0".repeat(64) });
    expect(result.ok || result.error).toMatch(/changed since your preview/);
    expect(h.fn("user.createManyAndReturn")).not.toHaveBeenCalled();
  });
});
