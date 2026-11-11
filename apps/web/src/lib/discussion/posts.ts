import "server-only";
import type { Role } from "@recx/db";
import { DISCUSSION_REFUSALS, mayAskDoubt, mayReplyToDoubt, type HelpContext } from "@recx/shared";
import { db } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { discussionAllowed, getHelpState } from "@/lib/help/access";
import {
  acceptAnswerSchema,
  askDoubtSchema,
  createPostSchema,
  editPostSchema,
  replyToDoubtSchema,
  replyToPostSchema,
  reportContentSchema,
} from "@/lib/discussion/schema";

/**
 * The bodies of the student discussion actions (Phase 12d), with the help
 * context as an explicit server-side argument — the workspace passes
 * PRACTICE; tests pass CONTEST and ASSESSMENT and get nothing.
 *
 * Every one of these re-asks the gate. The panel's decision is a rendering
 * decision; this is the one that matters, and a forged request from a
 * student who has not solved the problem gets exactly what the page would
 * have shown them, which is nothing.
 */

const NOT_AVAILABLE = "That problem is not available.";
const NOT_YOURS = "That is not yours to change.";

export function isModerator(role: Role): boolean {
  return role === "TA_MENTOR" || role === "ADMIN" || role === "SUPER_ADMIN";
}

/** The gate, re-read on every write. Throws rather than returning a flag. */
async function gate(userId: string, problemId: string, role: Role, context: HelpContext, need: "read" | "post") {
  const state = await getHelpState(userId, problemId, context);
  if (!state) throw new NotFoundError(NOT_AVAILABLE);
  const access = discussionAllowed(state, isModerator(role));
  if (need === "read" && !access.mayRead) throw new ForbiddenError(access.readReason ?? DISCUSSION_REFUSALS.unsolved);
  if (need === "post" && !access.mayPost) throw new ForbiddenError(access.postReason ?? DISCUSSION_REFUSALS.assisted);
  return state;
}

export interface PostedId {
  id: string;
}

export async function createPostFor(
  user: { id: string; role: Role },
  input: unknown,
  context: HelpContext,
): Promise<PostedId> {
  const { problemId, kind, bodyMd, submissionId } = createPostSchema.parse(input);
  const state = await gate(user.id, problemId, user.role, context, "post");

  /**
   * An attached submission must be the author's OWN accepted one, on this
   * problem. Checked here rather than trusted: the id travels from the
   * browser, and "share my solution" that could name somebody else's
   * submission would be a way to read another student's code through the
   * rendering of a post.
   */
  let language: string | null = null;
  if (submissionId) {
    const submission = await db.submission.findUnique({
      where: { id: submissionId },
      select: { userId: true, problemId: true, verdict: true, language: true, origin: true },
    });
    if (
      !submission ||
      submission.userId !== user.id ||
      submission.problemId !== state.problemId ||
      submission.origin !== "PRACTICE" ||
      submission.verdict !== "AC"
    ) {
      throw new ValidationError("Attach one of your own accepted submissions on this problem.");
    }
    language = submission.language;
  }

  const post = await db.discussionPost.create({
    data: { problemId: state.problemId, authorId: user.id, kind, bodyMd, submissionId, language },
    select: { id: true },
  });
  return post;
}

export async function replyToPostFor(
  user: { id: string; role: Role },
  input: unknown,
  context: HelpContext,
): Promise<PostedId> {
  const { parentId, bodyMd } = replyToPostSchema.parse(input);
  const parent = await db.discussionPost.findUnique({
    where: { id: parentId },
    select: { id: true, problemId: true, parentId: true, status: true, kind: true },
  });
  if (!parent) throw new NotFoundError("That post was not found.");
  // One level. A thread that nests is a thread nobody moderates.
  if (parent.parentId !== null) throw new ValidationError("Reply to the post itself, not to a reply.");
  if (parent.status !== "VISIBLE") throw new ForbiddenError(DISCUSSION_REFUSALS.hidden);

  // Replying is READING plus a sentence: a student who may read the thread
  // may answer in it, even if their own solve of this problem was assisted.
  const state = await gate(user.id, parent.problemId, user.role, context, "read");

  const reply = await db.discussionPost.create({
    data: { problemId: state.problemId, authorId: user.id, parentId: parent.id, kind: parent.kind, bodyMd },
    select: { id: true },
  });
  return reply;
}

