"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { UserCog } from "lucide-react";
import { Button, Field, Select, useToast } from "@recx/design";
import { setAccountStatus } from "@/server/actions/super-users";
import { ReasonDialog } from "@/components/super/reason-dialog";

const STATUSES = [
  ["ACTIVE", "Active"],
  ["SOFT_RESTRICTED", "Soft-restricted"],
  ["DISABLED", "Disabled"],
  ["GRADUATED", "Graduated"],
  ["ARCHIVED", "Archived"],
] as const;
type Status = (typeof STATUSES)[number][0];

/** Change one account's status (with a reason; audited). */
export function StatusChange({ userId, collegeId, current }: { userId: string; collegeId: string; current: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [toStatus, setToStatus] = useState<Status>(current === "ACTIVE" ? "DISABLED" : "ACTIVE");

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <UserCog className="h-3.5 w-3.5" aria-hidden />
        Change status
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title={`Change the status of ${collegeId}`}
          confirmLabel="Change status"
          danger={toStatus === "DISABLED" || toStatus === "ARCHIVED"}
          description={
            <p>
              Currently {current}. Leaving Active or Soft-restricted signs the account out everywhere at once. A student
              is never deleted: Graduated and Archived keep every submission.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await setAccountStatus({ userId, toStatus, reason });
            if (result.ok) {
              toast(`${collegeId} is now ${result.data.status}.`, "success");
              router.refresh();
            }
            return result;
          }}
        >
          <Field label="New status" htmlFor={`${id}-to`}>
            <Select id={`${id}-to`} value={toStatus} onChange={(e) => setToStatus(e.target.value as Status)}>
              {STATUSES.filter(([value]) => value !== current).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </ReasonDialog>
      )}
    </>
  );
}
