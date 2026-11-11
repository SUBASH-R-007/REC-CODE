import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import {
  SEB_CONFIG_KEY_HEADER,
  SEB_REQUEST_HASH_HEADER,
  matchesAnyCidr,
  sebUrlFor,
  verifySeb,
  type ProctorMode,
  type SebVerdict,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { noteExamBrowserSeen, verifyExamBrowserRequest } from "@/lib/exam/exam-browser";
import { EXAM_BROWSER_SETTING_KEY, versionFloorOf } from "@/lib/exam/exam-browser-setting";
import { requestIp } from "@/lib/ip";

/**
 * Hall containment (Phase 6d): the network allowlist and Safe Exam Browser.
 *
 * SPEC §5 on what these are worth, which is the honest framing the product
 * uses everywhere:
 *
 *   IP/CIDR allowlisting is defeated by a VPN or hotspot outside a lab;
 *   inside a lab it usefully detects a candidate who has left the supervised
 *   network.
 *
 *   Server-side key verification is the part most deployments skip and the
 *   part that matters.
 *
 * So neither claims to stop anything. Together with a physical invigilator
 * they raise the cost of sitting an exam from somewhere you should not be,
 * and that is all they are sold as (docs/PROCTORING.md).
 *
 * The allowlist is re-checked on EVERY heartbeat, not only at start, "so
 * leaving the lab network ends the session". The one asymmetry worth knowing:
 * a candidate who starts inside the hall and then leaves it is stopped, and a
 * candidate who was never in it never starts.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export type ContainmentRefusal = "outside_allowlist" | "seb_required" | "recx_browser_required";

export interface ContainmentResult {
  readonly ok: boolean;
  readonly refusal?: ContainmentRefusal;
  readonly message?: string;
  /**
   * Allowlist entries that are not CIDR blocks. A misconfiguration an
   * invigilator has to see, never a reason to refuse a candidate.
   */
  readonly invalidCidrs: readonly string[];
  /** True when no allowlist is configured, so there was nothing to check. */
  readonly networkUnrestricted: boolean;
}

const ok = (over: Partial<ContainmentResult> = {}): ContainmentResult => ({
  ok: true,
  invalidCidrs: [],
  networkUnrestricted: false,
  ...over,
});

/**
 * Check this request against the hall's network allowlist and, for a kiosk
 * assessment, against the SEB keys.
 *
 * Called from the attempt guard, so it runs on the heartbeat, on every
 * telemetry flush, on every snapshot and on submit — which is what makes
 * "leaving the lab network ends the session" true rather than a start-time
 * formality.
 */
