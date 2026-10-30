"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import { Button, Field, Textarea, useToast } from "@recx/design";
import { WRITTEN_LIMITS, WRITTEN_NOTICES } from "@recx/shared";
import { saveWrittenDraft, submitWrittenAnswer } from "@/server/actions/written";

const SAVE_AFTER_MS = 3_000;

/**
 * The answer box (Phase 12i).
 *
 * The draft saves itself three seconds after the typing stops, and says
 * when it last did. A student writing for forty minutes in a browser tab
 * should not lose it to a closed laptop, and "Saved" written on the page
 * is the only way they can tell that is true.
 *
 * Handing in is a separate press with a confirmation, because it is the
 * one thing here they cannot undo — after that only the TA can give it
 * back.
 */
export function AnswerForm({
  promptId,
  initialBody,
  handBackNote,
}: {
  promptId: string;
  initialBody: string;
  handBackNote: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [bodyMd, setBody] = useState(initialBody);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, startTransition] = useTransition();
  const lastSaved = useRef(initialBody);

  useEffect(() => {
    if (bodyMd === lastSaved.current) return;
    const timer = setTimeout(() => {
      const text = bodyMd;
      setSaving(true);
      void saveWrittenDraft({ promptId, bodyMd: text })
        .then((result) => {
          if (result.ok) {
            lastSaved.current = text;
            setSavedAt(new Date());
          }
        })
        .finally(() => setSaving(false));
    }, SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [bodyMd, promptId]);

  const words = bodyMd.trim().split(/\s+/).filter(Boolean).length;
  const short = bodyMd.trim().length < WRITTEN_LIMITS.answer.min;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await submitWrittenAnswer({ promptId, bodyMd });
          if (!result.ok) {
            toast(result.error, "error");
            return;
          }
          toast("Handed in. A TA reads it next.", "success");
          router.refresh();
        });
      }}
    >
      {handBackNote ? (
        <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          <span className="font-medium">Handed back unmarked:</span> {handBackNote}
        </p>
      ) : null}

      <Field
        label="Your answer"
        htmlFor="written-answer"
        hint="Markdown. Headings and lists help the person reading it; diagrams in words are fine."
      >
        <Textarea
          id="written-answer"
          rows={18}
          value={bodyMd}
          maxLength={WRITTEN_LIMITS.answer.max}
          onChange={(e) => setBody(e.target.value)}
          className="font-mono text-sm"
        />
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted" aria-live="polite">
          {saving
            ? "Saving…"
            : savedAt
              ? `Draft saved at ${savedAt.toLocaleTimeString("en-IN")}`
              : "Your draft saves itself as you write."}{" "}
          · {words} words
        </p>
        <Button type="submit" className="min-h-11" loading={pending} disabled={short}>
          <Send className="h-4 w-4" aria-hidden />
          Hand it in
        </Button>
      </div>
      {short ? (
        <p className="text-xs text-muted">
          At least {WRITTEN_LIMITS.answer.min} characters before you can hand it in.
        </p>
      ) : null}
      <p className="text-xs text-muted">{WRITTEN_NOTICES.graderSeesName}</p>
    </form>
  );
}
