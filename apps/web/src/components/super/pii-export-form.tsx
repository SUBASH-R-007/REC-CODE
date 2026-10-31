"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { FileDown } from "lucide-react";
import { Button, Field, Input, Select, useToast } from "@recx/design";
import { requestPiiExport } from "@/server/actions/super-data";
import { ReasonDialog } from "@/components/super/reason-dialog";

type Column = Parameters<typeof requestPiiExport>[0]["columns"][number];
type RoleValue = "STUDENT" | "TA_MENTOR" | "ADMIN" | "PLACEMENT_OFFICER" | "SUPER_ADMIN";
type StatusValue = "ACTIVE" | "SOFT_RESTRICTED" | "DISABLED" | "GRADUATED" | "ARCHIVED";

/**
 * Request a PII export (two-person approval). Only the minimised columns
 * can be chosen. After approval the requester downloads it within 24
 * hours, at most 3 times; it is generated at download time, never stored.
 */
export function PiiExportForm({ columns }: { columns: readonly string[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [chosen, setChosen] = useState<string[]>(["collegeId", "firstName", "lastName", "departmentCode", "batchYear"]);
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [batch, setBatch] = useState("");
  const [dept, setDept] = useState("");
  const [open, setOpen] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Columns</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {columns.map((c) => (
            <label key={c} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={chosen.includes(c)}
                onChange={() => setChosen((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))}
              />
              {c}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Role" htmlFor={`${id}-role`}>
          <Select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Any</option>
            <option value="STUDENT">Student</option>
            <option value="TA_MENTOR">TA / mentor</option>
            <option value="ADMIN">Admin</option>
            <option value="PLACEMENT_OFFICER">Placement officer</option>
            <option value="SUPER_ADMIN">Super-admin</option>
          </Select>
        </Field>
        <Field label="Status" htmlFor={`${id}-status`}>
          <Select id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            <option value="ACTIVE">Active</option>
            <option value="SOFT_RESTRICTED">Soft-restricted</option>
            <option value="DISABLED">Disabled</option>
            <option value="GRADUATED">Graduated</option>
            <option value="ARCHIVED">Archived</option>
          </Select>
        </Field>
        <Field label="Batch" htmlFor={`${id}-batch`}>
          <Input id={`${id}-batch`} value={batch} onChange={(e) => setBatch(e.target.value)} inputMode="numeric" maxLength={4} />
        </Field>
        <Field label="Department" htmlFor={`${id}-dept`}>
          <Input id={`${id}-dept`} value={dept} onChange={(e) => setDept(e.target.value)} maxLength={16} />
        </Field>
      </div>
      <Button type="submit" variant="outline" disabled={chosen.length === 0}>
        <FileDown className="h-4 w-4" aria-hidden />
        Request export
      </Button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title="Request a PII export"
          confirmLabel="Send for approval"
          danger
          description={
            <p>
              A second super-admin must approve. Then only you can download it, within 24 hours, at most 3 times. Every
              request and download is a security audit row.
            </p>
          }
          onConfirm={async (reason) => {
            const batchYear = batch.trim() ? Number(batch) : undefined;
            const result = await requestPiiExport({
              filter: {
                ...(role ? { roles: [role as RoleValue] } : {}),
                ...(status ? { statuses: [status as StatusValue] } : {}),
                ...(batchYear !== undefined ? { batchYear } : {}),
                ...(dept.trim() ? { departmentCode: dept.trim().toUpperCase() } : {}),
              },
              columns: chosen as Column[],
              reason,
            });
            if (result.ok) {
              toast(`Export requested: ${result.data.count} account(s).`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </form>
  );
}