export async function checkContainment(args: {
  readonly request: Request;
  readonly attempt: {
    readonly id: string;
    readonly userId: string;
    readonly assessmentId: string;
    readonly examSessionId: string | null;
    readonly proctorMode: string;
    /** The REC Exam Browser sitting, for KIOSK_RECX. Null for every other mode. */
    readonly examBrowserSittingId?: string | null;
  };
  /** False on the heartbeat path, so a refusal is not audited 360 times an hour. */
  readonly audited?: boolean;
}): Promise<ContainmentResult> {
  const mode = args.attempt.proctorMode as ProctorMode;

  // ── The hall's network ─────────────────────────────────────────────────
  let invalidCidrs: readonly string[] = [];
  let networkUnrestricted = true;
  if (mode === "LAB_SUPERVISED" && args.attempt.examSessionId !== null) {
    const session = await db.examSession.findUnique({
      where: { id: args.attempt.examSessionId },
      select: { allowedCidrs: true, label: true },
    });
    const result = matchesAnyCidr(await requestIp(), session?.allowedCidrs ?? []);
    invalidCidrs = result.invalid;
    networkUnrestricted = result.empty;
    if (result.invalid.length > 0) {
      console.error(
        `[exam] exam session ${args.attempt.examSessionId} has ${result.invalid.length} unparseable allowlist entries`,
        result.invalid.slice(0, 5),
      );
    }
    if (!result.allowed) {
      if (args.audited !== false) {
        await audit({
          actorId: null,
          action: "assessment.attempt.outside_allowlist",
          entityType: "AssessmentAttempt",
          entityId: args.attempt.id,
          targetUserId: args.attempt.userId,
          sensitivity: "SECURITY",
          metadata: {
            examSessionId: args.attempt.examSessionId,
            // The hall's blocks, never the candidate's address: SPEC §4
            // forbids a raw IP anywhere, and the attempt already stores the
            // hash.
            allowedCidrs: (session?.allowedCidrs ?? []).slice(0, 10),
          },
        });
      }
      return {
        ok: false,
        refusal: "outside_allowlist",
        message:
          "This assessment can only be sat from the exam hall network. Tell your invigilator — if you are in the hall, the network has changed.",
        invalidCidrs,
        networkUnrestricted: false,
      };
    }
  }

  // ── Safe Exam Browser ──────────────────────────────────────────────────
  if (mode === "KIOSK_SEB") {
    const verdict = await verifySebRequest(args.request, args.attempt.examSessionId);
    if (!verdict.ok) {
      if (args.audited !== false) {
        await audit({
          actorId: null,
          action: "assessment.attempt.seb_refused",
          entityType: "AssessmentAttempt",
          entityId: args.attempt.id,
          targetUserId: args.attempt.userId,
          sensitivity: "SECURITY",
          metadata: { refusal: verdict.refusal, examSessionId: args.attempt.examSessionId },
        });
      }
      return { ok: false, refusal: "seb_required", message: verdict.message, invalidCidrs, networkUnrestricted };
    }
  }

  // ── REC Exam Browser ───────────────────────────────────────────────────
  if (mode === "KIOSK_RECX") {
    /**
     * The expected sitting comes from the ATTEMPT, never from the request.
     * A signature that verifies under some sitting proves only that a
     * holder of some key signed it; the question is whether this attempt's
     * browser did. Reading it off the attempt also means the hot path
     * loads no extra row — `guardAttempt` already has this one — and that
     * clearing the column is what revokes a sitting, which is how
     * `endExamBrowserSitting` ends one.
     */
    const verdict = await verifyExamBrowserRequest({
      request: args.request,
      absoluteUrl: args.request.url,
      expectedSittingId: args.attempt.examBrowserSittingId ?? null,
      versionFloor: await examBrowserVersionFloor(),
    });
    if (!verdict.ok) {
      if (args.audited !== false) {
        await audit({
          actorId: null,
          action: "assessment.attempt.exam_browser_refused",
          entityType: "AssessmentAttempt",
          entityId: args.attempt.id,
          targetUserId: args.attempt.userId,
          sensitivity: "SECURITY",
          metadata: { refusal: verdict.refusal, examSessionId: args.attempt.examSessionId },
        });
      }
      return {
        ok: false,
        refusal: "recx_browser_required",
        message: verdict.message,
        invalidCidrs,
        networkUnrestricted,
      };
    }
    /**
     * Only on an audited call. The heartbeat runs every fifteen seconds and
     * a write per heartbeat to say "still the same version" buys a line on
     * a screen at the cost of a row lock on every sitting in the hall.
     */
    if (args.audited !== false) await noteExamBrowserSeen(verdict.sittingId, verdict.version);
  }

  return ok({ invalidCidrs, networkUnrestricted });
}

/**
 * The lowest REC Exam Browser version this deployment accepts, or null for
 * any.
 *
 * A `PlatformSetting` rather than an environment variable, because cutting
 * off a known-bad build is a thing somebody does at 9am from a screen, and
 * a redeploy is not available then (docs/EXAM-BROWSER.md §8).
 */
export async function examBrowserVersionFloor(): Promise<string | null> {
  const row = await db.platformSetting.findUnique({
    where: { key: EXAM_BROWSER_SETTING_KEY },
    select: { value: true },
  });
  const { floor, unreadable } = versionFloorOf(row?.value ?? null);
  if (unreadable) {
    // Saved by somebody, applied by nobody: that should not be silent.
    console.error("[exam-browser] the stored version floor is unreadable and is being ignored");
  }
  return floor;
}

/**
 * The SEB keys for an exam session.
 *
 * SPEC §5: "Keys live in PlatformSetting, rotate per exam session, and are
 * never committed." So they are NOT a column on `ExamSession`: that row is
 * readable by any staff member who can see the hall's roster, and an exam key
 * readable by everyone who can read a roster is not a key. `PlatformSetting`
 * is already the home of things only a super-admin reads.
 *
 * Keyed per exam session, with a platform-wide fallback so a college that
 * uses one .seb file for everything does not have to configure each hall.
 */
