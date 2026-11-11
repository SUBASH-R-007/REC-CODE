"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { Button, Field, Input, Select, useToast } from "@recx/design";
import { MOCK_INTERVIEW_LIMITS } from "@recx/shared";
import { offerMockSlot } from "@/server/actions/mock-interviews";

const DURATIONS = [30, 45, 60] as const;

/**
 * Offer one slot (Phase 12h).
 *
 * The time is a `datetime-local`, read as IST by the server
 * (`parseIstLocalDateTime`) rather than by the browser. A mentor in a lab
 * and a mentor at home must mean the same thing by "3pm", and the one
 * thing a browser's timezone is guaranteed to be is whatever that machine
 * was set to.
 */
export function OfferSlot() {
  const router = useRouter();
  const { toast } = useToast();
  const [startsAtLocal, setStartsAtLocal] = useState("");
  const [durationMinutes, setDuration] = useState<number>(45);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await offerMockSlot({ startsAtLocal, durationMinutes });
          if (!result.ok) {
            toast(result.error, "error");
            return;
          }
          toast("Offered. Students can book it now.", "success");
          setStartsAtLocal("");
          router.refresh();
        });
      }}
    >
      <Field label="When (IST)" htmlFor="slot-start" hint="Read as campus time, not your machine's.">
        <Input
          id="slot-start"
          type="datetime-local"
          required
          value={startsAtLocal}
          onChange={(e) => setStartsAtLocal(e.target.value)}
        />
      </Field>
      <Field label="How long" htmlFor="slot-duration">
        <Select id="slot-duration" value={String(durationMinutes)} onChange={(e) => setDuration(Number(e.target.value))}>
          {DURATIONS.filter(
            (d) => d >= MOCK_INTERVIEW_LIMITS.durationMinutes.min && d <= MOCK_INTERVIEW_LIMITS.durationMinutes.max,
          ).map((d) => (
            <option key={d} value={d}>
              {d} minutes
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" className="min-h-11" loading={pending}>
        <CalendarPlus className="h-4 w-4" aria-hidden />
        Offer it
      </Button>
    </form>
  );
}
