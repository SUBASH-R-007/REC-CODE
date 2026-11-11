import { z } from "zod";
import {
  DISCUSSION_LIMITS,
  DISCUSSION_POST_KINDS,
  REPORT_REASONS,
  type DiscussionPostKind,
  type ReportReason,
} from "@recx/shared";
import { problemIdSchema } from "@/lib/help/schema";

/**
 * Zod boundaries for the discussion actions (Phase 12d). Strict, like the
 * help schemas: the context, the author and whether a reply comes from a
 * mentor are all decided on the server, so a client that sends any of them
 * is refused outright rather than having the field quietly dropped.
 *
 * The bounds are `DISCUSSION_LIMITS`, which the database also holds as
 * CHECKs. Two doors: this one gives the student a sentence they can act on,
 * and the other one is still shut if a future caller forgets this one.
 */

const id = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "That id is not valid.");

const body = (limits: { min: number; max: number }, what: string) =>
  z
    .string()
    .trim()
    .min(limits.min, `Write at least ${limits.min} characters — ${what}`)
    .max(limits.max, `Keep it under ${limits.max} characters.`);

export const createPostSchema = z
  .object({
    problemId: problemIdSchema,
    kind: z.enum(DISCUSSION_POST_KINDS as unknown as [DiscussionPostKind, ...DiscussionPostKind[]]),
    bodyMd: body(DISCUSSION_LIMITS.body, "enough for somebody else to follow your reasoning."),
    /**
     * The author's OWN accepted submission, attached so shared code is code
     * the judge accepted. The server checks the ownership and the verdict;
     * the id alone proves nothing.
     */
    submissionId: id.nullable().default(null),
  })
  .strict();
export type CreatePostInput = z.input<typeof createPostSchema>;

export const replyToPostSchema = z
  .object({
    parentId: id,
    bodyMd: body(DISCUSSION_LIMITS.replyBody, "say something."),
  })
  .strict();
export type ReplyToPostInput = z.input<typeof replyToPostSchema>;

export const editPostSchema = z
  .object({
    postId: id,
    bodyMd: body(DISCUSSION_LIMITS.body, "enough for somebody else to follow your reasoning."),
  })
  .strict();
export type EditPostInput = z.input<typeof editPostSchema>;

export const askDoubtSchema = z
  .object({
    problemId: problemIdSchema,
    title: body(DISCUSSION_LIMITS.doubtTitle, "say what you are stuck on."),
    bodyMd: body(DISCUSSION_LIMITS.doubtBody, "say what you have tried."),
  })
  .strict();
export type AskDoubtInput = z.input<typeof askDoubtSchema>;

export const replyToDoubtSchema = z
  .object({
    threadId: id,
    bodyMd: body(DISCUSSION_LIMITS.replyBody, "say something."),
  })
  .strict();
export type ReplyToDoubtInput = z.input<typeof replyToDoubtSchema>;

export const acceptAnswerSchema = z.object({ replyId: id }).strict();
export type AcceptAnswerInput = z.input<typeof acceptAnswerSchema>;

export const reportContentSchema = z
  .object({
    postId: id.nullable().default(null),
    doubtId: id.nullable().default(null),
    reason: z.enum(REPORT_REASONS as unknown as [ReportReason, ...ReportReason[]]),
    detail: body(DISCUSSION_LIMITS.reportReason, "tell the moderator what to look at."),
  })
  .strict()
  .refine((value) => (value.postId === null) !== (value.doubtId === null), {
    message: "Report one thing at a time.",
  });
export type ReportContentInput = z.input<typeof reportContentSchema>;

// ── Moderation (TA_MENTOR, ADMIN, SUPER_ADMIN) ──────────────────────────

export const hidePostSchema = z
  .object({
    postId: id,
    reason: body(DISCUSSION_LIMITS.moderationReason, "the author is shown this."),
  })
  .strict();
export type HidePostInput = z.input<typeof hidePostSchema>;

export const unhidePostSchema = z.object({ postId: id }).strict();
export type UnhidePostInput = z.input<typeof unhidePostSchema>;

export const markEditorialSchema = z.object({ postId: id, editorial: z.boolean() }).strict();
export type MarkEditorialInput = z.input<typeof markEditorialSchema>;

export const resolveReportSchema = z
  .object({
    reportId: id,
    upheld: z.boolean(),
    resolution: body(DISCUSSION_LIMITS.moderationReason, "say what you decided and why."),
  })
  .strict();
export type ResolveReportInput = z.input<typeof resolveReportSchema>;
