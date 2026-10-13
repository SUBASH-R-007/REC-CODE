/**
 * The pure half of the synthetic capacity burst (scripts/load/burst.ts):
 * option parsing, the target safety check, the lane mix, the arrival
 * schedule, the row plan, and every statistic in the report. No I/O here, so
 * all of it is unit-tested (burst-plan.test.ts) and a --dry-run prints
 * exactly the rows a real run would insert.
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { JUDGE_LANES, LANE_ALLOCATION, type JudgeLane } from "../../packages/shared/src/index";

/**
 * scripts/load is not a workspace package (no dependencies of its own), so
 * third-party packages are loaded through apps/web's dependency tree. The
 * types come from tsconfig "paths" (scripts/load/tsconfig.json).
 */
export const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { z } = webRequire("zod") as typeof import("zod");

// ── Options ─────────────────────────────────────────────────────────────

/** Lanes a burst can generate: all five. RUN rows are RunRequests (the editor's Run button). */
export const BURST_LANES = JUDGE_LANES;
export type BurstLane = JudgeLane;
export type LaneMix = Readonly<Record<BurstLane, number>>;

export const DEFAULT_MIX: LaneMix = { ASSESSMENT: 15, CONTEST: 15, PRACTICE: 45, RUN: 25, REJUDGE: 0 };

export type ArrivalProfile = { kind: "uniform"; spreadMs: number } | { kind: "instant" };

export interface BurstOptions {
  count: number;
  mix: LaneMix;
  arrival: ArrivalProfile;
  /** Language keys to use; null = every enabled language that has an AC model solution. */
  languages: string[] | null;
  seed: number;
  timeoutMs: number;
  pollMs: number;
  /** PRACTICE counts as starved after waiting this long while a usable slot sat free. */
  starvationThresholdMs: number;
  /** Override the fleet size (default: the slots of the ONLINE judge nodes). */
  slots: number | null;
  /** Insert concurrency (rows being written / enqueued at once). */
  concurrency: number;
  json: string | null;
  markdown: boolean;
  dryRun: boolean;
  /** Delete the finished rows of an earlier burst (its run id) and exit. */
  cleanup: string | null;
}

export const USAGE = `Synthetic judge capacity burst (development only).

  cd apps/web
  npx tsx ../../scripts/load/burst.ts [options]

Options:
  --count N                 jobs to generate (default 200)
  --mix L=P,...             lane percentages summing to 100; lanes assessment, contest,
                            practice, run, rejudge (default assessment=15,contest=15,practice=45,run=25)
  --spread SECONDS          arrivals spread uniformly over this many seconds (default 60)
  --instant                 every job arrives at once (overrides --spread)
  --languages a,b           only these language keys (default: every enabled language
                            with an AC model solution)
  --seed N                  shuffle seed, for a reproducible plan (default 1)
  --timeout SECONDS         stop waiting after this long (default 900)
  --poll-ms N               completion poll interval (default 1000)
  --starvation-threshold-ms N
                            PRACTICE is "starved" after waiting this long while a
                            usable slot was free (default 5000)
  --slots N                 fleet slots for the starvation analysis (default: ONLINE nodes)
  --concurrency N           rows inserted / enqueued at once (default 16)
  --json FILE               also write the full report as JSON
  --markdown                also print the report as a Markdown table (docs/CAPACITY.md)
  --dry-run                 print the plan; write nothing, enqueue nothing
  --cleanup RUN_ID          delete the finished rows of an earlier burst and exit

Refuses to run with NODE_ENV=production or when DATABASE_URL / REDIS_URL point
anywhere but this machine. Rows are written directly (bypassing the per-user
caps); the judged rows still count toward the seeded students' daily usage.`;

const laneSchema = z.enum(BURST_LANES);

const optionsSchema = z
  .object({
    count: z.coerce.number().int().min(1).max(20_000).default(200),
    mix: z.string().default("assessment=15,contest=15,practice=45,run=25"),
    spread: z.coerce.number().min(0).max(3_600).default(60),
    instant: z.boolean().default(false),
    languages: z.string().optional(),
    seed: z.coerce.number().int().min(0).max(2 ** 32 - 1).default(1),
    timeout: z.coerce.number().int().min(10).max(24 * 3_600).default(900),
    "poll-ms": z.coerce.number().int().min(100).max(60_000).default(1_000),
    "starvation-threshold-ms": z.coerce.number().int().min(0).max(600_000).default(5_000),
    slots: z.coerce.number().int().min(1).max(10_000).optional(),
    concurrency: z.coerce.number().int().min(1).max(128).default(16),
    json: z.string().min(1).optional(),
    markdown: z.boolean().default(false),
    "dry-run": z.boolean().default(false),
    cleanup: z
      .string()
      .regex(/^[0-9]{8}T[0-9]{6}-[0-9a-f]{6}$/, "--cleanup takes a run id printed by an earlier burst")
      .optional(),
    help: z.boolean().default(false),
  })
  .strict();

