"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button, Dialog, Field, Textarea, useToast } from "@recx/design";
import { DISCUSSION_LIMITS } from "@recx/shared";
import {
  hideDiscussionPost,
  markPostEditorial,
  resolveContentReport,
  unhideDiscussionPost,
} from "@/server/actions/moderation";

/**
 * A moderator's buttons on one report (Phase 12d).
 *
 * Deciding the report and hiding the post are two buttons on purpose. One
 * button that quietly did both is how a queue gets cleared without anybody
 * reading it, and the author would be shown a reason written to close a
 * ticket rather than to explain a decision. Both ask for a sentence; the
 * hiding one is the sentence the author sees.
 */
export function ModerationActions({
  reportId,
  post,
}: {
  reportId: string;
  post: { id: string; hidden: boolean; editorialQuality: boolean } | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [hiding, setHiding] = useState(false);
  const [deciding, setDeciding] = useState<null | { upheld: boolean }>(null);

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {post && !post.hidden ? (
        <Button size="sm" variant="danger" className="min-h-11" onClick={() => setHiding(true)}>
          <EyeOff className="h-4 w-4" aria-hidden />
          Hide the post
        </Button>
      ) : null}
      {post && post.hidden ? <UnhideButton postId={post.id} /> : null}
      {post && !post.hidden ? (
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await markPostEditorial({ postId: post.id, editorial: !post.editorialQuality });
              toast(
                result.ok ? (post.editorialQuality ? "No longer recommended." : "Marked as worth reading first.") : result.error,
                result.ok ? "success" : "error",
              );
              if (result.ok) router.refresh();
            })
          }
        >
          <Star className="h-4 w-4" aria-hidden />
          {post.editorialQuality ? "Un-recommend" : "Worth reading first"}
        </Button>
      ) : null}

      <Button size="sm" variant="outline" className="min-h-11" onClick={() => setDeciding({ upheld: true })}>
        <ThumbsUp className="h-4 w-4" aria-hidden />
        Report was right
      </Button>
      <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setDeciding({ upheld: false })}>
        <ThumbsDown className="h-4 w-4" aria-hidden />
        Nothing wrong with it
      </Button>

      {hiding && post ? (
        <ReasonDialog
          title="Hide this post"
          confirmLabel="Hide it"
          hint="The author is shown this, word for word."
          danger
          onClose={() => setHiding(false)}
          onConfirm={async (reason) => {
            const result = await hideDiscussionPost({ postId: post.id, reason });
            if (result.ok) {
              toast("Hidden. The author is shown your reason.", "success");
              router.refresh();
            } else {
              toast(result.error, "error");
            }
            setHiding(false);
          }}
        />
      ) : null}

      {deciding ? (
        <ReasonDialog
          title={deciding.upheld ? "Close it: the report was right" : "Close it: nothing wrong with the post"}
          confirmLabel="Close the report"
          hint="For the record, and for whoever reads this queue next. Deciding the report does not hide anything on its own."
          onClose={() => setDeciding(null)}
          onConfirm={async (resolution) => {
            const result = await resolveContentReport({ reportId, upheld: deciding.upheld, resolution });
            if (result.ok) {
              toast("Closed.", "success");
              router.refresh();
            } else {
              toast(result.error, "error");
            }
            setDeciding(null);
          }}
        />
      ) : null}
    </div>
  );
}

export function UnhideButton({ postId }: { postId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      className="min-h-11"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await unhideDiscussionPost({ postId });
          toast(result.ok ? "Visible again." : result.error, result.ok ? "success" : "error");
          if (result.ok) router.refresh();
        })
      }
    >
      <Eye className="h-4 w-4" aria-hidden />
      Show it again
    </Button>
  );
}

function ReasonDialog({
  title,
  confirmLabel,
  hint,
  danger,
  onClose,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  hint: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open onClose={onClose} title={title} size="sm">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(() => void onConfirm(reason));
        }}
      >
        <Field label="Why?" htmlFor="moderation-reason" hint={hint}>
          <Textarea
            id="moderation-reason"
            rows={3}
            required
            minLength={DISCUSSION_LIMITS.moderationReason.min}
            maxLength={DISCUSSION_LIMITS.moderationReason.max}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" className="min-h-11" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} className="min-h-11" loading={pending}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
