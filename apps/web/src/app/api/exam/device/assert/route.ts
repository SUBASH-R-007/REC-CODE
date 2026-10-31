import { z } from "zod";
import { requiresDeviceAssertion, type ProctorMode } from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { assertionOptions, verifyAssertion } from "@/lib/exam/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/device/assert — the fresh assertion that precedes a sitting
 * (Phase 6d).
 *
 * SPEC §5: "A fresh assertion against a server challenge is required to start
 * any REMOTE_MONITORED or LAB_SUPERVISED attempt."
 *
 * "Fresh" is the load-bearing word. The proof is the CONSUMED challenge row:
 * it records the user, the assessment, the moment it was spent and which
 * device signed it, and the `WebAuthnChallenge_single_use` trigger makes it
 * unspendable twice. The attempt-start path reads that row, so nothing is
 * handed to the client to carry and there is no signed value to forge. The
 * attempt then records the device, so "which machine sat this exam" stays
 * answerable long after the challenge has expired.
 *
 * This is the student's own route — unlike enrolment, which is a supervisor's
 * — because the candidate is the one holding the authenticator.
 */

const noStore = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

const bodySchema = z.discriminatedUnion("step", [
  z.object({ step: z.literal("options"), slug: z.string().min(1).max(120) }).strict(),
  z
    .object({
      step: z.literal("verify"),
      slug: z.string().min(1).max(120),
      challenge: z.string().min(32).max(512),
      response: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);

export async function POST(request: Request) {
  let user;
  try {
    user = await requireActionUser();
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = await request.json();
  } catch {
    return json({ error: "Malformed request." }, 400);
  }
  const body = bodySchema.safeParse(parsedJson);
  if (!body.success) return json({ error: "Malformed request." }, 400);

  const assessment = await db.assessment.findUnique({
    where: { slug: body.data.slug },
    select: { id: true, proctorMode: true },
  });
  if (!assessment) return json({ error: "That assessment does not exist." }, 404);
  if (!requiresDeviceAssertion(assessment.proctorMode as ProctorMode)) {
    // Not an error: the client asks before every sitting and this one does
    // not need a device, so it may carry on.
    return json({ required: false });
  }

  if (body.data.step === "options") {
    const result = await assertionOptions({ userId: user.id, assessmentId: assessment.id });
    if (!result.ok) return json({ error: result.message, refusal: result.refusal }, 409);
    return json({ required: true, options: result.options });
  }

  const result = await verifyAssertion({
    userId: user.id,
    response: body.data.response as never,
    expectedChallenge: body.data.challenge,
  });
  if (!result.ok) return json({ error: result.message, refusal: result.refusal }, 409);

  // The spent challenge row now records which device signed it; the
  // attempt-start path reads that. Nothing is handed to the client to carry.
  return json({ required: true, verified: true });
}
