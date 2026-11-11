"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, BadgeCheck, CheckCircle2, Flag, Lock, MessageSquarePlus, Send, Star } from "lucide-react";
import { Badge, Button, Dialog, EmptyState, Field, Input, Select, Textarea, useToast } from "@recx/design";
import {
  DISCUSSION_KIND_HINT,
  DISCUSSION_KIND_LABEL,
  DISCUSSION_LIMITS,
  DISCUSSION_POST_KINDS,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  formatCampusTime,
  type DiscussionPostKind,
  type ReportReason,
} from "@recx/shared";
import {
  acceptDoubtAnswer,
  askDoubt,
  createDiscussionPost,
  replyToDiscussionPost,
  replyToDoubt,
  reportContent,
} from "@/server/actions/discussion";
import { HELP_PROSE } from "@/components/help/prose";
import type { DiscussionPanel, DiscussionPostView, DoubtThreadView } from "@/server/queries/discussion";

/**
 * The Discussion tab's interactive half (Phase 12d).
 *
 * Everything shown here was decided on the server; this component sends
 * ids and text, and every action re-asks the gate. The one thing it does
 * decide is what to OFFER: a locked compose box with the reason beside it
 * rather than a button that fails, because a control that refuses after
 * you have written three paragraphs is worse than no control.
 */
export function DiscussionBoard({ panel }: { panel: DiscussionPanel }) {
  return (
    <div className="space-y-8">
      <Doubts panel={panel} />
      <Solutions panel={panel} />
    </div>
  );
}

// ── Doubts ──────────────────────────────────────────────────────────────

function Doubts({ panel }: { panel: DiscussionPanel }) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-sm font-semibold">Questions</h3>
        <Button size="sm" variant="outline" className="min-h-11" onClick={() => setAsking(true)}>
          <MessageSquarePlus className="h-4 w-4" aria-hidden />
          Ask a question
        </Button>
      </div>
      <p className="text-sm text-text-secondary">
        Open to everyone, solved or not. A TA or mentor answers, and so can you on your own question.
      </p>

      {panel.doubts.length === 0 ? (
        <EmptyState compact title="No questions yet" description="Be the first to ask what you are stuck on." />
      ) : (
        <ul className="space-y-3">
          {panel.doubts.map((thread) => (
            <li key={thread.id}>
              <DoubtCard thread={thread} />
            </li>
          ))}
        </ul>
      )}

      {asking && <AskDialog problemId={panel.problemId} onClose={() => setAsking(false)} />}
    </div>
  );
}

function DoubtCard({ thread }: { thread: DoubtThreadView }) {
  const router = useRouter();
  const { toast } = useToast();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [reporting, setReporting] = useState(false);

  return (
    <article className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="font-display text-sm font-semibold">{thread.title}</h4>
        <span className="flex items-center gap-2">
          {thread.status === "ANSWERED" ? (
            <Badge tone="success">
              <CheckCircle2 className="h-3 w-3" aria-hidden />
              Answered
            </Badge>
          ) : (
            <Badge>Open</Badge>
          )}
          <ReportButton onClick={() => setReporting(true)} />
        </span>
      </div>
      <Byline author={thread.author} at={thread.createdAt} mine={thread.mine} />
      <div className={`${HELP_PROSE} mt-2`} dangerouslySetInnerHTML={{ __html: thread.html }} />

      {thread.replies.length > 0 && (
        <ol className="mt-3 space-y-3 border-l-2 border-border pl-3">
          {thread.replies.map((reply) => (
            <li key={reply.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Byline author={reply.author} at={reply.createdAt} mine={reply.mine} />
                {reply.accepted ? (
                  <Badge tone="success">
                    <CheckCircle2 className="h-3 w-3" aria-hidden />
                    The answer
                  </Badge>
                ) : thread.mine && !reply.mine ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await acceptDoubtAnswer({ replyId: reply.id });
                        toast(result.ok ? "Marked as the answer." : result.error, result.ok ? "success" : "error");
                        if (result.ok) router.refresh();
                      })
                    }
                  >
                    This answered it
                  </Button>
                ) : null}
              </div>
              <div className={`${HELP_PROSE} mt-1`} dangerouslySetInnerHTML={{ __html: reply.html }} />
            </li>
          ))}
        </ol>
      )}

      {thread.mayReply ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const result = await replyToDoubt({ threadId: thread.id, bodyMd: body });
              if (!result.ok) {
                toast(result.error, "error");
                return;
              }
              setBody("");
              router.refresh();
            });
          }}
        >
          <Textarea
            aria-label={`Reply to "${thread.title}"`}
            rows={3}
            required
            maxLength={DISCUSSION_LIMITS.replyBody.max}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Answer, or add what you have tried since."
          />
          <Button type="submit" size="sm" className="min-h-11" loading={pending}>
            <Send className="h-4 w-4" aria-hidden />
            Reply
          </Button>
        </form>
      ) : (
        <p className="mt-3 text-xs text-muted">
          Only {thread.author.name.split(" ")[0]} and a TA or mentor can reply here.
        </p>
      )}

      {reporting && <ReportDialog doubtId={thread.id} onClose={() => setReporting(false)} />}
    </article>
  );
}

