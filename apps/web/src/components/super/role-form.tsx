"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Button, Field, Select, useToast } from "@recx/design";
import { setUserRole } from "@/server/actions/super-roles";
import { ReasonDialog } from "@/components/super/reason-dialog";

const ROLES = [
  ["STUDENT", "Student"],
  ["TA_MENTOR", "TA / mentor"],
  ["ADMIN", "Admin"],
  ["PLACEMENT_OFFICER", "Placement officer"],
  ["SUPER_ADMIN", "Super-admin"],
] as const;
type RoleValue = (typeof ROLES)[number][0];

/** Change one account's role (SECURITY-audited). Leaving ADMIN revokes that admin's scopes. */
export function RoleChange({ userId, collegeId, current }: { userId: string; collegeId: string; current: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<RoleValue>(current === "ADMIN" ? "STUDENT" : "ADMIN");

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <KeyRound className="h-3.5 w-3.5" aria-hidden />
        Change role
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title={`Change the role of ${collegeId}`}
          confirmLabel="Change role"
          danger={role === "SUPER_ADMIN" || current === "SUPER_ADMIN"}
          description={
            <p>
              Currently {current}. A new ADMIN sees no students until you grant a scope (Roles and scopes). Leaving ADMIN
              revokes every scope. At least one active super-admin always remains.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await setUserRole({ userId, role, reason });
            if (result.ok) {
              toast(`${collegeId} is now ${result.data.role}.`, "success");
              router.refresh();
            }
            return result;
          }}
        >
          <Field label="New role" htmlFor={`${id}-role`}>
            <Select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as RoleValue)}>
              {ROLES.filter(([value]) => value !== current).map(([value, label]) => (
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
