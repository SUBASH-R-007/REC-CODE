"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button, useToast } from "@recx/design";
import { changeEnrollment } from "@/server/actions/plans";

/**
 * Enroll / Leave for one study plan. A real <form> bound to a server action
 * through useActionState, so it also works before hydration (or without
 * JavaScript): the action revalidates the page, which re-renders with the
 * new state. The button is never disabled while pending — disabling a
 * focused button drops keyboard focus — and both operations are idempotent,
 * so a double submit is harmless. The outcome is announced once through the
 * toast region.
 */
export function EnrollForm({ planId, enrolled, noun }: { planId: string; enrolled: boolean; noun: string }) {
  const [state, formAction, pending] = useActionState(changeEnrollment, null);
  const { toast } = useToast();
  const announced = useRef<typeof state>(null);

  useEffect(() => {
    if (!state || announced.current === state) return;
    announced.current = state;
    if (!state.ok) {
      toast(state.error, "error");
    } else if (state.data.enrolled) {
      toast(`Enrolled — ${state.data.itemsDone} of ${state.data.itemsTotal} already solved.`, "success");
    } else {
      toast(`You left this ${noun}. Your solved problems stay solved.`, "info");
    }
  }, [state, toast, noun]);

  return (
    <form action={formAction} aria-busy={pending || undefined}>
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="intent" value={enrolled ? "leave" : "enroll"} />
      <Button type="submit" variant={enrolled ? "outline" : "primary"} className="h-11 min-w-32">
        {pending ? (enrolled ? "Leaving…" : "Enrolling…") : enrolled ? `Leave ${noun}` : "Enroll"}
      </Button>
    </form>
  );
}
