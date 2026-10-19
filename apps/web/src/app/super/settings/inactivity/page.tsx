import type { Metadata } from "next";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import {
  DEFAULT_INACTIVITY_POLICY,
  RESTRICTION_STAGE_ADMIN_LABEL,
  formatCampusTime,
  stageForCountedDays,
} from "@recx/shared";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { activeInactivityPolicies, inactivityPolicyVersions } from "@/server/queries/super-inactivity";
import { AutoDisableSwitch } from "@/components/super/auto-disable-switch";
import { InactivityPolicyForm } from "@/components/super/inactivity-policy-form";
import { PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Inactivity policy · Super-admin" };

/**
 * `/super/settings/inactivity` — the thresholds, and the argument about them
 * (Phase 8b).
 *
 * SPEC §5 Phase 8 is titled "Inactivity as a policy engine, not a kill
 * switch", and the paragraph at the top of this page is that title argued
 * rather than asserted. It is product copy on purpose: the person who can
 * turn on automatic disabling reads the case against it on the same screen as
 * the switch, every time, and so does the next person who inherits the job.
 *
 * The page leads with what the live policy actually DOES to a student at each
 * rung, in days, because a table of four numbers tells a super-admin nothing
 * about the consequence they are choosing.
 */
export default async function SuperInactivityPage() {
  await requireSuperAdminPage();
  const [versions, active] = await Promise.all([inactivityPolicyVersions(), activeInactivityPolicies()]);
  const global = active.find((policy) => policy.batchYear === null && policy.departmentCode === null) ?? null;
  const live = global ?? active[0] ?? null;

  const scopeOf = (policy: { batchYear: number | null; departmentCode: string | null }) =>
    policy.batchYear === null && policy.departmentCode === null
      ? "Everyone"
      : [policy.batchYear ?? "every batch", policy.departmentCode ?? "every department"].join(" · ");

  return (
    <div className="space-y-8">
      <PageHeader
        title="Inactivity policy"
        description={
          <>
            What happens when a student stops practising — and, just as deliberately, what does not.
          </>
        }
      />

      {/* The "why", verbatim from docs/RUNBOOK.md §2. Not a comment, not a
          tooltip: the argument has to be where the decision is made. */}
      <Card>
        <CardHeader title="What this is for" />
        <CardBody className="space-y-3 text-sm">
          <p>
            A student who stops submitting has usually not stopped caring. They are ill, or sitting university exams, or
            at home for a bereavement, or stuck on a problem and too embarrassed to say so. A system that reads silence
            as misconduct and closes the account has not identified a problem; it has created one, and it has taught
            everybody watching that the platform is something to be afraid of.
          </p>
          <p>
            So this is a policy engine and not a kill switch. Its purpose is to make non-progress{" "}
            <strong>visible to a named human who can intervene</strong> — not to punish it. The maximum automatic
            consequence is a pause that one solved problem undoes, with nobody&apos;s permission, and every automatic
            decision carries the evidence it was made on so that a student who disputes it can be answered months
            later.
          </p>
          <p>
            The college asked for &ldquo;five days of inactivity, then the account is disabled&rdquo;. That is not what
            ships, and the gap is deliberate: on the defaults, day five is a <strong>warning</strong> to the student and
            their mentor, a pause arrives at day ten, and closing an account automatically is switched off entirely.
            Every one of those numbers is editable on this page, which is the spec&apos;s own answer — tighten the
            policy without a deploy, and own the decision in an audit row.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="What the live policy does"
          subtitle={live ? `Version ${live.version} · ${scopeOf(live)}` : "No policy is live"}
        />
        <CardBody>
          {live === null ? (
            <EmptyState
              title="No policy is live"
              description="The sweep does nothing at all while no policy is active — which is the right answer, not a gap. Draft one below and make it live."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] border-collapse text-sm">
                <caption className="sr-only">What happens at each number of counted inactive days</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="py-2 pr-3">Counted days</th>
                    <th scope="col" className="py-2 pr-3">Stage</th>
                    <th scope="col" className="py-2">What the student notices</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { days: live.nudgeAfterDays, says: "A nudge on the dashboard. Nothing else changes." },
                    { days: live.warnAfterDays, says: "The student is told, and so is their mentor." },
                    {
                      days: live.softRestrictAfterDays,
                      says: "Off the public leaderboard, no contest entry, no new XP on the boards. Signing in, reading problems, solving and sitting a scheduled assessment all still work.",
                    },
                    {
                      days: live.disableAfterDays,
                      says: live.autoDisableEnabled
                        ? "The account is closed by the nightly job."
                        : "Never reached: automatic disabling is switched off.",
                    },
                  ]
                    .filter((row) => row.days !== null)
                    .map((row) => (
                      <tr key={row.days} className="border-b border-border last:border-0">
                        <td className="py-2 pr-3 font-medium">{row.days}</td>
                        <td className="py-2 pr-3">
                          <Badge
                            tone={
                              stageForCountedDays(live, row.days!) === "DISABLED"
                                ? "danger"
                                : stageForCountedDays(live, row.days!) === "SOFT_RESTRICTED"
                                  ? "warning"
                                  : "info"
                            }
                          >
                            {RESTRICTION_STAGE_ADMIN_LABEL[stageForCountedDays(live, row.days!)]}
                          </Badge>
                        </td>
                        <td className="py-2">{row.says}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-muted">
                Grace: {live.graceDays} day{live.graceDays === 1 ? "" : "s"} after a student is told before the next
                rung. A day counts as active with {live.minActivityPerDay} submission
                {live.minActivityPerDay === 1 ? "" : "s"} or solve{live.minActivityPerDay === 1 ? "" : "s"}.
                {live.excludeNonWorkingDays ? " Non-working days are skipped." : " Non-working days still count."}
                {live.excludeApprovedLeave ? " Approved leave is skipped." : " Approved leave still counts."}
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Draft a new version"
          subtitle="A version is never edited — a change writes a new one, because the decisions taken under it cite it by number."
        />
        <CardBody>
          <InactivityPolicyForm seed={live ?? undefined} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Automatic disabling" />
        <CardBody>
          {live === null ? (
            <p className="text-sm text-text-secondary">
              There is no live policy to switch. Draft one first — and note that anything drafted here has automatic
              disabling off.
            </p>
          ) : (
            <AutoDisableSwitch
              version={live.version}
              enabled={live.autoDisableEnabled}
              disableAfterDays={live.disableAfterDays}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Every version"
          subtitle="The history is the audit of the thresholds. Nothing here is ever deleted."
        />
        <CardBody>
          {versions.length === 0 ? (
            <EmptyState
              title="No versions yet"
              description={`Nothing has been drafted. The defaults the code ships are nudge ${DEFAULT_INACTIVITY_POLICY.nudgeAfterDays}, warn ${DEFAULT_INACTIVITY_POLICY.warnAfterDays}, pause ${DEFAULT_INACTIVITY_POLICY.softRestrictAfterDays}, with automatic disabling off.`}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <caption className="sr-only">Every policy version written, newest first</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="py-2 pr-3">Version</th>
                    <th scope="col" className="py-2 pr-3">Scope</th>
                    <th scope="col" className="py-2 pr-3">Ladder</th>
                    <th scope="col" className="py-2 pr-3">Auto-close</th>
                    <th scope="col" className="py-2">Written</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((policy) => (
                    <tr key={policy.version} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3 font-mono text-xs">
                        {policy.version}
                        {policy.isActive ? (
                          <Badge tone="success" className="ml-2">
                            live
                          </Badge>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">{scopeOf(policy)}</td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {[policy.nudgeAfterDays, policy.warnAfterDays, policy.softRestrictAfterDays, policy.disableAfterDays]
                          .map((days) => days ?? "—")
                          .join(" / ")}
                      </td>
                      <td className="py-2 pr-3">
                        {/* In words, never colour alone. */}
                        {policy.autoDisableEnabled ? <Badge tone="danger">on</Badge> : <span className="text-muted">off</span>}
                      </td>
                      <td className="py-2 text-xs text-muted">{formatCampusTime(policy.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