const BOOLEAN_FLAGS = new Set(["instant", "markdown", "dry-run", "help"]);

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * A list option: comma- or space-separated. Spaces too, because PowerShell
 * turns an unquoted a,b,c into an array and passes it as "a b c".
 */
export function splitList(raw: string): string[] {
  return raw.split(/[\s,]+/).filter(Boolean);
}

/** "assessment=15,contest=15,practice=45,run=25" → a mix (missing lanes 0; must total 100). */
export function parseMix(raw: string): LaneMix {
  const mix: Record<BurstLane, number> = { ASSESSMENT: 0, CONTEST: 0, PRACTICE: 0, RUN: 0, REJUDGE: 0 };
  for (const part of splitList(raw)) {
    const m = /^([a-zA-Z]+)=(\d+(?:\.\d+)?)$/.exec(part);
    if (!m) throw new UsageError(`--mix: "${part}" is not lane=percent`);
    const lane = laneSchema.safeParse(m[1]!.toUpperCase());
    if (!lane.success) throw new UsageError(`--mix: unknown lane "${m[1]}" (lanes: ${BURST_LANES.join(", ").toLowerCase()})`);
    mix[lane.data] += Number(m[2]);
  }
  const total = BURST_LANES.reduce((sum, lane) => sum + mix[lane], 0);
  if (Math.abs(total - 100) > 1e-9) throw new UsageError(`--mix must total 100 (got ${total})`);
  return mix;
}

