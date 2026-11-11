"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button, Field, Input, useToast } from "@recx/design";
import { grantAdminScope, revokeAdminScope } from "@/server/actions/super-roles";
import { ReasonDialog } from "@/components/super/reason-dialog";

/** Grant an ADMIN a department and/or batch scope (blank = every value; both blank = college-wide). */
export function GrantScope({ adminId, collegeId }: { adminId: string; collegeId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [departmentCode, setDepartmentCode] = useState("");
  const [batchYear, setBatchYear] = useState("");
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Grant scope
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title={`Grant a scope to ${collegeId}`}
          confirmLabel="Grant scope"
          description={
            <p>
              The admin will see the students of this department and batch. Leave a field blank for every value; leave
              both blank for the whole college.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await grantAdminScope({ adminId, departmentCode, batchYear, reason });
            if (result.ok) {
              toast("Scope granted.", "success");
              router.refresh();
            }
            return result;
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Department code" htmlFor={`${id}-dept`} hint="e.g. CSE; blank = every department">
              <Input id={`${id}-dept`} value={departmentCode} onChange={(e) => setDepartmentCode(e.target.value)} maxLength={16} />
            </Field>
            <Field label="Batch (year)" htmlFor={`${id}-batch`} hint="e.g. 2027; blank = every batch">
              <Input
                id={`${id}-batch`}
                value={batchYear}
                onChange={(e) => setBatchYear(e.target.value)}
                inputMode="numeric"
                maxLength={4}
              />
            </Field>
          </div>
        </ReasonDialog>
      )}
    </>
  );
}

/** Revoke one active scope (sets revokedAt; the row is kept). */
export function RevokeScope({ scopeId, label }: { scopeId: string; label: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Revoke ${label}`}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        Revoke
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title={`Revoke ${label}`}
          confirmLabel="Revoke scope"
          danger
          description={<p>The admin stops seeing these students at once. An admin with no scope sees no students.</p>}
          onConfirm={async (reason) => {
            const result = await revokeAdminScope({ scopeId, reason });
            if (result.ok) {
              toast("Scope revoked.", "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </>
  );
}
