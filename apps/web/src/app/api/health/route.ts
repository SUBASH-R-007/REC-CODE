import { readdirSync } from "node:fs";
import path from "node:path";
import type { HealthReport } from "@recx/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

/**
 * `GET /api/health` (Phase 10a).
 *
 * Unauthenticated, and it says nothing a visitor could not infer: no names,
 * no ids, no slugs. `activeContests` is a COUNT, because an operator needs to
 * know whether something is running and a stranger must not learn which.
 *
 * **It answers 200 even when it is not ok.** A health endpoint that returns
 * 500 tells a load balancer to stop asking and tells a deploy script nothing
 * it can act on. The status code says "I answered"; the body says what is
 * wrong, and the deploy gate reads the body.
 *
 * `activeContest` is here, on a health endpoint, because the deploy job needs
 * exactly one call: SPEC §10 blocks a deploy while a contest or an assessment
 * is live unless `FORCE_DEPLOY=1`. It is a scheduling fact rather than a
 * health fact, and saying so in a comment is cheaper than somebody later
 * "tidying" it onto a second endpoint the deploy script does not call.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "content-type": "application/json", "cache-control": "no-store" } as const;

/** Every check is independently timed out: a hung dependency must not hang the probe. */
async function within<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Is Redis answering?
 *
 * The client is created with `enableOfflineQueue: false`, so a command
 * issued while it is still connecting rejects IMMEDIATELY rather than
 * waiting — which made the first call to this endpoint after a restart
 * report a healthy Redis as "down". Found by reading the live response, not
 * by a test, because a test would have had a warm client.
 *
 * So: wait for `ready` if it is still connecting, then ping. The outer
 * timeout still bounds the whole thing, so a Redis that never becomes ready
 * is reported down rather than hanging the probe.
 */
async function pingRedis(): Promise<"up" | "down"> {
  try {
    const client = redis();
    if (client.status !== "ready") {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          client.off("ready", onReady);
          client.off("error", onError);
        };
        client.once("ready", onReady);
        client.once("error", onError);
      });
    }
    return (await client.ping()) === "PONG" ? "up" : "down";
  } catch {
    return "down";
  }
}

export async function GET(): Promise<Response> {
  const now = new Date();

  const dbState = await within<"up" | "down">(
    2000,
    db
      .$queryRawUnsafe("SELECT 1")
      .then(() => "up" as const)
      .catch(() => "down" as const),
    "down",
  );

  const redisState = await within<"up" | "down">(2000, pingRedis(), "down");

  /**
   * Live now, by the clock, not by a status column: a contest whose window
   * is open is live whether or not a job has got around to updating it, and
   * a deploy during that window is the thing being prevented.
   */
  const live =
    dbState === "up"
      ? await within(
          2000,
          Promise.all([
            db.contest.count({ where: { startsAt: { lte: now }, endsAt: { gt: now } } }),
            db.assessment.count({
              where: { status: { in: ["PUBLISHED", "OPEN"] }, opensAt: { lte: now }, closesAt: { gt: now } },
            }),
          ]).catch(() => [0, 0] as [number, number]),
          [0, 0] as [number, number],
        )
      : ([0, 0] as [number, number]);

  const migrations = dbState === "up" ? await migrationState() : "unknown";

  const report: HealthReport = {
    ok: dbState === "up" && redisState === "up" && migrations === "current",
    version: process.env.RECX_VERSION ?? "dev",
    db: dbState,
    redis: redisState,
    migrations,
    activeContest: live[0] > 0,
    activeAssessment: live[1] > 0,
    activeContests: live[0],
    activeAssessments: live[1],
  };

  return new Response(JSON.stringify(report), { status: 200, headers: NO_STORE });
}

/**
 * Does the database hold every migration this image carries?
 *
 * The one number that explains "the code is deployed but the page is broken".
 * Compares counts of applied-and-successful rows against the image's
 * migration folder — `behind` means a supervised migration step has not run,
 * which under SPEC §10's expand/contract rule is a normal state during a
 * deploy rather than an error.
 */
async function migrationState(): Promise<HealthReport["migrations"]> {
  try {
    const dir = path.join(process.cwd(), "..", "..", "packages", "db", "prisma", "migrations");
    const onDisk = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
    const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
    );
    const applied = Number(rows[0]?.n ?? 0);
    if (applied === onDisk) return "current";
    return applied < onDisk ? "behind" : "unknown";
  } catch {
    // A packaged image may not ship the migrations folder; that is not a
    // failure, it is an unknown, and the operator reads it as one.
    return "unknown";
  }
}