/** argv (after the script name) → validated options. */
export function parseBurstArgs(argv: readonly string[]): BurstOptions & { help: boolean } {
  const raw: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(arg);
    if (!m) throw new UsageError(`unexpected argument "${arg}"`);
    const key = m[1]!;
    if (BOOLEAN_FLAGS.has(key)) {
      if (m[2] !== undefined) throw new UsageError(`--${key} takes no value`);
      raw[key] = true;
    } else if (m[2] !== undefined) {
      raw[key] = m[2];
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${key} needs a value`);
      raw[key] = value;
      i++;
    }
  }
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length > 0 ? `--${issue.path.join(".")}` : "options";
    throw new UsageError(issue.code === "unrecognized_keys" ? `unknown option(s): ${issue.keys.map((k) => `--${k}`).join(", ")}` : `${where}: ${issue.message}`);
  }
  const o = parsed.data;
  return {
    count: o.count,
    mix: parseMix(o.mix),
    arrival: o.instant ? { kind: "instant" } : { kind: "uniform", spreadMs: Math.round(o.spread * 1000) },
    languages: o.languages ? splitList(o.languages) : null,
    seed: o.seed,
    timeoutMs: o.timeout * 1000,
    pollMs: o["poll-ms"],
    starvationThresholdMs: o["starvation-threshold-ms"],
    slots: o.slots ?? null,
    concurrency: o.concurrency,
    json: o.json ?? null,
    markdown: o.markdown,
    dryRun: o["dry-run"],
    cleanup: o.cleanup ?? null,
    help: o.help,
  };
}

// ── Target safety ───────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const targetEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string({ required_error: "DATABASE_URL is not set (apps/web/.env.local)" }).min(1),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),
});

function hostOf(url: string, name: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new UsageError(`${name} is not a valid URL`);
  }
}

/**
 * A burst is a test harness that writes rows directly and bypasses the
 * per-user caps: it refuses production and anything but a local database and
 * a local Redis. URLs are never echoed (they hold credentials).
 */
export function assertSafeTarget(env: Readonly<Record<string, string | undefined>>): { databaseUrl: string; redisUrl: string } {
  const parsed = targetEnvSchema.safeParse(env);
  if (!parsed.success) throw new UsageError(parsed.error.issues[0]!.message);
  const { NODE_ENV, DATABASE_URL, REDIS_URL } = parsed.data;
  if (NODE_ENV === "production") throw new UsageError("refusing to run with NODE_ENV=production");
  const dbHost = hostOf(DATABASE_URL, "DATABASE_URL");
  if (!LOCAL_HOSTS.has(dbHost)) throw new UsageError(`refusing: DATABASE_URL points at "${dbHost}", not this machine`);
  const redisHost = hostOf(REDIS_URL, "REDIS_URL");
  if (!LOCAL_HOSTS.has(redisHost)) throw new UsageError(`refusing: REDIS_URL points at "${redisHost}", not this machine`);
  return { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL };
}

// ── The plan ────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) so a seed reproduces a plan exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Exact per-lane counts for `count` jobs (largest-remainder rounding, ties in lane order). */
export function laneCounts(count: number, mix: LaneMix): Record<BurstLane, number> {
  const exact = BURST_LANES.map((lane) => ({ lane, value: (count * mix[lane]) / 100 }));
  const counts = Object.fromEntries(exact.map(({ lane, value }) => [lane, Math.floor(value)])) as Record<BurstLane, number>;
  let remainder = count - BURST_LANES.reduce((sum, lane) => sum + counts[lane], 0);
  const byFraction = [...exact].sort((a, b) => b.value - Math.floor(b.value) - (a.value - Math.floor(a.value)));
  for (const { lane } of byFraction) {
    if (remainder <= 0) break;
    if (mix[lane] === 0) continue;
    counts[lane]++;
    remainder--;
  }
  return counts;
}

/** Arrival offset (ms after the start) of job i of n. */
export function arrivalOffsetMs(i: number, n: number, arrival: ArrivalProfile): number {
  return arrival.kind === "instant" ? 0 : Math.floor((i * arrival.spreadMs) / n);
}

export interface BurstStudent {
  id: string;
  collegeId: string;
}

/** A published problem version + a language with an AC model solution in it. */
export interface BurstCandidate {
  problemId: string;
  slug: string;
  versionId: string;
  language: string;
  languageConfigId: string;
  /** The model solution's source (expectedVerdict AC). */
  source: string;
  totalCases: number;
  sampleCount: number;
}

export interface BurstFixtures {
  students: readonly BurstStudent[];
  candidates: readonly BurstCandidate[];
}

export type SubmissionOrigin = "PRACTICE" | "CONTEST" | "ASSESSMENT";

export interface PlannedJob {
  seq: number;
  lane: BurstLane;
  kind: "submission" | "run";
  /** Submission.origin; null for a RunRequest. */
  origin: SubmissionOrigin | null;
  userId: string;
  candidate: BurstCandidate;
  /** The model solution plus a trailing marker comment naming the run. */
  source: string;
  offsetMs: number;
}

const ORIGIN: Readonly<Record<Exclude<BurstLane, "RUN">, SubmissionOrigin>> = {
  ASSESSMENT: "ASSESSMENT",
  CONTEST: "CONTEST",
  PRACTICE: "PRACTICE",
  // A rejudge re-judges a practice submission.
  REJUDGE: "PRACTICE",
};

/** "20261010T081500-a1b2c3": sortable, and greppable in the sources it marks. */
export function newRunId(now: Date = new Date(), random: string = randomBytes(3).toString("hex")): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return `${stamp}-${random}`;
}

export function burstMarker(runId: string): string {
  return `recx-burst:${runId}`;
}

const HASH_COMMENT_LANGUAGES = new Set(["py312", "pypy310"]);

/** Append "// recx-burst:<run> #<seq>" (or "# …" for Python): harmless to every language, unique per job. */
export function withBurstMarker(source: string, language: string, runId: string, seq: number): string {
  const prefix = HASH_COMMENT_LANGUAGES.has(language) ? "#" : "//";
  return `${source.replace(/\s*$/, "")}\n${prefix} ${burstMarker(runId)} #${seq}\n`;
}

/** Every row a burst will insert, in arrival order. Pure and deterministic for (options, fixtures, runId). */
export function planBurst(
  options: Pick<BurstOptions, "count" | "mix" | "arrival" | "seed">,
  fixtures: BurstFixtures,
  runId: string,
): PlannedJob[] {
  if (fixtures.students.length === 0) throw new UsageError("no ACTIVE students in the database: run the seed first");
  if (fixtures.candidates.length === 0) {
    throw new UsageError("no published problem has an AC model solution in an enabled language: run the seed first");
  }
  const counts = laneCounts(options.count, options.mix);
  const runnable = fixtures.candidates.filter((c) => c.sampleCount > 0);
  if (counts.RUN > 0 && runnable.length === 0) throw new UsageError("RUN jobs need a problem with sample tests");

  const rand = mulberry32(options.seed);
  const lanes: BurstLane[] = BURST_LANES.flatMap((lane) => Array<BurstLane>(counts[lane]).fill(lane));
  for (let i = lanes.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [lanes[i], lanes[j]] = [lanes[j]!, lanes[i]!];
  }

  const students = [...fixtures.students].sort((a, b) => a.collegeId.localeCompare(b.collegeId));
  return lanes.map((lane, seq) => {
    const pool = lane === "RUN" ? runnable : fixtures.candidates;
    const candidate = pool[Math.floor(rand() * pool.length)]!;
    return {
      seq,
      lane,
      kind: lane === "RUN" ? "run" : "submission",
      origin: lane === "RUN" ? null : ORIGIN[lane],
      userId: students[seq % students.length]!.id,
      candidate,
      source: withBurstMarker(candidate.source, candidate.language, runId, seq),
      offsetMs: arrivalOffsetMs(seq, lanes.length, options.arrival),
    };
  });
}

// ── Statistics ──────────────────────────────────────────────────────────

/** Nearest-rank percentile of ascending-sorted values (null when empty). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/** One judged (or still unjudged) job, all times in ms on the harness's clock. */
export interface JobOutcome {
  seq: number;
  lane: BurstLane;
  queuedAt: number;
  /** When a node started it (claim / fetch); null if never started. */
  startedAt: number | null;
  /** When the result was stored; null if not finished. */
  judgedAt: number | null;
  verdict: string | null;
  status: string;
}

const TERMINAL = new Set(["DONE", "INTERNAL_ERROR", "CANCELLED"]);

export interface Distribution {
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1]! : null,
    mean: sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : null,
  };
}