export async function sebKeysFor(examSessionId: string | null): Promise<{ configKey: string | null; browserExamKey: string | null }> {
  /**
   * The hall's own pair first (Phase 12z).
   *
   * It lives on `ExamSession` rather than in `PlatformSetting["seb:<id>"]`
   * where this originally looked: a key rotates per sitting and belongs
   * beside the hall's network allowlist, and PlatformSetting is the
   * super-admin's table — a STAFF action writing it would have widened
   * who can write every platform setting, which
   * `tests/repo/platform-setting-writes.test.ts` refused. The old setting
   * key is still read, so a deployment that set one by hand before there
   * was a screen keeps working.
   */
  if (examSessionId) {
    const hall = await db.examSession.findUnique({
      where: { id: examSessionId },
      select: { sebConfigKey: true, sebBrowserExamKey: true },
    });
    const configKey = hall?.sebConfigKey && hall.sebConfigKey !== "" ? hall.sebConfigKey : null;
    const browserExamKey = hall?.sebBrowserExamKey && hall.sebBrowserExamKey !== "" ? hall.sebBrowserExamKey : null;
    if (configKey || browserExamKey) return { configKey, browserExamKey };
  }

  const keys = ["seb"];
  if (examSessionId) keys.unshift(`seb:${examSessionId}`);
  const rows = await db.platformSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  // The per-session entry wins over the platform-wide one.
  for (const key of keys) {
    const row = rows.find((candidate) => candidate.key === key);
    if (!row) continue;
    const value = row.value as { configKey?: unknown; browserExamKey?: unknown } | null;
    const configKey = typeof value?.configKey === "string" && value.configKey !== "" ? value.configKey : null;
    const browserExamKey =
      typeof value?.browserExamKey === "string" && value.browserExamKey !== "" ? value.browserExamKey : null;
    if (configKey || browserExamKey) return { configKey, browserExamKey };
  }
  return { configKey: null, browserExamKey: null };
}

/** Verify one request's SEB headers. Exported so the readiness page can report it. */
export async function verifySebRequest(request: Request, examSessionId: string | null): Promise<SebVerdict> {
  return verifySeb({
    // The URL SEB hashed, which is the one it requested — with the query
    // string dropped on both sides so a parameter the client adds cannot
    // change the hash input.
    absoluteUrl: sebUrlFor(request.url),
    keys: await sebKeysFor(examSessionId),
    presented: {
      configKeyHash: request.headers.get(SEB_CONFIG_KEY_HEADER),
      requestHash: request.headers.get(SEB_REQUEST_HASH_HEADER),
    },
    sha256,
  });
}

/**
 * The containment check for a PAGE render (Phase 12y.7).
 *
 * `guardAttempt` runs this on every request a sitting makes — the
 * heartbeat, each telemetry flush, each snapshot, the submit — and the
 * attempt PAGE went through none of them. It asked only for a signed-in
 * user with an attempt in progress, and then rendered the paper. So a
 * candidate who started a KIOSK_SEB sitting inside Safe Exam Browser could
 * open the same URL in an ordinary browser and READ EVERY QUESTION; the
 * same hole let a lab-supervised paper be read from off the hall network.
 * They could not submit from there — the routes are guarded — but the
 * questions were the thing worth taking.
 *
 * A page has no `Request` object, so this builds the one SEB hashed: the
 * host the browser actually asked for (not `APP_URL`, which is a
 * deployment's idea of itself and can differ behind a proxy or in
 * development), the path being rendered, and the real headers.
 *
 * Audited, unlike the heartbeat's check: a page load is a person trying to
 * open the paper, which is exactly the event an invigilator should see.
 */
export async function checkPageContainment(args: {
  readonly pathname: string;
  readonly attempt: {
    readonly id: string;
    readonly userId: string;
    readonly assessmentId: string;
    readonly examSessionId: string | null;
    readonly proctorMode: string;
    /** The REC Exam Browser sitting, for KIOSK_RECX. Null for every other mode. */
    readonly examBrowserSittingId?: string | null;
  };
}): Promise<ContainmentResult> {
  return checkContainment({ request: await pageRequest(args.pathname), attempt: args.attempt, audited: true });
}

/**
 * The `Request` a page render did not get.
 *
 * A server component has headers but no Request, and both the SEB check
 * and the readiness page need the absolute URL SEB hashed. Built from the
 * host the browser actually asked for rather than from `APP_URL`, which
 * is a deployment's idea of itself and can differ behind a proxy or in
 * development — and a URL that differs by one character hashes to
 * something else entirely.
 */
export async function pageRequest(pathname: string): Promise<Request> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? new URL(env().APP_URL).host;
  const proto =
    incoming.get("x-forwarded-proto") ?? (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https");
  return new Request(`${proto}://${host}${pathname}`, { headers: new Headers(incoming) });
}
