"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireMentorAction } from "@/lib/auth/guards";
import {
  hidePostAs,
  markEditorialAs,
  resolveReportAs,
  unhidePostAs,
  type ModerationResult,
  type ResolvedReport,
} from "@/lib/discussion/moderation";
import type { HidePostInput, MarkEditorialInput, ResolveReportInput, UnhidePostInput } from "@/lib/discussion/schema";
import { runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Discussion moderation (Phase 12d): TA_MENTOR, ADMIN and SUPER_ADMIN.
 *
 * SPEC §11 says the moderation role ships "simultaneously, not after", and
 * SPEC §9's role list gives a TA_MENTOR exactly these powers — moderate
 * discussion, mark a solution editorial-quality, answer doubts with a badge
 * — and no authoring, no assessments, no role changes.
 *
 * College-wide rather than per mentee: `mentor-scope.ts` answers "whose
 * student is this" for private data, and a report queue narrowed to a
 * mentor's own mentees would leave most of the board unmoderated while
 * looking staffed.
 *
 * Every decision is audited with the reason the author is shown. Hiding is
 * SECURITY-sensitive because it is a decision about somebody else's words;
 * the rest are ordinary.
 */

const QUEUE = "/mentor/moderation";

export async function hideDiscussionPost(input: HidePostInput): Promise<ActionResult<ModerationResult>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const result = await hidePostAs(actor.id, input);
    await audit({
      actorId: actor.id,
      action: "discussion.post_hidden",
      entityType: "DiscussionPost",
      entityId: result.id,
      sensitivity: "SECURITY",
      metadata: { authorId: result.authorId, reason: result.reason },
      ipHash: await requestIpHash(),
    });
    revalidatePath(QUEUE);
    return { id: result.id, authorId: result.authorId };
  }, "hideDiscussionPost");
}

export async function unhideDiscussionPost(input: UnhidePostInput): Promise<ActionResult<ModerationResult>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const result = await unhidePostAs(actor.id, input);
    await audit({
      actorId: actor.id,
      action: "discussion.post_unhidden",
      entityType: "DiscussionPost",
      entityId: result.id,
      sensitivity: "SECURITY",
      metadata: { authorId: result.authorId },
      ipHash: await requestIpHash(),
    });
    revalidatePath(QUEUE);
    return result;
  }, "unhideDiscussionPost");
}

export async function markPostEditorial(input: MarkEditorialInput): Promise<ActionResult<ModerationResult>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const result = await markEditorialAs(actor.id, input);
    await audit({
      actorId: actor.id,
      action: "discussion.post_recommended",
      entityType: "DiscussionPost",
      entityId: result.id,
      sensitivity: "NORMAL",
      metadata: { authorId: result.authorId, editorial: result.editorial },
      ipHash: await requestIpHash(),
    });
    revalidatePath(QUEUE);
    return { id: result.id, authorId: result.authorId };
  }, "markPostEditorial");
}

export async function resolveContentReport(input: ResolveReportInput): Promise<ActionResult<ResolvedReport>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const result = await resolveReportAs(actor.id, input);
    await audit({
      actorId: actor.id,
      action: "discussion.report_resolved",
      entityType: "ContentReport",
      entityId: result.id,
      sensitivity: "SECURITY",
      metadata: { upheld: result.upheld, postId: result.postId, doubtId: result.doubtId },
      ipHash: await requestIpHash(),
    });
    revalidatePath(QUEUE);
    return result;
  }, "resolveContentReport");
}