export interface LaneReport {
  lane: BurstLane;
  count: number;
  finished: number;
  /** startedAt − queuedAt. */
  waitMs: Distribution;
  /** judgedAt − startedAt: slot time per job. */
  serviceMs: Distribution;
  /** judgedAt − queuedAt. */
  endToEndMs: Distribution;
  verdicts: Record<string, number>;
  internalErrors: number;
}

export function laneReports(outcomes: readonly JobOutcome[]): LaneReport[] {
  return BURST_LANES.map((lane) => {
    const jobs = outcomes.filter((o) => o.lane === lane);
    const finished = jobs.filter((o) => TERMINAL.has(o.status));
    const verdicts: Record<string, number> = {};
    for (const job of finished) {
      const key = job.verdict ?? job.status;
      verdicts[key] = (verdicts[key] ?? 0) + 1;
    }
    return {
      lane,
      count: jobs.length,
      finished: finished.length,
      waitMs: distribution(jobs.flatMap((o) => (o.startedAt === null ? [] : [Math.max(0, o.startedAt - o.queuedAt)]))),
      serviceMs: distribution(
        finished.flatMap((o) => (o.startedAt === null || o.judgedAt === null ? [] : [Math.max(0, o.judgedAt - o.startedAt)])),
      ),
      endToEndMs: distribution(finished.flatMap((o) => (o.judgedAt === null ? [] : [Math.max(0, o.judgedAt - o.queuedAt)]))),
      verdicts,
      internalErrors: finished.filter((o) => o.verdict === "IE" || o.status === "INTERNAL_ERROR").length,
    };
  }).filter((r) => r.count > 0);
}

/**
 * RUN's hard reservation across the fleet, by the worker allocator's rule
 * (apps/judge-worker/src/allocator.ts, runReservedSlots): 2 slots per node
 * (LANE_ALLOCATION.RUN.hardReservedSlots), 1 on a node with fewer than 3,
 * and never a node's last slot when it also serves other lanes.
 */
export function fleetRunReserve(nodeSlots: readonly number[]): number {
  return nodeSlots.reduce((sum, slots) => {
    if (slots < 1) return sum;
    const raw = slots < 3 ? 1 : LANE_ALLOCATION.RUN.hardReservedSlots;
    return sum + Math.min(raw, Math.max(0, slots - 1));
  }, 0);
}

export interface StarvationReport {
  practiceJobs: number;
  /** Longest stretch in which a PRACTICE job waited while any slot was idle. */
  maxWaitWhileAnySlotFreeMs: number;
  /** …while a slot PRACTICE may use (not RUN's hard reservation) was idle. */
  maxWaitWhileUsableSlotFreeMs: number;
  thresholdMs: number;
  starved: boolean;
}

