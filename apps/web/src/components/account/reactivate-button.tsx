"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@recx/design";
import { selfClearRestriction } from "@/server/actions/account";

/**
 * One button (Phase 8e).
 *
 * A plain `<button>`, keyboard-reachable, with a visible focus ring and the
 * outcome announced in a live region. There is deliberately no dialog, no
 * confirmation step, no hover-only affordance and no drag: this is the route
 * OUT of a restriction, and every extra step between a student and it is a
 * step some student will not take.
 */
export function ReactivateButton({ disabledReason }: { disabledReason: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "info">("ok");

  if (disabledReason) {
    return (
      <p className="rounded-md border border-border bg-surface p-3 text-sm">{disabledReason}</p>
    );
  }

  return (
    <div className="space-y-3">
      <Button
        type="button"
        loading={pending}
        onClick={() =>
          start(async () => {
            const result = await selfClearRestriction();
            if (!result.ok) {
              setTone("info");
              setMessage(result.error);
              return;
            }
            setTone(result.data.cleared ? "ok" : "info");
            setMessage(result.data.message);
            router.refresh();
          })
        }
      >
        Restore my account
      </Button>

      {/* Announced, not flashed: a message that disappears is not an answer. */}
      <p aria-live="polite" className={`text-sm ${tone === "ok" ? "text-success" : "text-text-secondary"}`}>
        {message ?? ""}
      </p>
    </div>
  );
}
