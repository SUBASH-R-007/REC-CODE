"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Textarea } from "@recx/design";
import { clearRestriction, dismissReviewItem } from "@/server/actions/admin-inactivity";

/**
 * The two things a human can do with a review item (Phase 8d).
 *
 * Both need a written reason, and that is not bureaucracy: the student reads
 * the clearing reason in their own history, and the dismissal note is what
 * the next person to open the queue reads instead of wondering whether
 * anybody looked.
 *
 * There is no "restrict" button here, and there never will be. The sweep
 * restricts from the policy, with evidence; a staff member who wants somebody
 * restricted sooner changes the policy rather than reaching past it.
 */
export function ReviewActions({ userId, name, canClear }: { userId: string; name: string; canClear: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const act = (what: "clear" | "dismiss") => {
    setError(null);
    if (text.trim().length < 10) {
      setError("Say why, in ten characters or more — the student reads this.");
      return;
    }
    start(async () => {
      const result =
        what === "clear"
          ? await clearRestriction({ userId, reason: text.trim() })
          : await dismissReviewItem({ userId, note: text.trim() });
      if (!result.ok) setError(result.error);
      else {
        setText("");
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-3">
      <Field
        label={`Why — ${name} will read this`}
        htmlFor={`note-${userId}`}
        hint="A sentence is enough. It goes in their own history, and in the audit log."
        error={error}
      >
        <Textarea
          id={`note-${userId}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Spoke to them — they were in hospital and have since asked for the days to be excused."
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        {canClear ? (
          <Button type="button" loading={pending} onClick={() => act("clear")}>
            Lift the restriction
          </Button>
        ) : (
          <p className="text-sm text-text-secondary">
            Reopening a paused account is a super-admin&apos;s to do. Ask the placement cell — this is deliberately not
            something department staff can do alone.
          </p>
        )}
        <Button type="button" variant="secondary" loading={pending} onClick={() => act("dismiss")}>
          I have looked — close this item
        </Button>
      </div>
    </div>
  );
}