/**
 * Was PRACTICE ever starved? A sweep over the burst's own jobs: between any
 * two events the number of running jobs is constant; a PRACTICE job waiting
 * through a stretch in which a slot it may use sat idle is starvation once
 * the stretch exceeds the threshold (which absorbs the 2 s soft-reservation
 * release, claim latency and clock error). Only the burst's jobs are seen:
 * other load on the fleet during the run makes slots look freer than they were.
 */
export function practiceStarvation(
  outcomes: readonly JobOutcome[],
  fleet: { slots: number; runReserved: number },
  thresholdMs: number,
  endAt: number,
): StarvationReport {
  type Ev = { t: number; running: number; runRunning: number; practiceWaiting: number };
  const events: Ev[] = [];
  for (const o of outcomes) {
    const isPractice = o.lane === "PRACTICE";
    const isRun = o.lane === "RUN";
    if (isPractice) events.push({ t: o.queuedAt, running: 0, runRunning: 0, practiceWaiting: 1 });
    if (o.startedAt !== null) {
      events.push({ t: o.startedAt, running: 1, runRunning: isRun ? 1 : 0, practiceWaiting: isPractice ? -1 : 0 });
      if (o.judgedAt !== null) events.push({ t: o.judgedAt, running: -1, runRunning: isRun ? -1 : 0, practiceWaiting: 0 });
    }
  }
  events.sort((a, b) => a.t - b.t);

  let running = 0;
  let runRunning = 0;
  let waiting = 0;
  let anyStretch = 0;
  let usableStretch = 0;
  let maxAny = 0;
  let maxUsable = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    running += ev.running;
    runRunning += ev.runRunning;
    waiting += ev.practiceWaiting;
    const next = i + 1 < events.length ? events[i + 1]!.t : Math.max(endAt, ev.t);
    const span = next - ev.t;
    if (span <= 0) continue; // apply every event at one instant before measuring
    const freeAny = fleet.slots - running;
    const freeUsable = freeAny - Math.max(0, fleet.runReserved - runRunning);
    anyStretch = waiting > 0 && freeAny > 0 ? anyStretch + span : 0;
    usableStretch = waiting > 0 && freeUsable > 0 ? usableStretch + span : 0;
    maxAny = Math.max(maxAny, anyStretch);
    maxUsable = Math.max(maxUsable, usableStretch);
  }
  return {
    practiceJobs: outcomes.filter((o) => o.lane === "PRACTICE").length,
    maxWaitWhileAnySlotFreeMs: maxAny,
    maxWaitWhileUsableSlotFreeMs: maxUsable,
    thresholdMs,
    starved: maxUsable > thresholdMs,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────

export function fmtMs(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function verdictText(v: Record<string, number>): string {
  return Object.entries(v)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

export function laneTable(reports: readonly LaneReport[]): string {
  const header = ["LANE", "JOBS", "DONE", "WAIT p50", "p95", "max", "SERVICE p50", "mean", "E2E p95", "IE", "VERDICTS"];
  const rows = reports.map((r) => [
    r.lane,
    String(r.count),
    String(r.finished),
    fmtMs(r.waitMs.p50),
    fmtMs(r.waitMs.p95),
    fmtMs(r.waitMs.max),
    fmtMs(r.serviceMs.p50),
    fmtMs(r.serviceMs.mean),
    fmtMs(r.endToEndMs.p95),
    String(r.internalErrors),
    verdictText(r.verdicts),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  return [header, ...rows].map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

export function laneMarkdown(reports: readonly LaneReport[]): string {
  const lines = [
    "| Lane | Jobs | Done | Wait p50 | Wait p95 | Wait max | Service p50 | Service mean | End-to-end p95 | IE | Verdicts |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of reports) {
    lines.push(
      `| ${r.lane} | ${r.count} | ${r.finished} | ${fmtMs(r.waitMs.p50)} | ${fmtMs(r.waitMs.p95)} | ${fmtMs(r.waitMs.max)} | ` +
        `${fmtMs(r.serviceMs.p50)} | ${fmtMs(r.serviceMs.mean)} | ${fmtMs(r.endToEndMs.p95)} | ${r.internalErrors} | ${verdictText(r.verdicts)} |`,
    );
  }
  return lines.join("\n");
}
