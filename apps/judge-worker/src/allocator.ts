import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import {
  JUDGE_LANES,
  JUDGE_LEASE_SECONDS,
  LANE_ALLOCATION,
  LANE_PRIORITY,
  QUEUE_NAME,
  type JudgeJobData,
  type JudgeLane,
} from "@recx/shared";
import { ProtocolMismatchError, errorMessage } from "./errors";
import type { Logger } from "./logger";
import { processJob, type ProcessOutcome, type ProcessorDeps } from "./processor";
import type { SlotPool } from "./slots";

/**
 * Weighted slot allocation across the five judge lanes.
 *
 * BullMQ priority alone provably starves the low lane (a saturated high-priority
 * queue is always served first), so the WORKER does the allocation: it fetches
 * jobs manually (a Worker per lane with no processor; getNextJob(token) only
 * when a slot is free and the policy picks that lane) and never holds a job it
 * has no slot for.
 *
 * The policy (pickLane) is a PURE function of the node's state so it can be
 * unit-tested exhaustively, including starvation. LANE_ALLOCATION (@recx/shared):
 *  - RUN keeps HARD-reserved slots (2, or 1 on a node with < 3 slots) that no
 *    other lane may consume, so the editor's Run button is always responsive;
 *  - ASSESSMENT may use up to 60 % of slots, CONTEST up to 50 %, REJUDGE up to
 *    20 % (and 0 while the assessment queue depth exceeds 50);
 *  - PRACTICE has a 25 % floor — a SOFT reservation kept while practice has
 *    waiting jobs or was active within the last 2 s, so practice is never
 *    starved to zero but an idle floor does not waste capacity;
 *  - caps and the practice floor use integer slot counts; on small nodes the
 *    rounding is documented in laneBudget().
 */

export type LaneBusy = Readonly<Record<JudgeLane, number>>;

export interface AllocatorPolicyState {
  /** Total judging slots on this node. */
  slots: number;
  /** Lanes the node may serve right now (served queues ∩ heartbeat-allowed lanes). */
  allowedLanes: readonly JudgeLane[];
  /** Jobs currently in flight per lane. */
  busy: LaneBusy;
  /** Jobs waiting (claimable) per lane — only meaningful for allowed lanes. */
  waiting: LaneBusy;
  /** Last time each lane pulled or completed a job (ms epoch; 0 = never). */
  lastActiveAt: LaneBusy;
  /**
   * The global assessment queue depth, for the rejudge pause. The runtime
   * reads it from Redis even on a node that does not serve ASSESSMENT; a node
   * that cannot see it passes 0 (no pause).
   */
  assessmentDepth: number;
  now: number;
}

export interface LaneBudget {
  slots: number;
  /** Slots kept free for RUN (hard). */
  runReserved: number;
  /** PRACTICE floor (soft reservation), in slots. */
  practiceFloor: number;
  /** Upper bound on in-flight jobs per lane; RUN and PRACTICE are uncapped (Infinity). */
  cap: Readonly<Record<JudgeLane, number>>;
}

function zeroBusy(): Record<JudgeLane, number> {
  return { ASSESSMENT: 0, CONTEST: 0, RUN: 0, PRACTICE: 0, REJUDGE: 0 };
}

/** The RUN reservation: 2 slots, or 1 on a node with < 3 slots. Never more than fits. */
export function runReservedSlots(slots: number, servesRun: boolean, servesOtherLane: boolean): number {
  if (!servesRun || slots < 1) return 0;
  const raw = slots < 3 ? 1 : LANE_ALLOCATION.RUN.hardReservedSlots;
  // Leave at least one slot for the other served lanes so a small node that
  // co-serves RUN (e.g. the 1-slot dev default: practice + run) still makes
  // progress on them. On nodes with ≥ 3 slots this never lowers the reserve.
  return servesOtherLane ? Math.min(raw, Math.max(0, slots - 1)) : Math.min(raw, slots);
}

/**
 * Integer slot budget for a node of `slots` slots serving `allowedLanes`, with
 * the given assessment backlog. Caps are floor(maxShare × slots); the practice
 * floor is ceil(minShare × slots) so practice is guaranteed ≥ 25 %. A lane that
 * is the ONLY allowed lane is uncapped, so a single-purpose node is never
 * throttled into wasting capacity. On a node with < 5 slots, REJUDGE's floored
 * cap is 0 — such a node defers rejudges to larger fleet members.
 */
