import { ShieldAlert } from "lucide-react";

/** The persistent strip on every /super page (spec wording, verbatim). */
export const SUPER_STRIP_TEXT = "Super-admin — all actions are audited";

/** Sticky under the header; icon plus text, never colour alone. */
export function SuperStrip() {
  return (
    <p
      role="note"
      className="sticky top-14 z-10 flex items-center justify-center gap-2 border-b border-danger/30 bg-danger-subtle px-4 py-1.5 text-center text-sm font-semibold text-danger"
    >
      <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
      <span>{SUPER_STRIP_TEXT}</span>
    </p>
  );
}
