import "server-only";
import { createHash } from "node:crypto";
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

export type ContainmentRefusal = "outside_allowlist" | "seb_required";

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

  return ok({ invalidCidrs, networkUnrestricted });
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
