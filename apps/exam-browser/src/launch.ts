import { EXAM_BROWSER_SCHEME, parseExamBrowserLaunchUrl } from "@recx/shared/exam-browser";
import type { Sitting } from "./sitting";

/**
 * Turning a `recx-exam://launch?…` URL into a sitting.
 *
 * Two steps, and the first one is the security step: the launch URL is
 * attacker-reachable (any page the candidate visits can open a custom
 * scheme), so its origin is checked against the build's own list before
 * anything is sent anywhere. `parseExamBrowserLaunchUrl` does that, and
 * `docs/EXAM-BROWSER.md` §5 says what it is for.
 */

export const EXCHANGE_PATH = "/api/exam/browser/exchange";

/** The launch URL in an argv, if there is one. Windows and Linux pass it as an argument. */
export function launchUrlIn(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${EXAM_BROWSER_SCHEME}://`)) ?? null;
}

export type LaunchOutcome =
  | { readonly ok: true; readonly sitting: Sitting }
  | { readonly ok: false; readonly reason: string };

/**
 * Spend the launch token and receive the sitting key.
 *
 * The one request this application makes without a signature, because the
 * key it would sign with is what comes back. Everything after it is
 * signed.
 *
 * `fetchImpl` is injected so the whole flow is testable without a network
 * or an Electron runtime; `main.ts` passes the global `fetch`.
 */
export async function exchange(args: {
  readonly launchUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<LaunchOutcome> {
  const parsed = parseExamBrowserLaunchUrl(args.launchUrl, args.allowedOrigins);
  if (!parsed.ok) {
    /**
     * Named precisely in the log and vaguely on screen. `bad_origin` is
     * the interesting one — it means something tried to point this
     * application at a server it was not shipped to talk to, which is
     * worth an invigilator's attention and is not the candidate's fault.
     */
    return { ok: false, reason: parsed.reason };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 15_000);
  try {
    const doFetch = args.fetchImpl ?? fetch;
    const response = await doFetch(`${parsed.origin}${EXCHANGE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: parsed.token }),
      signal: controller.signal,
      // No cookies in either direction: this application has none, and a
      // launch must never depend on one being present.
      credentials: "omit",
      redirect: "error",
    });

    const body = (await response.json().catch(() => null)) as
      | { sittingId?: unknown; sittingKey?: unknown; assessmentId?: unknown; assessmentSlug?: unknown; error?: unknown }
      | null;

    if (!response.ok) {
      return { ok: false, reason: typeof body?.error === "string" ? body.error : `exchange_failed_${response.status}` };
    }
    if (
      typeof body?.sittingId !== "string" ||
      typeof body.sittingKey !== "string" ||
      typeof body.assessmentId !== "string" ||
      typeof body.assessmentSlug !== "string"
    ) {
      return { ok: false, reason: "exchange_malformed" };
    }

    return {
      ok: true,
      sitting: {
        sittingId: body.sittingId,
        sittingKey: body.sittingKey,
        origin: parsed.origin,
        assessmentId: body.assessmentId,
        assessmentSlug: body.assessmentSlug,
      },
    };
  } catch (error) {
    // The message, never the token: this function holds one, and a stack
    // trace in a log file is a place a credential should never reach.
    return { ok: false, reason: error instanceof Error ? error.name : "exchange_failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** What the candidate reads when a launch does not work. */
export const LAUNCH_FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  not_a_launch: "This did not come from a readiness check. Open the exam from REC Code and press Launch.",
  bad_origin:
    "This launch pointed somewhere this exam browser is not allowed to go. Do not enter your password. Tell your invigilator.",
  bad_token: "This launch was not readable. Go back to the readiness check and press Launch again.",
  exchange_malformed: "The server answered in a way this version does not understand. Tell your invigilator.",
  AbortError: "The server did not answer in time. Check the network and launch again from the readiness check.",
});