export function laneBudget(
  slots: number,
  allowedLanes: readonly JudgeLane[],
  assessmentDepth: number,
): LaneBudget {
  const allowed = new Set(allowedLanes);
  const servesOther = JUDGE_LANES.some((l) => l !== "RUN" && allowed.has(l));
  const soleLane = allowed.size === 1;
  const cap = zeroBusy() as Record<JudgeLane, number>;

  const capFor = (lane: JudgeLane, share: number): number =>
    soleLane && allowed.has(lane) ? slots : Math.floor(share * slots);

  cap.ASSESSMENT = capFor("ASSESSMENT", LANE_ALLOCATION.ASSESSMENT.maxShare);
  cap.CONTEST = capFor("CONTEST", LANE_ALLOCATION.CONTEST.maxShare);
  cap.REJUDGE =
    assessmentDepth > LANE_ALLOCATION.REJUDGE.pauseWhenAssessmentDepthAbove
      ? 0
      : capFor("REJUDGE", LANE_ALLOCATION.REJUDGE.maxShare);
  // RUN and PRACTICE are not capped by a maxShare; RUN is bounded only by free
  // slots (plus its reservation), PRACTICE by free slots above its floor.
  cap.RUN = slots;
  cap.PRACTICE = slots;

  return {
    slots,
    runReserved: runReservedSlots(slots, allowed.has("RUN"), servesOther),
    practiceFloor: Math.ceil(LANE_ALLOCATION.PRACTICE.minShare * slots),
    cap,
  };
}

function sum(busy: LaneBusy): number {
  return JUDGE_LANES.reduce((total, lane) => total + busy[lane], 0);
}

/**
 * The one scheduling decision: which lane to pull next, or null when no lane
 * may be pulled right now (no free slot, no allowed lane with waiting work, or
 * every candidate is capped or blocked by a reservation). Pure and total.
 */
export function pickLane(state: AllocatorPolicyState): JudgeLane | null {
  const { slots, busy, waiting, lastActiveAt, now } = state;
  if (sum(busy) >= slots) return null; // no free slot

  const allowed = new Set(state.allowedLanes);
  const budget = laneBudget(slots, state.allowedLanes, state.assessmentDepth);
  const nonRunBusy = sum(busy) - busy.RUN;
  const nonPracticeBusy = sum(busy) - busy.PRACTICE;

  // The practice floor is reserved while practice has work or was active within
  // the idle window (soft reservation; RUN's is the only hard one).
  const practiceActive =
    allowed.has("PRACTICE") &&
    (waiting.PRACTICE > 0 ||
      (lastActiveAt.PRACTICE > 0 && now - lastActiveAt.PRACTICE < LANE_ALLOCATION.softReservationIdleMs));
  const practiceReserved = practiceActive ? Math.max(0, budget.practiceFloor - busy.PRACTICE) : 0;

  const eligible = (lane: JudgeLane): boolean => {
    if (!allowed.has(lane) || waiting[lane] <= 0) return false;
    if (busy[lane] >= budget.cap[lane]) return false;
    // Pulling a non-RUN lane must leave RUN's reservation free.
    if (lane !== "RUN" && nonRunBusy + 1 > slots - budget.runReserved) return false;
    // Pulling a non-PRACTICE lane must leave the practice floor reachable.
    if (lane !== "PRACTICE" && nonPracticeBusy + 1 > slots - practiceReserved) return false;
    return true;
  };

  const candidates = JUDGE_LANES.filter(eligible);
  if (candidates.length === 0) return null;

  // Practice below its floor is pulled first — the reservation keeps slots free
  // for it, and this is what actually fills them, so practice reaches ≥ 25 %
  // slot-time even under a saturating high-priority mix. Otherwise LANE_PRIORITY
  // decides (ASSESSMENT < RUN < CONTEST < PRACTICE < REJUDGE).
  const practiceBelowFloor = candidates.includes("PRACTICE") && busy.PRACTICE < budget.practiceFloor;
  if (practiceBelowFloor) return "PRACTICE";

  return candidates.reduce((best, lane) => (LANE_PRIORITY[lane] < LANE_PRIORITY[best] ? lane : best));
}

// ── Runtime allocator ───────────────────────────────────────────────────────

