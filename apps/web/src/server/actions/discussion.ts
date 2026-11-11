"use server";

import { revalidatePath } from "next/cache";
import { requireActionUser } from "@/lib/auth/guards";
import {
  acceptAnswerFor,
  askDoubtFor,
  createPostFor,
  editPostFor,
  replyToDoubtFor,
  replyToPostFor,
  reportContentFor,
  type PostedId,
} from "@/lib/discussion/posts";
import type {
  AcceptAnswerInput,
  AskDoubtInput,
  CreatePostInput,
  EditPostInput,
  ReplyToDoubtInput,
  ReplyToPostInput,
  ReportContentInput,
} from "@/lib/discussion/schema";
import { runAction, type ActionResult } from "@/lib/errors";
import { WORKSPACE_HELP_CONTEXT } from "@/lib/help/access";

/**
 * The workspace's Discussion tab (Phase 12d). Signed-in users only; every
 * input is zod-parsed strict (no client-chosen context, no client-chosen
 * author) and the discussion gate is consulted again inside each body, so a
 * forged request gets exactly what the panel would have offered — which,
 * for a student who has not solved the problem, is nothing.
 *
 * Posts are not audited, for the same reason hint reveals are not: they are
 * the student's own study activity, and the row itself, with its timestamp,
 * is the record. Moderation IS audited, and lives in its own module behind
 * its own guard.
 */

const WORKSPACE = "/problems/[slug]";

export async function createDiscussionPost(input: CreatePostInput): Promise<ActionResult<PostedId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const post = await createPostFor(user, input, WORKSPACE_HELP_CONTEXT);
    revalidatePath(WORKSPACE, "page");
    return post;
  }, "createDiscussionPost");
}

export async function replyToDiscussionPost(input: ReplyToPostInput): Promise<ActionResult<PostedId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const reply = await replyToPostFor(user, input, WORKSPACE_HELP_CONTEXT);
    revalidatePath(WORKSPACE, "page");
    return reply;
  }, "replyToDiscussionPost");
}

export async function editDiscussionPost(input: EditPostInput): Promise<ActionResult<PostedId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const post = await editPostFor(user, input);
    revalidatePath(WORKSPACE, "page");
    return post;
  }, "editDiscussionPost");
}

export async function askDoubt(input: AskDoubtInput): Promise<ActionResult<PostedId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const thread = await askDoubtFor(user, input, WORKSPACE_HELP_CONTEXT);
    revalidatePath(WORKSPACE, "page");
    return thread;
  }, "askDoubt");
}

export async function replyToDoubt(input: ReplyToDoubtInput): Promise<ActionResult<PostedId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const reply = await replyToDoubtFor(user, input, WORKSPACE_HELP_CONTEXT);
    revalidatePath(WORKSPACE, "page");
    return reply;
  }, "replyToDoubt");
}

export async function acceptDoubtAnswer(input: AcceptAnswerInput): Promise<ActionResult<PostedId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const reply = await acceptAnswerFor(user, input);
    revalidatePath(WORKSPACE, "page");
    return reply;
  }, "acceptDoubtAnswer");
}

export async function reportContent(input: ReportContentInput): Promise<ActionResult<PostedId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const report = await reportContentFor(user, input);
    revalidatePath(WORKSPACE, "page");
    return report;
  }, "reportContent");
}
