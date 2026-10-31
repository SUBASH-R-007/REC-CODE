import "server-only";
import type { Role } from "@recx/db";
import {
  hiddenNotice,
  mayReplyToDoubt,
  type DiscussionAccess,
  type DiscussionPostKind,
  type HelpContext,
  type ReportReason,
} from "@recx/shared";
import { isModerator } from "@/lib/discussion/posts";
import { db } from "@/lib/db";
import { discussionAllowed, getHelpState } from "@/lib/help/access";
import { renderMarkdown } from "@/lib/markdown";

/**
 * What the workspace's Discussion tab needs, decided on the server
 * (Phase 12d).
 *
 * Nothing a student may not read is loaded. When the gate says no, the
 * posts are never fetched at all — not fetched and filtered out, which is
 * how a body ends up in a payload nobody meant to send. The doubts ARE
 * loaded either way, because a doubt is not gated.
 *
 * A hidden post keeps its place with its reason and without its body. That
 * is deliberate: a post that simply vanishes teaches everybody that posts
 * vanish, and leaves an appeal with nothing to look at.
 */

export interface DiscussionAuthor {
  handle: string;
  name: string;
  /** The badge on a TA or mentor's reply, frozen when it was written. */
  mentor: boolean;
}

export interface DiscussionReplyView {
  id: string;
  author: DiscussionAuthor;
  html: string;
  createdAt: Date;
  mine: boolean;
}

export interface DiscussionPostView {
  id: string;
  kind: DiscussionPostKind;
  author: DiscussionAuthor;
  /** Sanitised HTML, or null when the post is hidden. */
  html: string | null;
  /** The notice shown in place of a hidden post's body. */
  hidden: string | null;
  editorialQuality: boolean;
  language: string | null;
  createdAt: Date;
  editedAt: Date | null;
  mine: boolean;
  replies: DiscussionReplyView[];
}

export interface DoubtReplyView {
  id: string;
  author: DiscussionAuthor;
  html: string;
  createdAt: Date;
  accepted: boolean;
  mine: boolean;
}

export interface DoubtThreadView {
  id: string;
  title: string;
  author: DiscussionAuthor;
  html: string;
  status: "OPEN" | "ANSWERED";
  createdAt: Date;
  mine: boolean;
  /** This viewer may add a reply here (the asker, or a mentor). */
  mayReply: boolean;
  replies: DoubtReplyView[];
}

export interface AttachableSubmission {
  id: string;
  language: string;
  createdAt: Date;
}

export interface DiscussionPanel {
  problemId: string;
  access: DiscussionAccess;
  posts: DiscussionPostView[];
  doubts: DoubtThreadView[];
  /** The viewer's own accepted submissions on this problem, newest first. */
  attachable: AttachableSubmission[];
}

const AUTHOR_SELECT = { handle: true, firstName: true, lastName: true, role: true } as const;

function authorOf(row: { handle: string; firstName: string; lastName: string; role: Role }, mentor?: boolean): DiscussionAuthor {
  return {
    handle: row.handle,
    name: `${row.firstName} ${row.lastName}`.trim(),
    mentor: mentor ?? isModerator(row.role),
  };
}

