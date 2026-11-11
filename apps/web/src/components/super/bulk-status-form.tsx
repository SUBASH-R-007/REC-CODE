"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";
import { Badge, Button, Field, Select, useToast } from "@recx/design";
import { bulkSetAccountStatus, requestBulkStatusChange } from "@/server/actions/super-users";
import { ReasonDialog } from "@/components/super/reason-dialog";

const STATUSES = [
  ["ACTIVE", "Active"],
  ["SOFT_RESTRICTED", "Soft-restricted"],
  ["DISABLED", "Disabled"],
  ["GRADUATED", "Graduated"],
  ["ARCHIVED", "Archived"],
] as const;
type Status = (typeof STATUSES)[number][0];
const DIRECT_MAX = 25;

export interface BulkRow {
  id: string;
  collegeId: string;
  name: string;
  role: string;
  status: string;
  cohort: string;
}

type Filter = {
  roles?: ("STUDENT" | "TA_MENTOR" | "ADMIN" | "PLACEMENT_OFFICER" | "SUPER_ADMIN")[];
  statuses?: Status[];
  batchYear?: number;
  departmentCode?: string;
  section?: string;
};

/**
 * The /super/users result table with row selection. Up to 25 selected
 * accounts change directly (all or nothing); more becomes a two-person
 * request. "Request for the whole filter" resolves the filter to an exact
 * account list on the server.
 */
export function BulkStatusTable({ rows, filter, filterLabel }: { rows: BulkRow[]; filter: Filter | null; filterLabel: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toStatus, setToStatus] = useState<Status>("DISABLED");
  const [open, setOpen] = useState<"selected" | "filter" | null>(null);
  // Only rows on screen count: a client-side page change (?after=, ?user=)
  // re-renders this table without remounting it, so `selected` may still
  // hold ids that are no longer shown. They are never counted or submitted.
  const chosen = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
  const count = chosen.length;
  const allSelected = rows.length > 0 && count === rows.length;

  const toggle = (rowId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Change selected to" htmlFor={`${id}-status`} className="w-48">
          <Select id={`${id}-status`} value={toStatus} onChange={(e) => setToStatus(e.target.value as Status)}>
            {STATUSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Button size="sm" disabled={count === 0} onClick={() => setOpen("selected")}>
          <Users className="h-3.5 w-3.5" aria-hidden />
          {count > DIRECT_MAX ? `Request change for ${count}` : `Change ${count} selected`}
        </Button>
        {filter ? (
          <Button size="sm" variant="outline" onClick={() => setOpen("filter")}>
            Request for the whole filter
          </Button>
        ) : null}
      </div>

      <div role="region" tabIndex={0} aria-label="Accounts" className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Accounts matching the search</caption>
          <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
            <tr>
              <th scope="col" className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select every account on this page"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                />
              </th>
              <th scope="col" className="px-3 py-2">Roll number</th>
              <th scope="col" className="px-3 py-2">Name</th>
              <th scope="col" className="px-3 py-2">Role</th>
              <th scope="col" className="px-3 py-2">Status</th>
              <th scope="col" className="px-3 py-2">Cohort</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.collegeId}`}
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                  />
                </td>
                <td className="px-3 py-2 font-mono">
                  <Link className="text-primary underline-offset-2 hover:underline" href={`/super/users?user=${encodeURIComponent(row.id)}`}>
                    {row.collegeId}
                  </Link>
                </td>
                <td className="px-3 py-2">{row.name}</td>
                <td className="px-3 py-2">{row.role}</td>
                <td className="px-3 py-2">
                  <Badge tone={row.status === "ACTIVE" ? "success" : row.status === "SOFT_RESTRICTED" ? "warning" : "default"}>
                    {row.status}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-text-secondary">{row.cohort}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open === "selected" && (
        <ReasonDialog
          open
          onClose={() => setOpen(null)}
          title={count > DIRECT_MAX ? `Request: ${count} accounts to ${toStatus}` : `Set ${count} account(s) to ${toStatus}`}
          confirmLabel={count > DIRECT_MAX ? "Send for approval" : "Change status"}
          danger={toStatus === "DISABLED" || toStatus === "ARCHIVED"}
          description={
            count > DIRECT_MAX ? (
              <p>More than {DIRECT_MAX} accounts needs a second super-admin&apos;s approval within 24 hours.</p>
            ) : (
              <p>
                All or nothing: if any account cannot change (yourself, the last active super-admin), nothing changes.
                Accounts leaving Active lose every session at once.
              </p>
            )
          }
          onConfirm={async (reason) => {
            const userIds = chosen;
            if (userIds.length > DIRECT_MAX) {
              const result = await requestBulkStatusChange({ userIds, toStatus, reason });
              if (result.ok) {
                toast(`Request sent for ${result.data.count} accounts.`, "success");
                setSelected(new Set());
                router.refresh();
              }
              return result;
            }
            const result = await bulkSetAccountStatus({ userIds, toStatus, reason });
            if (result.ok) {
              toast(`${result.data.changed} account(s) changed.`, "success");
              setSelected(new Set());
              router.refresh();
            }
            return result;
          }}
        />
      )}
      {open === "filter" && filter && (
        <ReasonDialog
          open
          onClose={() => setOpen(null)}
          title={`Request: every match to ${toStatus}`}
          confirmLabel="Send for approval"
          danger={toStatus === "DISABLED" || toStatus === "ARCHIVED"}
          description={
            <p>
              Filter: {filterLabel || "every account"}. The server resolves it to the exact accounts now (those not
              already {toStatus}); a second super-admin approves that list. 26 to 5,000 accounts.
            </p>
          }
          onConfirm={async (reason) => {
            const result = await requestBulkStatusChange({ filter, toStatus, reason });
            if (result.ok) {
              toast(`Request sent for ${result.data.count} accounts.`, "success");
              router.refresh();
            }
            return result;
          }}
        />
      )}
    </div>
  );
}