/** Lanes whose queue the node is configured to serve, derived from RECX_QUEUES. */
export function servedLanes(queues: readonly string[]): JudgeLane[] {
  const set = new Set(queues);
  return JUDGE_LANES.filter((lane) => set.has(QUEUE_NAME[lane]));
}

export interface LaneAllocatorOptions {
  deps: ProcessorDeps;
  connection: Redis;
  slots: SlotPool;
  /** Queues this node serves (RECX_QUEUES). */
  queues: readonly string[];
  logger: Logger;
  /** Lock duration / renewal for manually fetched jobs (default from the lease). */
  lockDurationMs?: number;
  /** How often to refresh queue depths and re-run the fill loop. */
  tickMs?: number;
  onProtocolMismatch(error: ProtocolMismatchError): void;
}

const DEFAULT_LOCK_MS = JUDGE_LEASE_SECONDS * 1000;
const DEFAULT_TICK_MS = 250;

/**
 * Drives the policy against real BullMQ queues with manual job fetching. One
 * Worker per served lane (no processor, autorun off); a central fill loop
 * acquires a slot, asks the policy for a lane, fetches one job from that lane,
 * and processes it — extending the job lock while it runs and completing or
 * failing it with the worker token, so a node never holds a job it has no slot
 * for and BullMQ's retry/backoff still governs infrastructure failures.
 */
export class LaneAllocator {
  private readonly workers = new Map<JudgeLane, Worker<JudgeJobData, ProcessOutcome>>();
  private readonly queues = new Map<JudgeLane, Queue>();
  private readonly busy = zeroBusy();
  private readonly waiting = zeroBusy();
  private readonly lastActiveAt = zeroBusy();
  private readonly served: JudgeLane[];
  private readonly token: string;
  private readonly lockDurationMs: number;
  private readonly tickMs: number;
  private allowed: JudgeLane[] = [];
  private running = false;
  private draining = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private depthsAt = 0;

  constructor(private readonly options: LaneAllocatorOptions) {
    this.served = servedLanes(options.queues);
    this.token = `${options.deps.nodeId}:${Math.random().toString(36).slice(2, 10)}`;
    this.lockDurationMs = options.lockDurationMs ?? DEFAULT_LOCK_MS;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    for (const lane of this.served) {
      const worker = new Worker<JudgeJobData, ProcessOutcome>(QUEUE_NAME[lane], null, {
        connection: options.connection,
        autorun: false,
        lockDuration: this.lockDurationMs,
      });
      worker.on("error", (err) => options.logger.debug({ lane, err: errorMessage(err) }, "lane worker error"));
      this.workers.set(lane, worker);
      this.queues.set(lane, new Queue(QUEUE_NAME[lane], { connection: options.connection }));
    }
    // A rejudge-serving node that does not serve assessment still needs the
    // assessment depth for the rejudge pause.
    if (this.served.includes("REJUDGE") && !this.queues.has("ASSESSMENT")) {
      this.queues.set("ASSESSMENT", new Queue(QUEUE_NAME.ASSESSMENT, { connection: options.connection }));
    }
  }

  /** Lanes the node actually fetches from: served ∩ heartbeat-allowed. */
  private intakeLanes(): JudgeLane[] {
    const allowed = new Set(this.allowed);
    return this.served.filter((lane) => allowed.has(lane));
  }

  /** Called from the heartbeat loop with the latest allowed lanes. */
  setAllowedLanes(lanes: readonly JudgeLane[]): void {
    this.allowed = [...lanes];
    if (this.running) this.scheduleTick();
  }

  start(): void {
    if (this.running || this.draining) return;
    this.running = true;
    this.options.logger.info({ served: this.served, token: this.token }, "lane allocator started");
    for (const worker of this.workers.values()) void worker.startStalledCheckTimer();
    this.scheduleTick();
    this.timer = setInterval(() => this.scheduleTick(), this.tickMs);
  }