export async function loadDiscussionPanel(
  viewer: { id: string; role: Role },
  problemId: string,
  context: HelpContext,
): Promise<DiscussionPanel | null> {
  const state = await getHelpState(viewer.id, problemId, context);
  if (!state) return null;
  const moderator = isModerator(viewer.role);
  const access = discussionAllowed(state, moderator);

  const [posts, doubts, attachable] = await Promise.all([
    access.mayRead
      ? db.discussionPost.findMany({
          where: { problemId: state.problemId, parentId: null },
          orderBy: [{ editorialQuality: "desc" }, { createdAt: "desc" }],
          take: 50,
          select: {
            id: true,
            kind: true,
            bodyMd: true,
            status: true,
            hiddenReason: true,
            editorialQuality: true,
            language: true,
            createdAt: true,
            editedAt: true,
            authorId: true,
            author: { select: AUTHOR_SELECT },
            replies: {
              orderBy: { createdAt: "asc" },
              take: 20,
              select: {
                id: true,
                bodyMd: true,
                status: true,
                createdAt: true,
                authorId: true,
                author: { select: AUTHOR_SELECT },
              },
            },
          },
        })
      : Promise.resolve([]),
    db.doubtThread.findMany({
      where: { problemId: state.problemId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 30,
      select: {
        id: true,
        title: true,
        bodyMd: true,
        status: true,
        createdAt: true,
        authorId: true,
        author: { select: AUTHOR_SELECT },
        replies: {
          orderBy: { createdAt: "asc" },
          take: 30,
          select: {
            id: true,
            bodyMd: true,
            byMentor: true,
            acceptedAt: true,
            createdAt: true,
            authorId: true,
            author: { select: AUTHOR_SELECT },
          },
        },
      },
    }),
    access.mayPost
      ? db.submission.findMany({
          where: { userId: viewer.id, problemId: state.problemId, origin: "PRACTICE", verdict: "AC" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, language: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    problemId: state.problemId,
    access,
    posts: posts.map((post): DiscussionPostView => {
      const isHidden = post.status === "HIDDEN";
      return {
        id: post.id,
        kind: post.kind,
        author: authorOf(post.author),
        // The body of a hidden post never leaves the server.
        html: isHidden ? null : renderMarkdown(post.bodyMd),
        hidden: isHidden ? hiddenNotice(post.hiddenReason ?? "", true) : null,
        editorialQuality: post.editorialQuality,
        language: post.language,
        createdAt: post.createdAt,
        editedAt: post.editedAt,
        mine: post.authorId === viewer.id,
        replies: post.replies
          .filter((reply) => reply.status === "VISIBLE")
          .map((reply) => ({
            id: reply.id,
            author: authorOf(reply.author),
            html: renderMarkdown(reply.bodyMd),
            createdAt: reply.createdAt,
            mine: reply.authorId === viewer.id,
          })),
      };
    }),
    doubts: doubts.map((thread): DoubtThreadView => ({
      id: thread.id,
      title: thread.title,
      author: authorOf(thread.author),
      html: renderMarkdown(thread.bodyMd),
      status: thread.status,
      createdAt: thread.createdAt,
      mine: thread.authorId === viewer.id,
      mayReply: mayReplyToDoubt({ viewerId: viewer.id, askerId: thread.authorId, moderator }),
      replies: thread.replies.map((reply) => ({
        id: reply.id,
        author: authorOf(reply.author, reply.byMentor),
        html: renderMarkdown(reply.bodyMd),
        createdAt: reply.createdAt,
        accepted: reply.acceptedAt !== null,
        mine: reply.authorId === viewer.id,
      })),
    })),
    attachable,
  };
}

// ── Unanswered doubts, for a mentor ─────────────────────────────────────

export interface OpenDoubtView {
  id: string;
  title: string;
  html: string;
  problemSlug: string;
  problemTitle: string;
  author: string;
  createdAt: Date;
  /** Replies so far, so a mentor does not answer what somebody answered. */
  replies: Array<{ id: string; author: string; html: string; byMentor: boolean; createdAt: Date }>;
}

/**
 * Every OPEN question, oldest first (Phase 12d).
 *
 * College-wide and unanswered-first, because the thing a student notices
 * is how long nobody replied. Threads the ASKER has already marked
 * answered are gone from here; a thread with replies but no accepted
 * answer stays, since "somebody said something" is not "it was answered".
 */
export async function loadOpenDoubts(limit = 50): Promise<OpenDoubtView[]> {
  const rows = await db.doubtThread.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      bodyMd: true,
      createdAt: true,
      author: { select: AUTHOR_SELECT },
      problem: { select: { slug: true, title: true } },
      replies: {
        orderBy: { createdAt: "asc" },
        take: 20,
        select: { id: true, bodyMd: true, byMentor: true, createdAt: true, author: { select: AUTHOR_SELECT } },
      },
    },
  });
  return rows.map((thread) => ({
    id: thread.id,
    title: thread.title,
    html: renderMarkdown(thread.bodyMd),
    problemSlug: thread.problem.slug,
    problemTitle: thread.problem.title,
    author: authorOf(thread.author).name,
    createdAt: thread.createdAt,
    replies: thread.replies.map((reply) => ({
      id: reply.id,
      author: authorOf(reply.author, reply.byMentor).name,
      html: renderMarkdown(reply.bodyMd),
      byMentor: reply.byMentor,
      createdAt: reply.createdAt,
    })),
  }));
}

// ── The moderation queue ────────────────────────────────────────────────

export interface ReportView {
  id: string;
  reason: ReportReason;
  detail: string;
  createdAt: Date;
  reporter: string;
  /** The reported thing, rendered for the moderator — who may always read it. */
  target:
    | { kind: "post"; id: string; problemSlug: string; problemTitle: string; author: string; html: string; hidden: boolean; editorialQuality: boolean }
    | { kind: "doubt"; id: string; problemSlug: string; problemTitle: string; author: string; title: string; html: string }
    | { kind: "gone" };
}

export interface ModerationQueue {
  open: ReportView[];
  /** Posts hidden in the last 30 days, so a decision can be looked at again. */
  recentlyHidden: Array<{
    id: string;
    problemSlug: string;
    problemTitle: string;
    author: string;
    reason: string;
    hiddenAt: Date;
    hiddenBy: string;
  }>;
  decidedLast30Days: number;
}

export async function loadModerationQueue(): Promise<ModerationQueue> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const problem = { select: { slug: true, title: true } } as const;
  const [reports, hidden, decided] = await Promise.all([
    db.contentReport.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        id: true,
        reason: true,
        detail: true,
        createdAt: true,
        reporter: { select: AUTHOR_SELECT },
        post: {
          select: {
            id: true,
            bodyMd: true,
            status: true,
            editorialQuality: true,
            author: { select: AUTHOR_SELECT },
            problem,
          },
        },
        doubt: {
          select: { id: true, title: true, bodyMd: true, author: { select: AUTHOR_SELECT }, problem },
        },
      },
    }),
    db.discussionPost.findMany({
      where: { status: "HIDDEN", hiddenAt: { gte: since } },
      orderBy: { hiddenAt: "desc" },
      take: 50,
      select: {
        id: true,
        hiddenReason: true,
        hiddenAt: true,
        author: { select: AUTHOR_SELECT },
        hiddenBy: { select: AUTHOR_SELECT },
        problem,
      },
    }),
    db.contentReport.count({ where: { status: { not: "OPEN" }, resolvedAt: { gte: since } } }),
  ]);

  return {
    open: reports.map((report): ReportView => {
      const base = { id: report.id, reason: report.reason, detail: report.detail, createdAt: report.createdAt };
      const reporter = authorOf(report.reporter).name;
      if (report.post) {
        return {
          ...base,
          reporter,
          target: {
            kind: "post",
            id: report.post.id,
            problemSlug: report.post.problem.slug,
            problemTitle: report.post.problem.title,
            author: authorOf(report.post.author).name,
            html: renderMarkdown(report.post.bodyMd),
            hidden: report.post.status === "HIDDEN",
            editorialQuality: report.post.editorialQuality,
          },
        };
      }
      if (report.doubt) {
        return {
          ...base,
          reporter,
          target: {
            kind: "doubt",
            id: report.doubt.id,
            problemSlug: report.doubt.problem.slug,
            problemTitle: report.doubt.problem.title,
            author: authorOf(report.doubt.author).name,
            title: report.doubt.title,
            html: renderMarkdown(report.doubt.bodyMd),
          },
        };
      }
      return { ...base, reporter, target: { kind: "gone" } };
    }),
    recentlyHidden: hidden.map((post) => ({
      id: post.id,
      problemSlug: post.problem.slug,
      problemTitle: post.problem.title,
      author: authorOf(post.author).name,
      reason: post.hiddenReason ?? "",
      hiddenAt: post.hiddenAt!,
      hiddenBy: post.hiddenBy ? authorOf(post.hiddenBy).name : "a moderator",
    })),
    decidedLast30Days: decided,
  };
}
