"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select } from "@recx/design";
import { CALENDAR_DAY_KINDS, CALENDAR_DAY_KIND_LABEL, type CalendarDayKind } from "@recx/shared";
import { markCalendarRange, upsertCalendarDay } from "@/server/actions/super-calendar";

/**
 * Writing the calendar (Phase 8a).
 *
 * One form, two actions: a single day and a run of days. The run exists
 * because a term entered day by day is two hundred clicks, and a calendar
 * nobody finishes entering is a calendar the inactivity counter refuses to
 * escalate from — so the complete calendar has to be the easy one.
 *
 * `isWorkingDay` is a separate control from `kind`, not derived from it: an
 * exam week is a working week, and the two columns are read separately by the
 * counter. Each one's hint says what it does, because an operator guessing at
 * that is an operator who excludes the wrong days.
 */
export function CalendarDayForm({ defaultMonth }: { defaultMonth: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"day" | "range">("day");
  const [fromDay, setFromDay] = useState(`${defaultMonth}-01`);
  const [toDay, setToDay] = useState(`${defaultMonth}-01`);
  const [kind, setKind] = useState<CalendarDayKind>("HOLIDAY");
  const [isWorkingDay, setWorkingDay] = useState(false);
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const submit = () => {
    setMessage(null);
    start(async () => {
      const result =
        mode === "day"
          ? await upsertCalendarDay({ date: fromDay, kind, isWorkingDay, label })
          : await markCalendarRange({ fromDay, toDay, kind, isWorkingDay, label });
      if (!result.ok) {
        setMessage({ tone: "bad", text: result.error });
        return;
      }
      const written = "written" in result.data ? result.data.written : 1;
      const skipped = "skippedPast" in result.data ? result.data.skippedPast : 0;
      setMessage({
        tone: "ok",
        text:
          skipped > 0
            ? `${written} day${written === 1 ? "" : "s"} written. ${skipped} already in the past and left alone.`
            : `${written} day${written === 1 ? "" : "s"} written.`,
      });
      setLabel("");
      router.refresh();
    });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium">What are you entering?</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(["day", "range"] as const).map((value) => (
            <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="calendar-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              <span>{value === "day" ? "One day" : "A run of days"}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={mode === "day" ? "Date" : "First day"} htmlFor="cal-from">
          <Input id="cal-from" type="date" value={fromDay} onChange={(event) => setFromDay(event.target.value)} required />
        </Field>
        {mode === "range" ? (
          <Field label="Last day" htmlFor="cal-to">
            <Input id="cal-to" type="date" value={toDay} onChange={(event) => setToDay(event.target.value)} required />
          </Field>
        ) : null}
      </div>

      <Field
        label="What kind of day"
        htmlFor="cal-kind"
        hint="Anything other than a regular day is never counted against a student, whatever the working-day box says."
      >
        <Select id="cal-kind" value={kind} onChange={(event) => setKind(event.target.value as CalendarDayKind)}>
          {CALENDAR_DAY_KINDS.map((option) => (
            <option key={option} value={option}>
              {CALENDAR_DAY_KIND_LABEL[option]}
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={isWorkingDay}
            onChange={(event) => setWorkingDay(event.target.checked)}
            aria-describedby="cal-working-hint"
          />
          <span>The college is working this day</span>
        </label>
        <p id="cal-working-hint" className="mt-1 text-xs text-muted">
          Separate from the kind above, and true for an exam or placement week — those are working weeks. Untick it for
          Sundays and declared closures. This is the box the inactivity policy&apos;s &ldquo;exclude non-working
          days&rdquo; setting switches.
        </p>
      </div>

      <Field
        label="What to call it"
        htmlFor="cal-label"
        hint="Somebody will read this months later while checking why a student was not counted. Name it as the college's own circular does."
      >
        <Input
          id="cal-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={120}
          placeholder="Pongal, CAT-2 week, Semester break"
          required
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending}>
          {mode === "day" ? "Write this day" : "Write these days"}
        </Button>
        {message ? (
          <p
            role={message.tone === "bad" ? "alert" : "status"}
            className={`text-sm ${message.tone === "bad" ? "text-danger" : "text-success"}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        A day already past cannot be changed: evidence rows cite days by date, so editing one would rewrite the
        explanation of a decision already taken. To put right a day that was counted wrongly, approve a leave covering
        it.
      </p>
    </form>
  );
}
