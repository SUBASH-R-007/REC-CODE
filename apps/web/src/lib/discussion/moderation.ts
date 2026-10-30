import "server-only";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { hidePostSchema, markEditorialSchema, resolveReportSchema, unhidePostSchema } from "@/lib/discussion/schema";

/**
 * Moderation (Phase 12d), TA_MENTOR / ADMIN / SUPER_ADMIN.
 *
 * College-wide, not per mentee. A mentor's scope (lib/auth/mentor-scope.ts)
 * answers "whose student is this" for a student's private data; moderation
 * is about public posts, and a report queue that only showed a mentor their
 * own mentees' posts would leave most of the board unmoderated while
 * looking staffed.
 *
 * Every decision here is audited and carries a reason the author is shown.
 * Hidden, never deleted: a post that simply disappears teaches everybody
 * that posts disappear, which costs more trust than the post was worth, and
 * leaves an appeal with nothing to look at.
 */

export interface ModerationResult {
  id: string;
  /** For the audit row and the toast. */
  authorId: string;
}

export async function hidePostAs(moderatorId: string, input: unknown): Promise<ModerationResult & { reason: string }> {
  const { postId, reason } = hidePostSchema.parse(input);
  const post = await db.discussionPost.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true, status: true },
  });
  if (!post) throw new NotFoundError("That post was not found.");
  if (post.status === "HIDDEN") throw new ValidationError("That post is already hidden.");

  await db.discussionPost.update({
    where: { id: post.id },
    data: { status: "HIDDEN", hiddenById: moderatorId, hiddenReason: reason, hiddenAt: new Date() },
  });
  return { id: post.id, authorId: post.authorId, reason };
}

export async function unhidePostAs(_moderatorId: string, input: unknown): Promise<ModerationResult> {
  const { postId } = unhidePostSchema.parse(input);
  const post = await db.discussionPost.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true, status: true },
  });
  if (!post) throw new NotFoundError("That post was not found.");
  if (post.status === "VISIBLE") throw new ValidationError("That post is not hidden.");

  // The CHECK requires all three to clear together; so does honesty, since
  // a visible post carrying a hiding reason would show the wrong notice.
  await db.discussionPost.update({
    where: { id: post.id },
    data: { status: "VISIBLE", hiddenById: null, hiddenReason: null, hiddenAt: null },
  });
  return { id: post.id, authorId: post.authorId };
}

/**
 * "Editorial quality" — the post worth reading first.
 *
 * SPEC §9 lists this among the TA_MENTOR powers, and it is the one that
 * makes a discussion useful rather than merely busy: on a popular problem
 * the difference between twelve posts and twelve posts with one marked is
 * the difference between a resource and a pile.
 *
 * Only a VISIBLE top-level post can carry it: marking a reply would promote
 * something with no context, and marking a hidden post would advertise it.
 */
export async function markEditorialAs(_moderatorId: string, input: unknown): Promise<ModerationResult & { editorial: boolean }> {
  const { postId, editorial } = markEditorialSchema.parse(input);
  const post = await db.discussionPost.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true, status: true, parentId: true, editorialQuality: true },
  });
  if (!post) throw new NotFoundError("That post was not found.");
  if (post.parentId !== null) throw new ValidationError("Mark the post, not a reply to it.");
  if (editorial && post.status !== "VISIBLE") throw new ValidationError("A hidden post cannot be recommended.");
  if (post.editorialQuality === editorial) {
    throw new ValidationError(editorial ? "That post is already marked." : "That post is not marked.");
  }

  await db.discussionPost.update({ where: { id: post.id }, data: { editorialQuality: editorial } });
  return { id: post.id, authorId: post.authorId, editorial };
}

export interface ResolvedReport {
  id: string;
  upheld: boolean;
  postId: string | null;
  doubtId: string | null;
}

/**
 * Close a report with a decision and a sentence.
 *
 * Upholding does NOT hide the post on its own: hiding is its own decision
 * with its own reason, and a moderator who means to do both does both. A
 * single button that quietly did two things is how a queue gets cleared
 * without anybody reading it.
 */
export async function resolveReportAs(moderatorId: string, input: unknown): Promise<ResolvedReport> {
  const { reportId, upheld, resolution } = resolveReportSchema.parse(input);
  const report = await db.contentReport.findUnique({
    where: { id: reportId },
    select: { id: true, status: true, postId: true, doubtId: true },
  });
  if (!report) throw new NotFoundError("That report was not found.");
  if (report.status !== "OPEN") throw new ValidationError("That report has already been decided.");

  await db.contentReport.update({
    where: { id: report.id },
    data: {
      status: upheld ? "UPHELD" : "DISMISSED",
      resolvedById: moderatorId,
      resolvedAt: new Date(),
      resolution,
    },
  });
  return { id: report.id, upheld, postId: report.postId, doubtId: report.doubtId };
}
