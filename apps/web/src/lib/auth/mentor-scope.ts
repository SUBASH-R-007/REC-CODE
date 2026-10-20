import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Db, DbTx, User } from "@recx/db";
import { requireMentorAction, requireMentorPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

/**
 * The mentor of record, the server half (Phase 9d).
 *
 * The mirror of lib/auth/scope.ts, and it fails closed in the same way: a
 * mentor with no active `MentorAssignment` row sees nobody. That is not a
 * defensive flourish — a mentor surface that defaulted to "every student in
 * my department" would be a second, undeclared AdminScope with none of the
 * grant records behind it.
 *
 *   Pages:   const { user, mentees } = await requireMentorScopePage();
 *   Actions: const { user, mentees } = await requireMentorScopeAction();
 *   One mentee: requireScopedMentee(scope, id) / requireScopedMenteePage(...)
 *
 * Only this file mints a `ScopedMenteeId`, and every per-mentee query takes
 * one rather than a raw string, so "whose student is this" is answered by
 * the type system rather than by remembering. `tests/repo/placement-fence.ts`
 * is the fence that keeps it that way.
 *
 * SUPER_ADMIN and ADMIN are admitted by the guard and then subject to
 * EXACTLY the same per-mentee check: being an admin does not make somebody
 * the mentor of record, and the mentor pages are not a second route into a
 * student's data. An admin who needs the scoped admin view has /admin.
 */

declare const SCOPED_MENTEE: unique symbol;

/** A mentee id this viewer is the recorded mentor of. Only this file mints one. */
export type ScopedMenteeId = string & { readonly [SCOPED_MENTEE]: true };

declare const MENTOR_SCOPE: unique symbol;

/**
 * The viewer's live mentees. Branded, so a page cannot assemble one from a
 * list of ids it found somewhere else.
 *
 * The brand is a TYPE and is never written at runtime — the constructor
 * below casts, exactly as `buildStudentScope` does. Writing
 * `[MENTOR_SCOPE]: true` into the object literal typechecks and then throws
 * `ReferenceError: MENTOR_SCOPE is not defined` on the first render, because
 * `declare const` emits nothing. It did, here, and nothing in the test suite
 * caught it: the capability matrix hangs its database stub, so the literal
 * was never constructed. R5 in tests/repo/placement-fence.test.ts is the
 * fence that came out of that.
 */
export type MentorScope = {
  readonly mentorId: string;
  /** Live assignments only — `endedAt IS NULL`. Empty for everybody else. */
  readonly menteeIds: readonly ScopedMenteeId[];
} & { readonly [MENTOR_SCOPE]: true };

const loadScopeFor = cache(async (mentorId: string): Promise<MentorScope> => {
  const rows = await db.mentorAssignment.findMany({
    where: { mentorId, endedAt: null },
    select: { menteeId: true },
    orderBy: { assignedAt: "asc" },
  });
  return buildMentorScope(mentorId, rows.map((row) => row.menteeId as ScopedMenteeId));
});

/**
 * The only constructor of a MentorScope.
 *
 * The cast goes through `unknown` because the literal genuinely does not
 * carry the branded key — that is the whole point of the brand: a page
 * cannot assemble one from a list of ids it found somewhere else. What the
 * cast must NOT do is write the key, which `declare const` emits no value
 * for; R5 in tests/repo/placement-fence.test.ts is the fence over that, and
 * it exists because this file got it wrong once.
 */
function buildMentorScope(mentorId: string, menteeIds: readonly ScopedMenteeId[]): MentorScope {
  return { mentorId, menteeIds } as unknown as MentorScope;
}

/** The viewer's mentor scope (cached per request). */
export function loadMentorScope(user: Pick<User, "id">): Promise<MentorScope> {
  return loadScopeFor(user.id);
}

/** Page guard for /mentor: the role, then the viewer's live mentees. */
export async function requireMentorScopePage(): Promise<{ user: User; scope: MentorScope }> {
  const user = await requireMentorPage();
  return { user, scope: await loadMentorScope(user) };
}

/** Action guard for the mentor surfaces. */
export async function requireMentorScopeAction(): Promise<{ user: User; scope: MentorScope }> {
  const user = await requireMentorAction();
  return { user, scope: await loadMentorScope(user) };
}

/** True when this viewer is the recorded mentor of `userId`. */
export function scopeCoversMentee(scope: MentorScope, userId: string): boolean {
  return (scope.menteeIds as readonly string[]).includes(userId);
}

/**
 * `userId` as a ScopedMenteeId, if this viewer is their recorded mentor.
 *
 * A student who does not exist and a student who is somebody else's mentee
 * raise the SAME NotFoundError, so a mentor cannot probe ids to learn who is
 * on the platform.
 */
export function requireScopedMentee(scope: MentorScope, userId: string): ScopedMenteeId {
  if (!scopeCoversMentee(scope, userId)) throw new NotFoundError("That student was not found.");
  return userId as ScopedMenteeId;
}

/** Page form: the route's 404 rather than an error. */
export function requireScopedMenteePage(scope: MentorScope, userId: string): ScopedMenteeId {
  if (!scopeCoversMentee(scope, userId)) notFound();
  return userId as ScopedMenteeId;
}

/**
 * Who is the recorded mentor of each of these students, if anybody.
 *
 * Used by the officer surfaces to show the named human a student would be
 * routed to. One index scan on `[menteeId, endedAt]`, and it returns the
 * mentor's NAME rather than their id, because the only question an officer
 * asks of it is "who do I ask to have the conversation".
 */
export interface RecordedMentor {
  /** The assignment, so a surface can END it without a second lookup. */
  readonly assignmentId: string;
  readonly mentorId: string;
  readonly name: string;
  readonly assignedAt: Date;
}

export async function mentorsOf(
  menteeIds: readonly string[],
  client: Db | DbTx = db,
): Promise<ReadonlyMap<string, RecordedMentor>> {
  if (menteeIds.length === 0) return new Map();
  const rows = await client.mentorAssignment.findMany({
    where: { menteeId: { in: [...menteeIds] }, endedAt: null },
    select: {
      id: true,
      menteeId: true,
      mentorId: true,
      assignedAt: true,
      mentor: { select: { firstName: true, lastName: true } },
    },
  });
  return new Map(
    rows.map((row) => [
      row.menteeId,
      {
        assignmentId: row.id,
        mentorId: row.mentorId,
        name: `${row.mentor.firstName} ${row.mentor.lastName}`.trim(),
        assignedAt: row.assignedAt,
      },
    ]),
  );
}
