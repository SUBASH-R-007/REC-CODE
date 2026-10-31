import { z } from "zod";
import { findScopedStudent, requireAdminScopeAction } from "@/lib/auth/scope";
import { AppError } from "@/lib/errors";
import { enrolmentOptions, verifyEnrolment } from "@/lib/exam/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/device/enrol — supervised device enrolment (Phase 6d).
 *
 * Behind a STAFF guard, not a student one, and that is the whole point. SPEC
 * §5 says "supervised in-lab enrolment", because a student who can enrol
 * their own device can enrol a friend's — which is exactly the impersonation
 * WebAuthn is here to close:
 *
 *   WebAuthn also closes impersonation (a senior sitting for a junior), which
 *   is a more common and more damaging campus failure than tab-switching.
 *
 * Two steps in one route, chosen by `step`: the supervisor asks for options,
 * the student touches their key on the supervisor's screen, and the
 * supervisor posts the response back. One route because the pair is one
 * ceremony and splitting it would double the RBAC surface for no gain.
 *
 * The loaner path (`asLoaner`) is the part a student's day depends on: a
 * single-use registration a supervisor can issue on the spot so a broken
 * laptop never stops someone sitting an exam they are entitled to sit.
 *
 * The student is looked up through `findScopedStudent`, so an ADMIN may only
 * enrol a device for a student their `AdminScope` grant covers — a
 * department's admin cannot bind a device for another department's student.
 * An out-of-scope id and an unknown id give the SAME answer, so ids cannot be
 * probed. `tests/repo/admin-scope.test.ts` caught the first draft of this
 * route reaching for `db.user.findUnique` directly.
 */

const noStore = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

const bodySchema = z.discriminatedUnion("step", [
  z
    .object({
      step: z.literal("options"),
      userId: z.string().min(1).max(64),
      asLoaner: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      step: z.literal("verify"),
      userId: z.string().min(1).max(64),
      asLoaner: z.boolean().default(false),
      label: z.string().min(1).max(80),
      challenge: z.string().min(32).max(512),
      // The authenticator's response, verified by @simplewebauthn/server.
      response: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);

export async function POST(request: Request) {
  let supervisor;
  let scope;
  try {
    ({ user: supervisor, scope } = await requireAdminScopeAction());
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

  // Scoped: an unknown id and an id outside this admin's grant are the same
  // answer, so one cannot be used to discover the other.
  const student = await findScopedStudent(scope, { id: body.data.userId });
  if (!student) return json({ error: "That student was not found." }, 404);
  if (student.status === "DISABLED") {
    return json({ error: "That account is disabled." }, 400);
  }

  if (body.data.step === "options") {
    const result = await enrolmentOptions({
      userId: student.scopedId,
      handle: student.handle,
      displayName: `${student.firstName} ${student.lastName}`.trim(),
      asLoaner: body.data.asLoaner,
    });
    if (!result.ok) return json({ error: result.message, refusal: result.refusal }, 409);
    return json({ options: result.options });
  }

  const result = await verifyEnrolment({
    userId: student.scopedId,
    supervisorId: supervisor.id,
    response: body.data.response as never,
    expectedChallenge: body.data.challenge,
    label: body.data.label,
    asLoaner: body.data.asLoaner,
  });
  if (!result.ok) return json({ error: result.message, refusal: result.refusal }, 409);
  return json({ deviceId: result.deviceId, label: result.label });
}
