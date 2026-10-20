"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { rejudgeSubmission } from "@/server/actions/admin-judge";

/**
 * One-click rejudge of a single submission on the REJUDGE lane (audited with
 * its previous verdict). Bulk / global rejudge is SUPER_ADMIN with two-person
 * approval and is not offered here.
 */
export function RejudgeButton({ submissionId, label }: { submissionId: string; label: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      loading={pending}
      aria-label={label}
      onClick={() =>
        startTransition(async () => {
          const result = await rejudgeSubmission({ submissionId });
          if (!result.ok) {
            toast(result.error, "error");
            return;
          }
          toast(
            result.data.dispatched
              ? "Queued for rejudge."
              : "Marked for rejudge. The queue is unreachable, so the reconciler will pick it up within seconds.",
            "success",
          );
          router.refresh();
        })
      }
    >
      {!pending && <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
      Rejudge
    </Button>
  );
}
