import type { Metadata } from "next";
import Link from "next/link";
import { Badge, ButtonLink, EmptyState } from "@recx/design";
import { requirePageRole } from "@/lib/auth/guards";
import { formatCampusDateTime } from "@/lib/help/copy";
import { KIND_LABEL, formatDuration } from "@/components/contests/model";
import { listAdminContests } from "@/server/queries/admin-contests";

export const metadata: Metadata = { title: "Contests" };

const TD = "px-3 py-2";

function statusTone(status: string): "default" | "info" | "success" | "warning" {
  if (status === "RUNNING") return "success";
  if (status === "PUBLISHED") return "info";
  if (status === "DRAFT") return "warning";
  return "default";
}

/**
 * Every contest, drafts included (staff see what students cannot). Creating
 * a college-wide contest is SUPER_ADMIN only, which the action enforces;
 * this page offers the button to both and lets the action explain.
 */
export default async function AdminContestsPage() {
  await requirePageRole("ADMIN", "SUPER_ADMIN");
  const contests = await listAdminContests();

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text">Contests</h1>
          <p className="mt-2 max-w-2xl text-text-secondary">
            A contest pins each problem at its published revision, so editing a problem later never changes what a
            contest asked or rescores anybody.
          </p>
        </div>
        <ButtonLink href="/admin/contests/new">New contest</ButtonLink>
      </header>

      {contests.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="No contests yet"
            description="Create one, add its problems, then publish it so students can register."
          />
        </div>
      ) : (
        <div tabIndex={0} aria-label="Contests" className="mt-6 overflow-x-auto rounded-xl border border-border">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-elevated text-text-secondary">
              <tr>
                <th scope="col" className={TD}>
                  Contest
                </th>
                <th scope="col" className={TD}>
                  Status
                </th>
                <th scope="col" className={TD}>
                  Starts
                </th>
                <th scope="col" className={TD}>
                  Length
                </th>
                <th scope="col" className={TD}>
                  Problems
                </th>
                <th scope="col" className={TD}>
                  Registered
                </th>
              </tr>
            </thead>
            <tbody>
              {contests.map((c) => (
                <tr key={c.id} className="border-t border-border">
                  <td className={TD}>
                    <Link className="text-primary underline-offset-2 hover:underline" href={`/admin/contests/${c.id}`}>
                      {c.title}
                    </Link>
                    <span className="block text-xs text-text-secondary">
                      {KIND_LABEL[c.kind]} · {c.isRated ? "rated" : "unrated"} ·{" "}
                      {c.visibility === "PUBLIC" ? "whole college" : "cohort"}
                    </span>
                  </td>
                  <td className={TD}>
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{formatCampusDateTime(c.startsAt)}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {formatDuration(Math.round((c.endsAt.getTime() - c.startsAt.getTime()) / 60_000))}
                  </td>
                  <td className={`${TD} font-mono tabular-nums`}>{c.problems}</td>
                  <td className={`${TD} font-mono tabular-nums`}>{c.registrations}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
