import { Search } from "lucide-react";
import { Button, ButtonLink, Input, Label, Select } from "@recx/design";
import { ACCOUNT_STATUSES, INACTIVE_DAYS, hasFilters, type StudentFilters } from "@/lib/admin/student-filters";

const STATUS_LABEL: Record<(typeof ACCOUNT_STATUSES)[number], string> = {
  ACTIVE: "Active",
  SOFT_RESTRICTED: "Soft-restricted",
  DISABLED: "Disabled",
  GRADUATED: "Graduated",
  ARCHIVED: "Archived",
};

/**
 * The /admin/students filter bar: a plain GET form (works without
 * JavaScript; the URL is the state). Every value is re-parsed on the server.
 */
export function StudentFiltersForm({ filters }: { filters: StudentFilters }) {
  return (
    <form method="get" action="/admin/students" role="search" aria-label="Filter students" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="sm:col-span-2">
          <Label htmlFor="students-q">Roll number, email or name</Label>
          <Input id="students-q" name="q" defaultValue={filters.q ?? ""} maxLength={100} autoComplete="off" spellCheck={false} />
        </div>
        <div>
          <Label htmlFor="students-batch">Batch</Label>
          <Input
            id="students-batch"
            name="batch"
            inputMode="numeric"
            placeholder="2027"
            defaultValue={filters.batch ?? ""}
            maxLength={4}
            className="tabular-nums"
          />
        </div>
        <div>
          <Label htmlFor="students-dept">Department</Label>
          <Input id="students-dept" name="dept" placeholder="CSE" defaultValue={filters.dept ?? ""} maxLength={10} />
        </div>
        <div>
          <Label htmlFor="students-section">Section</Label>
          <Input id="students-section" name="section" placeholder="A" defaultValue={filters.section ?? ""} maxLength={4} />
        </div>
        <div>
          <Label htmlFor="students-status">Status</Label>
          <Select id="students-status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Any status</option>
            {ACCOUNT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-56">
          <Label htmlFor="students-inactive">Inactive for</Label>
          <Select id="students-inactive" name="inactive" defaultValue={filters.inactive ? String(filters.inactive) : ""}>
            <option value="">Any activity</option>
            {INACTIVE_DAYS.map((d) => (
              <option key={d} value={d}>
                {d} days or more
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit">
          <Search className="h-4 w-4" aria-hidden />
          Filter
        </Button>
        {hasFilters(filters) ? (
          <ButtonLink href="/admin/students" variant="ghost">
            Clear filters
          </ButtonLink>
        ) : null}
      </div>
    </form>
  );
}
