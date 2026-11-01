import { buildSebConfig } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { AppError } from "@/lib/errors";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/exam/seb-config/[slug] — the .seb file for a kiosk paper
 * (Phase 12y.8).
 *
 * The slug comes last because `app/api/exam/[attemptId]` already owns the
 * dynamic segment at that level, and Next refuses two different names for
 * one position ("You cannot use different slug names for the same dynamic
 * path"). The first draft put it at `/api/exam/[slug]/seb-config` and the
 * dev server answered every request to it with a 404 while logging that
 * sentence — which is how it was found.
 *
 * A paper set to KIOSK_SEB refused every candidate with "open the exam
 * from the .seb file your department gave you", and nothing in this
 * product produced such a file. This does: a configuration naming THIS
 * deployment's start URL, served so that one link on the readiness page
 * opens Safe Exam Browser on the right exam.
 *
 * Signed in, because the file names the paper and a college's own exam
 * timetable is not public. Not scoped any harder than that on purpose: it
 * carries no questions, no answers and no keys — the settings SEB needs
 * and nothing else — and a candidate who cannot sit the paper gains
 * nothing by holding it.
 *
 * Offered for any paper rather than only a kiosk one: an invigilator
 * testing a hall before the day needs the file before the mode is final,
 * and a paper that is not KIOSK_SEB simply never checks the keys.
 */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    await requireUser();
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }

  const { slug } = await context.params;
  const paper = await db.assessment.findUnique({
    where: { slug },
    select: { slug: true, status: true },
  });
  if (!paper || paper.status === "DRAFT") {
    return Response.json({ error: "That assessment was not found." }, { status: 404 });
  }

  /**
   * Built from the host the browser asked for, not from `APP_URL`: SEB
   * will hash the URL it requests, and a configuration that sends
   * candidates to a different hostname than the one they reached us on is
   * a configuration whose key can never match.
   */
  const origin = new URL(request.url).origin;
  const config = buildSebConfig({
    startUrl: `${origin}/assessments/${paper.slug}/readiness`,
    quitUrl: `${origin}/assessments`,
    allowedOrigin: origin,
  });

  return new Response(config, {
    headers: {
      // SEB's own media type. A browser that does not know it downloads
      // the file, which is the fallback the readiness page points at.
      "content-type": "application/seb",
      "content-disposition": `attachment; filename="${paper.slug}.seb"`,
      "cache-control": "no-store",
    },
  });
}