export async function editPostFor(user: { id: string; role: Role }, input: unknown): Promise<PostedId> {
  const { postId, bodyMd } = editPostSchema.parse(input);
  const post = await db.discussionPost.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true, status: true },
  });
  if (!post) throw new NotFoundError("That post was not found.");
  // Only the author, and never a moderator "fixing" somebody's words: a
  // moderator's tools are hide and explain, not rewrite.
  if (post.authorId !== user.id) throw new ForbiddenError(NOT_YOURS);
  if (post.status !== "VISIBLE") throw new ForbiddenError("A hidden post cannot be edited. Ask the moderator who hid it.");

  await db.discussionPost.update({ where: { id: post.id }, data: { bodyMd, editedAt: new Date() } });
  return { id: post.id };
}

// ── Doubts ──────────────────────────────────────────────────────────────

export async function askDoubtFor(
  user: { id: string; role: Role },
  input: unknown,
  context: HelpContext,
): Promise<PostedId> {
  const { problemId, title, bodyMd } = askDoubtSchema.parse(input);
  if (!mayAskDoubt(context)) throw new ForbiddenError(DISCUSSION_REFUSALS.notPractice);
  // Not gated on a solve — being stuck is the reason to ask — but the
  // problem still has to be one the student can see.
  const state = await getHelpState(user.id, problemId, context);
  if (!state) throw new NotFoundError(NOT_AVAILABLE);

  const thread = await db.doubtThread.create({
    data: { problemId: state.problemId, authorId: user.id, title, bodyMd },
    select: { id: true },
  });
  return thread;
}

export async function replyToDoubtFor(
  user: { id: string; role: Role },
  input: unknown,
  context: HelpContext,
): Promise<PostedId> {
  const { threadId, bodyMd } = replyToDoubtSchema.parse(input);
  const thread = await db.doubtThread.findUnique({
    where: { id: threadId },
    select: { id: true, problemId: true, authorId: true },
  });
  if (!thread) throw new NotFoundError("That question was not found.");
  const moderator = isModerator(user.role);
  if (!mayReplyToDoubt({ viewerId: user.id, askerId: thread.authorId, moderator })) {
    throw new ForbiddenError(DISCUSSION_REFUSALS.notYourDoubt);
  }
  if (!mayAskDoubt(context)) throw new ForbiddenError(DISCUSSION_REFUSALS.notPractice);

  const reply = await db.doubtReply.create({
    // Frozen from the role AT WRITE TIME: a badge on an old answer should
    // say what was true when it was given.
    data: { threadId: thread.id, authorId: user.id, bodyMd, byMentor: moderator },
    select: { id: true },
  });
  return reply;
}

/** The asker — and only the asker — marks the reply that answered it. */
export async function acceptAnswerFor(user: { id: string }, input: unknown): Promise<PostedId> {
  const { replyId } = acceptAnswerSchema.parse(input);
  const reply = await db.doubtReply.findUnique({
    where: { id: replyId },
    select: { id: true, threadId: true, authorId: true, thread: { select: { authorId: true, status: true } } },
  });
  if (!reply) throw new NotFoundError("That reply was not found.");
  if (reply.thread.authorId !== user.id) throw new ForbiddenError("Only the student who asked can mark the answer.");
  if (reply.authorId === user.id) throw new ValidationError("Mark somebody else's reply as the answer, not your own.");

  const now = new Date();
  await db.$transaction([
    db.doubtReply.updateMany({ where: { threadId: reply.threadId }, data: { acceptedAt: null } }),
    db.doubtReply.update({ where: { id: reply.id }, data: { acceptedAt: now } }),
    db.doubtThread.update({ where: { id: reply.threadId }, data: { status: "ANSWERED", answeredAt: now } }),
  ]);
  return { id: reply.id };
}

// ── Reporting ───────────────────────────────────────────────────────────

/**
 * Anybody signed in may report, including a student who cannot read the
 * thread: reports come from people who saw something, and a gate on
 * reporting is a gate on the safety valve.
 *
 * One open report per person per thing. Not a rate limit dressed up — a
 * second report from the same student adds nothing for the moderator and
 * makes the queue lie about how many people are complaining.
 */
export async function reportContentFor(user: { id: string }, input: unknown): Promise<PostedId> {
  const { postId, doubtId, reason, detail } = reportContentSchema.parse(input);

  if (postId) {
    const post = await db.discussionPost.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) throw new NotFoundError("That post was not found.");
  } else if (doubtId) {
    const doubt = await db.doubtThread.findUnique({ where: { id: doubtId }, select: { id: true } });
    if (!doubt) throw new NotFoundError("That question was not found.");
  }

  const existing = await db.contentReport.findFirst({
    where: { reporterId: user.id, status: "OPEN", ...(postId ? { postId } : { doubtId }) },
    select: { id: true },
  });
  if (existing) throw new ValidationError("You have already reported this. A moderator will look at it.");

  const report = await db.contentReport.create({
    data: { postId, doubtId, reporterId: user.id, reason, detail },
    select: { id: true },
  });
  return report;
}
