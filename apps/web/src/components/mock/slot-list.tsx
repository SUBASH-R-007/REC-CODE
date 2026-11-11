"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarPlus, DoorOpen, UserX, X } from "lucide-react";
import { Badge, Button, Dialog, Field, Textarea, useToast } from "@recx/design";
import {
  MOCK_CANCEL_CUTOFF_MINUTES,
  MOCK_INTERVIEW_STATUS_LABEL,
  MOCK_JOIN_BEFORE_MINUTES,
  formatCampusTime,
} from "@recx/shared";
import {
  bookMockSlot,
  cancelMockInterview,
  giveUpMockSlot,
  markMockNoShow,
} from "@/server/actions/mock-interviews";
import type { MockSlotView } from "@/server/queries/mock-interviews";

const TONE: Partial<Record<MockSlotView["status"], "success" | "warning" | "danger" | "primary">> = {
  IN_PROGRESS: "primary",
  COMPLETED: "success",
  CANCELLED: "danger",
  NO_SHOW: "warning",
};

/**
 * One slot, with whichever buttons the viewer's side of it allows
 * (Phase 12h).
 *
 * Which buttons appear is decided on the server (`joinable`, `giveUpOpen`,
 * `noShowOpen` on the view) and every action re-checks ownership and the
 * transition anyway. The page's job is not to offer a control that will
 * refuse.
 */
export function SlotRow({ slot, as }: { slot: MockSlotView; as: "MENTOR" | "CANDIDATE" | "BROWSING" }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [cancelling, setCancelling] = useState(false);

  const run = (what: Promise<{ ok: boolean; error?: string }>, done: string) =>
    startTransition(async () => {
      const result = await what;
      toast(result.ok ? done : (result.error ?? "That did not work."), result.ok ? "success" : "error");
      if (result.ok) router.refresh();
    });

  return (
    <li className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-sm font-semibold">
            {formatCampusTime(slot.startsAt)} · {slot.durationMinutes} min
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {as === "MENTOR"
              ? slot.candidate
                ? `With ${slot.candidate}`
                : "Nobody has booked it yet"
              : `With ${slot.mentor}`}
            {slot.problem ? ` · ${slot.problem.displayCode} ${slot.problem.title}` : ""}
          </p>
        </div>
        <Badge tone={TONE[slot.status]}>{MOCK_INTERVIEW_STATUS_LABEL[slot.status]}</Badge>
      </div>

      {slot.cancelReason ? (
        <p className="mt-2 text-sm text-text-secondary">
          Called off by {slot.cancelledBy}: {slot.cancelReason}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {slot.joinable ? (
          <Link
            href={`/mock-interviews/${slot.id}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover"
          >
            <DoorOpen className="h-4 w-4" aria-hidden />
            Go in
          </Link>
        ) : null}

        {as === "BROWSING" && slot.status === "OPEN" ? (
          <Button
            size="sm"
            className="min-h-11"
            loading={pending}
            onClick={() => run(bookMockSlot({ interviewId: slot.id }), "Booked. It is in your list now.")}
          >
            <CalendarPlus className="h-4 w-4" aria-hidden />
            Book it
          </Button>
        ) : null}

        {as === "CANDIDATE" && slot.giveUpOpen ? (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            loading={pending}
            onClick={() => run(giveUpMockSlot({ interviewId: slot.id }), "Given back. Somebody else can take it.")}
          >
            Give it back
          </Button>
        ) : null}

        {as === "MENTOR" && slot.noShowOpen ? (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            loading={pending}
            onClick={() => run(markMockNoShow({ interviewId: slot.id }), "Marked as nobody came.")}
          >
            <UserX className="h-4 w-4" aria-hidden />
            Nobody came
          </Button>
        ) : null}

        {(as === "MENTOR" || as === "CANDIDATE") && ["OPEN", "BOOKED", "IN_PROGRESS"].includes(slot.status) ? (
          <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setCancelling(true)}>
            <X className="h-4 w-4" aria-hidden />
            Call it off
          </Button>
        ) : null}
      </div>

      {as === "CANDIDATE" && slot.status === "BOOKED" && !slot.giveUpOpen ? (
        <p className="mt-2 text-xs text-muted">
          It is less than {MOCK_CANCEL_CUTOFF_MINUTES} minutes away, so it cannot be given back — but you can still
          call it off and say why. The room opens {MOCK_JOIN_BEFORE_MINUTES} minutes before.
        </p>
      ) : null}

      {slot.feedback ? (
        <div className="mt-3 rounded-xl border border-border bg-background p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Feedback · {formatCampusTime(slot.feedback.at)}
          </p>
          <p className="mt-1 text-sm">
            Explaining {slot.feedback.communication}/5 · Approach {slot.feedback.problemSolving}/5 · Code{" "}
            {slot.feedback.code}/5
          </p>
          <div
            className="mt-2 text-sm leading-relaxed [&_p]:my-2 [&_p:first-child]:mt-0"
            dangerouslySetInnerHTML={{ __html: slot.feedback.html }}
          />
        </div>
      ) : null}

      {cancelling ? (
        <CancelDialog
          interviewId={slot.id}
          onClose={() => setCancelling(false)}
          onDone={() => {
            setCancelling(false);
            router.refresh();
          }}
        />
      ) : null}
    </li>
  );
}

function CancelDialog({
  interviewId,
  onClose,
  onDone,
}: {
  interviewId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open onClose={onClose} title="Call this interview off" size="sm">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const result = await cancelMockInterview({ interviewId, reason });
            if (!result.ok) {
              toast(result.error, "error");
              return;
            }
            toast("Called off. The other person is shown your reason.", "success");
            onDone();
          });
        }}
      >
        <Field label="Why?" htmlFor="mock-cancel" hint="The other person is shown this, word for word.">
          <Textarea
            id="mock-cancel"
            rows={3}
            required
            minLength={10}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" className="min-h-11" onClick={onClose} disabled={pending}>
            Keep it
          </Button>
          <Button type="submit" variant="danger" className="min-h-11" loading={pending}>
            Call it off
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
