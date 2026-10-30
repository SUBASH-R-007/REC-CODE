"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import { Button, Textarea, useToast } from "@recx/design";
import { DISCUSSION_LIMITS } from "@recx/shared";
import { replyToDoubt } from "@/server/actions/discussion";

/**
 * A mentor's answer on the questions queue (Phase 12d).
 *
 * The same action a student uses to answer their own question —
 * `discussion#replyToDoubt` — because there is nothing different to do.
 * What makes it a mentor's answer is the role the SERVER reads when it
 * writes the row: `byMentor` is frozen there and the badge stays on the
 * reply for good, so an answer given by a TA still reads as one after they
 * graduate.
 */
export function MentorAnswerForm({ threadId, title }: { threadId: string; title: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await replyToDoubt({ threadId, bodyMd: body });
          if (!result.ok) {
            toast(result.error, "error");
            return;
          }
          setBody("");
          toast("Answered. It carries your TA / mentor badge.", "success");
          router.refresh();
        });
      }}
    >
      <Textarea
        aria-label={`Answer "${title}"`}
        rows={4}
        required
        minLength={DISCUSSION_LIMITS.replyBody.min}
        maxLength={DISCUSSION_LIMITS.replyBody.max}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Name the idea they are missing. Not the whole answer."
      />
      <Button type="submit" size="sm" className="min-h-11" loading={pending}>
        <Send className="h-4 w-4" aria-hidden />
        Answer
      </Button>
    </form>
  );
}
