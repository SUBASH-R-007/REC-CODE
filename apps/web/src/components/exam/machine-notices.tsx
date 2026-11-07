import { describeSkew, type ClockSkew, type PowerState } from "@/lib/exam/machine-readiness";

/**
 * What this machine will do to the sitting, said before the clock starts
 * (Phase 15b).
 *
 * Neither of these is a proctoring signal and neither leaves the browser.
 * They are here because the two most common ways for a paper to go wrong
 * in a hall have nothing to do with cheating: a laptop that dies, and a
 * clock wrong enough that the exam browser's attestation refuses every
 * request it signs. Both take ten seconds to fix beforehand, and both end
 * a sitting when they are discovered partway through.
 *
 * Neither blocks the Start button, and that is the deliberate part. A
 * candidate on a locked-down lab image may not be able to change the
 * clock, and a readiness check that trapped them would be worse than the
 * problem it is warning about. It says what will happen and lets them
 * decide, which is the stance everywhere else in this product.
 *
 * Silent when there is nothing to say, including when the browser will
 * not say. A check that announced every unknowable thing is one
 * candidates learn to click past, and the checks beside this one are the
 * ones they must not.
 */
export function MachineNotices({ skew, power }: { readonly skew: ClockSkew; readonly power: PowerState }) {
  const clockNote =
    skew.kind === "broken"
      ? {
          tone: "border-danger/40 bg-danger-subtle",
          text: `This machine's clock is ${describeSkew(skew.offsetMs)}. REC Exam Browser will refuse to sit a paper with a clock this far out. Set the time automatically, or tell your invigilator, before you start.`,
        }
      : skew.kind === "drifting"
        ? {
            tone: "border-warning/40 bg-warning-subtle",
            text: `This machine's clock is ${describeSkew(skew.offsetMs)}. That still works, but it is close enough to the limit that a long paper could fail partway through. Setting the time automatically now costs nothing.`,
          }
        : null;

  const powerNote =
    power.kind === "low_battery"
      ? {
          tone: "border-warning/40 bg-warning-subtle",
          text: `This machine is on battery at ${power.percent}%. Plug it in before you start — your clock keeps running if the machine does not.`,
        }
      : null;

  if (!clockNote && !powerNote) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {clockNote ? (
        <p className={`rounded-lg border p-3 text-sm ${clockNote.tone}`} role="status">
          {clockNote.text}
        </p>
      ) : null}
      {powerNote ? (
        <p className={`rounded-lg border p-3 text-sm ${powerNote.tone}`} role="status">
          {powerNote.text}
        </p>
      ) : null}
    </div>
  );
}
