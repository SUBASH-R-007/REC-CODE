import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A submission that belongs to a contest (Phase 12q, slice 3).
 *
 * The gap this closes: `submitSolution` wrote `origin: "PRACTICE"`,
 * `lane: "PRACTICE"` for every submission in the product, and nothing else
 * in the application ever wrote a CONTEST one. So
 * `finalizeSubmission`'s `owner.origin === "CONTEST"` branch never fired,
 * `applyContestSubmission` — the whole of Phase 5's scoring, built and
 * unit-tested — was never reached, and `ContestStanding` stayed empty
 * however many contests were published and registered for. The arena told
 * the student their submissions counted. They did not.
 *
 * These are the four things the action now has to get right, and each one
 * was wrong before: the origin, the lane it is queued on, the contest it
 * names, and the VERSION it is judged against — the contest's pinned one,
 * not whatever the problem's live version happens to be by then.
 */

const h = vi.hoisted(() => ({
  problem: vi.fn(),
  version: vi.fn(),
  config: vi.fn(),
  count: vi.fn(),
  starter: vi.fn(),
  transaction: vi.fn(),
  user: vi.fn(),
  create: vi.fn(),
  enqueue: vi.fn(),
  entry: vi.fn(),
  caps: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    problem: { findUnique: h.problem },
    problemVersion: { findFirst: h.version },
    languageConfig: { findFirst: h.config },
    testCase: { count: h.count },
    starterCode: { findUnique: h.starter },
    $transaction: h.transaction,
    submission: { updateMany: vi.fn(async () => ({ count: 1 })) },
    runRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    user: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/auth/guards", () => ({ requireActionUser: h.user }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: h.enqueue }));
vi.mock("@/lib/contests/entry", () => ({ findLiveContestEntry: h.entry }));
vi.mock("@/lib/judge/caps", async (original) => {
  const real = await original<typeof import("@/lib/judge/caps")>();
  return { ...real, loadCaps: h.caps, loadSubmitUsage: h.usage };
});

const { submitSolution } = await import("@/server/actions/judge");

const LIVE_VERSION = "ver_live";
const PINNED_VERSION = "ver_pinned";

const ENTRY = {
  contestId: "con_1",
  contestSlug: "autumn-open",
  contestTitle: "Autumn Open",
  problemVersionId: PINNED_VERSION,
  index: "B",
  endsAt: new Date("2026-11-01T10:00:00.000Z"),
  virtual: false,
};

/** The transaction, run for real against a fake tx that records the create. */
function captureTransaction() {
  h.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<string>) =>
    fn({
      $executeRaw: vi.fn(async () => 1),
      submission: { create: h.create },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user.mockResolvedValue({ id: "user_1" });
  h.problem.mockResolvedValue({
    id: "prob_1",
    status: "PUBLISHED",
    liveVersion: {
      id: LIVE_VERSION,
      ioMode: "STDIN",
      compareMode: "TOKEN",
      functionSignature: null,
      maxEditedLines: null,
    },
  });
  h.version.mockResolvedValue({
    id: PINNED_VERSION,
    ioMode: "STDIN",
    compareMode: "TOKEN",
    functionSignature: null,
    maxEditedLines: null,
  });
  h.config.mockResolvedValue({ id: "cfg_1" });
  h.count.mockResolvedValue(8);
  h.create.mockResolvedValue({ id: "sub_1" });
  h.enqueue.mockResolvedValue(true);
  // Caps that refuse nothing, so these tests are about the origin only.
  h.caps.mockResolvedValue({
    inFlightSubmissions: 2,
    inFlightRuns: 1,
    practicePerDay: 300,
    runsPerHour: 60,
    cpuMinutesPerDay: 20,
  });
  h.usage.mockResolvedValue({ inFlight: 0, practiceToday: 0, cpuMsToday: 0 });
  captureTransaction();
});

const submit = () => submitSolution({ slug: "two-sum", language: "cpp20", source: "int main(){}\n" });

describe("submitSolution — inside a running contest", () => {
  it("writes a CONTEST submission on the CONTEST lane, naming the contest", async () => {
    h.entry.mockResolvedValue(ENTRY);
    const result = await submit();
    expect(result.ok).toBe(true);
    const data = h.create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({ origin: "CONTEST", lane: "CONTEST", contestId: "con_1" });
  });

  it("is judged against the version the contest pinned, not the problem's live one", async () => {
    // The whole point of pinning: a problem republished mid-contest must
    // not change what is being answered.
    h.entry.mockResolvedValue(ENTRY);
    await submit();
    expect(h.create.mock.calls[0]?.[0]?.data?.problemVersionId).toBe(PINNED_VERSION);
    expect(h.version).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PINNED_VERSION, problemId: "prob_1" } }),
    );
  });

  it("queues it on CONTEST, so a sensitive-lane node serves it", async () => {
    h.entry.mockResolvedValue(ENTRY);
    await submit();
    expect(h.enqueue).toHaveBeenCalledWith("submission", "sub_1", "CONTEST");
  });

  it("does not spend the practice allowance, and is not refused by it", async () => {
    // A student who revised hard that morning must not be locked out of
    // their contest answer. The practice counter is practice's.
    h.entry.mockResolvedValue(ENTRY);
    h.usage.mockResolvedValue({ inFlight: 0, practiceToday: 300, cpuMsToday: 0 });
    const result = await submit();
    expect(result.ok).toBe(true);
  });

  it("still obeys the in-flight cap, which protects the fleet", async () => {
    h.entry.mockResolvedValue(ENTRY);
    h.usage.mockResolvedValue({ inFlight: 2, practiceToday: 0, cpuMsToday: 0 });
    const result = await submit();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("being judged");
  });

  it("still obeys the CPU allowance", async () => {
    h.entry.mockResolvedValue(ENTRY);
    h.usage.mockResolvedValue({ inFlight: 0, practiceToday: 0, cpuMsToday: 20 * 60_000 });
    const result = await submit();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("CPU-minute");
  });
});

describe("submitSolution — outside any contest", () => {
  beforeEach(() => {
    h.entry.mockResolvedValue(null);
  });

  it("is still a PRACTICE submission on the PRACTICE lane, naming no contest", async () => {
    const result = await submit();
    expect(result.ok).toBe(true);
    expect(h.create.mock.calls[0]?.[0]?.data).toMatchObject({
      origin: "PRACTICE",
      lane: "PRACTICE",
      contestId: null,
    });
    expect(h.enqueue).toHaveBeenCalledWith("submission", "sub_1", "PRACTICE");
  });

  it("is judged against the live version, and reads no other one", async () => {
    await submit();
    expect(h.create.mock.calls[0]?.[0]?.data?.problemVersionId).toBe(LIVE_VERSION);
    expect(h.version).not.toHaveBeenCalled();
  });

  it("is refused once the practice allowance is spent", async () => {
    h.usage.mockResolvedValue({ inFlight: 0, practiceToday: 300, cpuMsToday: 0 });
    const result = await submit();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("practice");
  });
});
