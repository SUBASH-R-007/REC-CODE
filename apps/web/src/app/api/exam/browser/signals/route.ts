import { RECX_SITTING_HEADER } from "@recx/shared/exam-browser";
import { examBrowserVersionFloor } from "@/lib/exam/containment";
import { verifyExamBrowserRequest } from "@/lib/exam/exam-browser";
import { readJsonBody } from "@/lib/http/body";
import {
  examBrowserSignalBatchSchema,
  recordExamBrowserSignals,
  signalTargetOf,
} from "@/lib/exam/exam-browser-signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/browser/signals — what the exam browser saw (Phase 15a).
 *
 * Not a candidate-facing route and not reachable from the exam page: the
 * only caller is the browser's main process, and the only credential that
 * opens it is the sitting key, which lives in that process and never
 * crosses the preload (`docs/EXAM-BROWSER.md` §4). That is the entire
 * reason this endpoint exists. Everything the server knew about a
 * candidate's window arrived as `CLIENT` until now, and
 * `docs/PROCTORING.md` §2 says plainly that a page's account of its own
 * focus, fullscreen state and monitor count is falsifiable. These signals
 * come from a witness the page cannot patch.
 *
 * No session cookie is required or consulted. A signature over this URL,
 * under the key of a sitting that is bound to a live attempt, is a
 * stronger statement than a cookie -- a cookie proves somebody is signed
 * in, this proves the request came from the application holding that
 * sitting. Adding a cookie check would only mean a candidate whose session
 * expired mid-paper stopped being observed, which is precisely backwards.
 *
 * Every refusal is the same 204. There is nothing a caller may learn here:
 * not whether a sitting exists, not whether it is bound, not whether the
 * attempt is still running. The browser does not act on the answer either
 * -- it has nowhere to put a signal the server declined, and telling a
 * candidate's machine "that sitting is not live" is telling whoever is
 * holding the machine.
 */

/** Accepted, refused, rate limited and malformed all look the same from outside. */
const done = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const claimed = request.headers.get(RECX_SITTING_HEADER)?.trim() ?? "";
  const now = new Date();

  /**
   * The target is resolved from the sitting the request CLAIMS, before
   * anything is verified, and that is the only possible order: the key the
   * signature is checked against is derived from that id. It proves
   * nothing by itself, which is why the verification below decides.
   */
  const target = await signalTargetOf(claimed, now);
  if (!target) return done();

  const verdict = await verifyExamBrowserRequest({
    request,
    absoluteUrl: request.url,
    // From the ATTEMPT's binding, never from the request. A signature that
    // verifies under some sitting proves a holder of some key signed it;
    // the question is whether the browser bound to this attempt did.
    expectedSittingId: target.sittingId,
    versionFloor: await examBrowserVersionFloor(),
  });
  if (!verdict.ok) return done();

  // Bounded before it is parsed (Phase 17 audit): a batch is a handful of
  // counters, and the exam browser posts to this route throughout a sitting.
  const read = await readJsonBody(request);
  const body = read.ok ? examBrowserSignalBatchSchema.safeParse(read.value) : null;
  if (!body?.success) return done();

  /**
   * A failure here is a 204 as well, and the browser will send the signal
   * again on its next batch. A proctor event that could not be written is
   * a missing line in a reviewer's timeline; a 500 on a candidate's
   * machine in the middle of a paper is a candidate watching an error.
   */
  try {
    await recordExamBrowserSignals({ target, signals: body.data.signals, now });
  } catch (error) {
    console.error("[exam-browser] could not record attested signals:", error);
  }
  return done();
}