  private scheduleTick(): void {
    if (!this.running || this.ticking) return;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.running) return;
    this.ticking = true;
    try {
      await this.refreshDepths();
      // Fill every free slot the policy will give us.
      for (;;) {
        if (!this.running || this.options.deps.signal?.aborted) break;
        const lane = pickLane(this.policyState());
        if (lane === null) break;
        const pulled = await this.pullOne(lane);
        if (!pulled) {
          // The queue was emptier than our depth estimate: stop offering it this tick.
          this.waiting[lane] = 0;
        }
      }
    } catch (error) {
      this.options.logger.debug({ err: errorMessage(error) }, "allocator tick error");
    } finally {
      this.ticking = false;
    }
  }

  private policyState(): AllocatorPolicyState {
    return {
      slots: this.options.slots.size,
      allowedLanes: this.intakeLanes(),
      busy: { ...this.busy },
      waiting: { ...this.waiting },
      lastActiveAt: { ...this.lastActiveAt },
      assessmentDepth: this.waiting.ASSESSMENT,
      now: Date.now(),
    };
  }

  private async refreshDepths(): Promise<void> {
    const now = Date.now();
    if (now - this.depthsAt < this.tickMs) return;
    this.depthsAt = now;
    const lanes = new Set<JudgeLane>(this.intakeLanes());
    if (this.served.includes("REJUDGE")) lanes.add("ASSESSMENT"); // for the pause check
    await Promise.all(
      [...lanes].map(async (lane) => {
        const queue = this.queues.get(lane);
        if (!queue) return;
        try {
          const counts = await queue.getJobCounts("wait", "prioritized", "delayed");
          this.waiting[lane] = (counts.wait ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0);
        } catch (error) {
          this.options.logger.debug({ lane, err: errorMessage(error) }, "queue depth refresh failed");
        }
      }),
    );
  }

  /** Acquire a slot, fetch one job from `lane`, and process it. Returns false if the queue was empty. */
  private async pullOne(lane: JudgeLane): Promise<boolean> {
    const worker = this.workers.get(lane);
    if (!worker) return false;
    // Reserve the slot-count optimistically so the next pickLane in this loop
    // sees the lane as busy; the real SlotPool index is acquired below.
    this.busy[lane] += 1;
    let job: Job<JudgeJobData, ProcessOutcome> | undefined;
    try {
      job = await worker.getNextJob(this.token, { block: false });
    } catch (error) {
      this.busy[lane] -= 1;
      if (error instanceof ProtocolMismatchError) this.options.onProtocolMismatch(error);
      else this.options.logger.debug({ lane, err: errorMessage(error) }, "getNextJob failed");
      return false;
    }
    if (!job) {
      this.busy[lane] -= 1;
      return false;
    }
    this.lastActiveAt[lane] = Date.now();
    if (this.waiting[lane] > 0) this.waiting[lane] -= 1;
    void this.runJob(lane, worker, job);
    return true;
  }

  private async runJob(
    lane: JudgeLane,
    worker: Worker<JudgeJobData, ProcessOutcome>,
    job: Job<JudgeJobData, ProcessOutcome>,
  ): Promise<void> {
    const token = job.token ?? this.token;
    const renew = setInterval(() => {
      job.extendLock(token, this.lockDurationMs).catch((err: unknown) =>
        this.options.logger.debug({ lane, jobId: job.id, err: errorMessage(err) }, "extendLock failed"),
      );
    }, Math.max(1_000, Math.floor(this.lockDurationMs / 2)));
    try {
      const outcome = await processJob(job.data, this.options.deps);
      await job.moveToCompleted(outcome, token, false);
    } catch (error) {
      if (error instanceof ProtocolMismatchError) {
        this.options.onProtocolMismatch(error);
        return;
      }
      // Infrastructure failure: let BullMQ apply the retry/backoff set by the
      // enqueuer. processJob has already released the lease for a clean retry.
      try {
        await job.moveToFailed(error instanceof Error ? error : new UnrecoverableError(String(error)), token, false);
      } catch (failErr) {
        this.options.logger.debug({ lane, jobId: job.id, err: errorMessage(failErr) }, "moveToFailed failed");
      }
    } finally {
      clearInterval(renew);
      this.busy[lane] -= 1;
      this.lastActiveAt[lane] = Date.now();
      this.scheduleTick();
    }
  }

  get busyByLane(): LaneBusy {
    return { ...this.busy };
  }

  /** Stop fetching new jobs; in-flight jobs keep running (the caller drains them). */
  pause(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  resume(): void {
    if (this.draining) return;
    if (!this.running) this.start();
  }

  async close(): Promise<void> {
    this.draining = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([
      ...[...this.workers.values()].map((w) => w.close()),
      ...[...this.queues.values()].map((q) => q.close()),
    ]);
  }
}
