"use client";

import { useId, useState } from "react";
import { Eye } from "lucide-react";

/**
 * The "Monitored" chip (Phase 6c).
 *
 * SPEC §5: "A persistent small 'Monitored' chip whose tooltip lists exactly
 * what is recorded." And the reasoning, from the same section:
 *
 *   No silent trapping: the deterrent requires awareness, and transparency
 *   also removes the "I didn't know" appeal. Publishing the signal list tells
 *   cheaters what to suppress — accepted knowingly, because the signals are
 *   suppressible anyway, suppression often triggers SNAPSHOT_JUMP, and
 *   secrecy would buy nothing while costing the fairness that makes the
 *   system defensible.
 *
 * So the list is complete and in plain words. It is a disclosure, not a
 * warning: the wording says what is recorded, never what will happen to the
 * candidate, and the chip claims no more than "monitored and recorded".
 *
 * It is a `<details>` rather than a hover tooltip, because a hover tooltip is
 * unreachable by keyboard and invisible on a touch screen, and this is the
 * one piece of copy in the exam that a candidate has a right to read.
 */

/** Exactly what the client records, in the candidate's words. */
export const MONITORED_SIGNALS: readonly string[] = Object.freeze([
  "When this tab loses focus or leaves full screen, and for how long",
  "When you paste, and whether the text came from inside or outside this exam",
  "The size and a one-way fingerprint of pasted and copied text — never the text itself",
  "When text appears without being typed (for example, inserted by an extension)",
  "Typing pace statistics — counts and timings, never what you type",
  "Copies, cuts and right-clicks",
  "Window size changes, and whether a second screen is attached",
  "Periodic snapshots of your code, so your work can be recovered and your progress shown",
  "Whether this tab is connected, every ten seconds",
]);

export function MonitoredChip({ labSupervised = false }: { readonly labSupervised?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <details
      className="relative"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        aria-describedby={id}
        className="flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-border bg-elevated px-2.5 py-1 text-xs font-medium text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Eye className="h-3.5 w-3.5" aria-hidden />
        Monitored
      </summary>
      <div
        id={id}
        className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-border bg-elevated p-4 text-xs shadow-lg"
      >
        <p className="font-medium text-text">This sitting is monitored and recorded</p>
        <p className="mt-1 text-text-secondary">
          Everything recorded is listed here. A person reviews anything unusual — nothing about this
          is decided automatically.
        </p>
        <ul className="mt-3 flex flex-col gap-1.5 text-text-secondary">
          {MONITORED_SIGNALS.map((signal) => (
            <li key={signal} className="flex gap-2">
              <span aria-hidden>·</span>
              <span>{signal}</span>
            </li>
          ))}
          {labSupervised ? (
            <li className="flex gap-2">
              <span aria-hidden>·</span>
              <span>That you are sitting on the exam hall network, and your seat label</span>
            </li>
          ) : null}
        </ul>
      </div>
    </details>
  );
}