function AskDialog({ problemId, onClose }: { problemId: string; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} title="Ask about this problem" size="md">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await askDoubt({ problemId, title, bodyMd: body });
            if (!result.ok) {
              toast(result.error, "error");
              return;
            }
            toast("Asked. A TA or mentor will see it.", "success");
            onClose();
            router.refresh();
          });
        }}
      >
        <Field label="What are you stuck on?" htmlFor="doubt-title" hint="One sentence. It is what people see first.">
          <Input
            id="doubt-title"
            required
            minLength={DISCUSSION_LIMITS.doubtTitle.min}
            maxLength={DISCUSSION_LIMITS.doubtTitle.max}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field
          label="Tell them what you have tried"
          htmlFor="doubt-body"
          hint="Markdown. The more of your own thinking you show, the better the answer."
        >
          <Textarea
            id="doubt-body"
            rows={6}
            required
            minLength={DISCUSSION_LIMITS.doubtBody.min}
            maxLength={DISCUSSION_LIMITS.doubtBody.max}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" className="min-h-11" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" className="min-h-11" loading={pending}>
            Ask
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ── Solutions and tips ──────────────────────────────────────────────────

function Solutions({ panel }: { panel: DiscussionPanel }) {
  return (
    <div className="space-y-3">
      <h3 className="font-display text-sm font-semibold">Solutions and tips</h3>

      {!panel.access.mayRead ? (
        <EmptyState
          compact
          icon={<Lock className="h-5 w-5" />}
          title="Solve it first"
          description={panel.access.readReason ?? ""}
        />
      ) : (
        <>
          {panel.access.mayPost ? (
            <Composer panel={panel} />
          ) : (
            <p className="flex items-start gap-2 rounded-xl border border-border bg-background p-3 text-sm text-text">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span>{panel.access.postReason}</span>
            </p>
          )}

          {panel.posts.length === 0 ? (
            <EmptyState compact title="Nothing shared yet" description="Be the first to explain how you did it." />
          ) : (
            <ul className="space-y-3">
              {panel.posts.map((post) => (
                <li key={post.id}>
                  <PostCard post={post} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Composer({ panel }: { panel: DiscussionPanel }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DiscussionPostKind>("SOLUTION");
  const [body, setBody] = useState("");
  const [submissionId, setSubmissionId] = useState("");
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <Button variant="outline" className="min-h-11" onClick={() => setOpen(true)}>
        <MessageSquarePlus className="h-4 w-4" aria-hidden />
        Share how you solved it
      </Button>
    );
  }

  return (
    <form
      className="space-y-3 rounded-2xl border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await createDiscussionPost({
            problemId: panel.problemId,
            kind,
            bodyMd: body,
            submissionId: submissionId || null,
          });
          if (!result.ok) {
            toast(result.error, "error");
            return;
          }
          setBody("");
          setSubmissionId("");
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <Field label="What are you posting?" htmlFor="post-kind" hint={DISCUSSION_KIND_HINT[kind]}>
        <Select id="post-kind" value={kind} onChange={(e) => setKind(e.target.value as DiscussionPostKind)}>
          {DISCUSSION_POST_KINDS.map((value) => (
            <option key={value} value={value}>
              {DISCUSSION_KIND_LABEL[value]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Your explanation" htmlFor="post-body" hint="Markdown.">
        <Textarea
          id="post-body"
          rows={8}
          required
          minLength={DISCUSSION_LIMITS.body.min}
          maxLength={DISCUSSION_LIMITS.body.max}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      {panel.attachable.length > 0 && (
        <Field
          label="Attach one of your accepted submissions"
          htmlFor="post-submission"
          hint="Optional, and only your own — the code the judge actually accepted."
        >
          <Select id="post-submission" value={submissionId} onChange={(e) => setSubmissionId(e.target.value)}>
            <option value="">Do not attach code</option>
            {panel.attachable.map((submission) => (
              <option key={submission.id} value={submission.id}>
                {submission.language} · {formatCampusTime(submission.createdAt)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" className="min-h-11" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" className="min-h-11" loading={pending}>
          Post
        </Button>
      </div>
    </form>
  );
}

function PostCard({ post }: { post: DiscussionPostView }) {
  const router = useRouter();
  const { toast } = useToast();
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState("");
  const [reporting, setReporting] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <article className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={post.kind === "SOLUTION" ? "primary" : undefined}>{DISCUSSION_KIND_LABEL[post.kind]}</Badge>
          {post.editorialQuality ? (
            <Badge tone="success">
              <Star className="h-3 w-3" aria-hidden />
              Worth reading first
            </Badge>
          ) : null}
          {post.language ? <span className="font-mono text-xs text-muted">{post.language}</span> : null}
        </span>
        <ReportButton onClick={() => setReporting(true)} />
      </div>
      <Byline author={post.author} at={post.createdAt} mine={post.mine} edited={post.editedAt !== null} />

      {post.hidden ? (
        <p className="mt-2 flex items-start gap-2 rounded-xl border border-border bg-background p-3 text-sm text-text-secondary">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{post.hidden}</span>
        </p>
      ) : (
        <div className={`${HELP_PROSE} mt-2`} dangerouslySetInnerHTML={{ __html: post.html ?? "" }} />
      )}

      {post.replies.length > 0 && (
        <ol className="mt-3 space-y-3 border-l-2 border-border pl-3">
          {post.replies.map((reply) => (
            <li key={reply.id}>
              <Byline author={reply.author} at={reply.createdAt} mine={reply.mine} />
              <div className={`${HELP_PROSE} mt-1`} dangerouslySetInnerHTML={{ __html: reply.html }} />
            </li>
          ))}
        </ol>
      )}

      {post.hidden === null &&
        (replying ? (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const result = await replyToDiscussionPost({ parentId: post.id, bodyMd: body });
                if (!result.ok) {
                  toast(result.error, "error");
                  return;
                }
                setBody("");
                setReplying(false);
                router.refresh();
              });
            }}
          >
            <Textarea
              aria-label="Your reply"
              rows={3}
              required
              maxLength={DISCUSSION_LIMITS.replyBody.max}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" className="min-h-11" loading={pending}>
                Reply
              </Button>
              <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={() => setReplying(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button size="sm" variant="ghost" className="mt-2 min-h-11" onClick={() => setReplying(true)}>
            Reply
          </Button>
        ))}

      {reporting && <ReportDialog postId={post.id} onClose={() => setReporting(false)} />}
    </article>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────

function Byline({
  author,
  at,
  mine,
  edited,
}: {
  author: { name: string; handle: string; mentor: boolean };
  at: Date;
  mine: boolean;
  edited?: boolean;
}) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span className="font-medium text-text-secondary">{mine ? "You" : author.name}</span>
      {author.mentor ? (
        <Badge tone="primary">
          <BadgeCheck className="h-3 w-3" aria-hidden />
          TA / mentor
        </Badge>
      ) : null}
      <span>{formatCampusTime(at)}</span>
      {edited ? <span>· edited</span> : null}
    </p>
  );
}

function ReportButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick} aria-label="Report this">
      <Flag className="h-4 w-4" aria-hidden />
      Report
    </Button>
  );
}

function ReportDialog({ postId, doubtId, onClose }: { postId?: string; doubtId?: string; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [reason, setReason] = useState<ReportReason>("SPOILER");
  const [detail, setDetail] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} title="Report this to a moderator" size="sm">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await reportContent({
              postId: postId ?? null,
              doubtId: doubtId ?? null,
              reason,
              detail,
            });
            if (!result.ok) {
              toast(result.error, "error");
              return;
            }
            toast("Reported. A TA or mentor will look at it.", "success");
            onClose();
            router.refresh();
          });
        }}
      >
        <Field label="What is wrong with it?" htmlFor="report-reason">
          <Select id="report-reason" value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
            {REPORT_REASONS.map((value) => (
              <option key={value} value={value}>
                {REPORT_REASON_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Anything else the moderator should know?" htmlFor="report-detail">
          <Textarea
            id="report-detail"
            rows={3}
            required
            minLength={DISCUSSION_LIMITS.reportReason.min}
            maxLength={DISCUSSION_LIMITS.reportReason.max}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" className="min-h-11" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" className="min-h-11" loading={pending}>
            Report
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
