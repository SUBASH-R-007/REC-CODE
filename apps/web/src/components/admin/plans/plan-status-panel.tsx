"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Unlink } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { detachPlanFromSeed, setStudyPlanPublished } from "@/server/actions/admin-plans";
import { ReasonDialog } from "@/components/admin/reason-dialog";

/** Publish / unpublish, and (for a seed-managed plan) hand it over to /admin. */
export function PlanStatusPanel({
  planId,
  published,
  seedManaged,
  itemsTotal,
  noun,
}: {
  planId: string;
  published: boolean;
  seedManaged: boolean;
  itemsTotal: number;
  noun: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [detaching, setDetaching] = useState(false);

  return (
    <div className="flex flex-wrap gap-2">
      {seedManaged ? (
        <>
          <Button variant="outline" onClick={() => setDetaching(true)}>
            <Unlink className="h-4 w-4" aria-hidden />
            Detach from the seed
          </Button>
          <ReasonDialog
            open={detaching}
            onClose={() => setDetaching(false)}
            title={`Detach this ${noun} from the seed?`}
            description={`The seed stops updating this ${noun}: newly published problems will no longer join it automatically, and you can edit it here. This cannot be undone from the admin pages.`}
            confirmLabel="Detach"
            onConfirm={async (reason) => {
              const result = await detachPlanFromSeed({ planId, reason });
              if (result.ok) {
                toast(`The ${noun} can now be edited here.`, "success");
                router.refresh();
              }
              return result;
            }}
          />
        </>
      ) : (
        <Button
          variant={published ? "outline" : "primary"}
          loading={pending}
          disabled={!published && itemsTotal === 0}
          onClick={() =>
            start(async () => {
              const result = await setStudyPlanPublished({ planId, published: !published });
              if (!result.ok) toast(result.error, "error");
              else {
                toast(result.data.published ? `The ${noun} is published.` : `The ${noun} is hidden from students.`, "success");
                router.refresh();
              }
            })
          }
        >
          {!pending && (published ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />)}
          {published ? "Unpublish" : itemsTotal === 0 ? "Add a problem to publish" : "Publish"}
        </Button>
      )}
    </div>
  );
}
