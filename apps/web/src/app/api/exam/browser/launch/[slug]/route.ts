import { examBrowserLaunchUrl } from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { mintLaunchToken } from "@/lib/exam/exam-browser";
import { pageRequest } from "@/lib/exam/containment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/browser/launch/[slug] — mint a launch for this candidate
 * and this paper (Phase 14e).
 *
 * The other half of the handshake, and the opposite of the exchange beside
 * it: this one is behind a guard, because the candidate IS signed in here.
 * They are reading the readiness page in an ordinary browser, and what
 * comes back is a one-shot token good for five minutes that the
 * application will spend for a sitting key.
 *
 * Minted per press rather than per page render. A token on the page would
 * be spent by the first thing that read the HTML — a prefetch, a logger, a
 * second tab — and the candidate would meet "that launch has already been
 * used" on a page they had only looked at.
 *
 * The origin is the host the browser actually asked for, not `APP_URL`: a
 * launch URL naming a hostname the candidate did not reach us on is a
 * launch URL the application will refuse, and behind a proxy or in
 * development those differ.
 */
export async function POST(_request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  let userId: string;
  try {
    const actor = await requireActionUser();
    userId = actor.id;
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }

  const { slug } = await context.params;
  const assessment = await db.assessment.findUnique({
    where: { slug },
    select: { id: true, status: true, proctorMode: true },
  });
  if (!assessment || assessment.status === "DRAFT") {
    return Response.json({ error: "That assessment was not found." }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  /**
   * Offered for any published paper rather than only a KIOSK_RECX one, on
   * the same reasoning as the `.seb` file beside it: an invigilator
   * testing a hall before the day needs to launch the browser before the
   * mode is final, and a paper that is not KIOSK_RECX simply never checks
   * the attestation. A token minted for it is worth nothing.
   */
  const { token, expiresAt } = await mintLaunchToken({ userId, assessmentId: assessment.id });

  await audit({
    actorId: userId,
    action: "exam.browser.launch_minted",
    entityType: "Assessment",
    entityId: assessment.id,
    sensitivity: "SECURITY",
    // Which paper, and nothing else. Never the token.
    metadata: { proctorMode: assessment.proctorMode },
  });

  const here = await pageRequest(`/assessments/${slug}/readiness`);
  return Response.json(
    { launchUrl: examBrowserLaunchUrl({ origin: new URL(here.url).origin, token }), expiresAt: expiresAt.toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
}
