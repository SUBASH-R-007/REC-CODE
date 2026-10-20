import type { Metadata } from "next";
import { Badge, Card, CardBody, CardHeader } from "@recx/design";
import { effectiveXpRules, LIMITS, xpRulesOverrideSchema } from "@recx/shared";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { readRetention } from "@/lib/privileged/retention";
import { XP_SETTING_KEY } from "@/lib/progress/xp-config";
import { LegalHoldForm } from "@/components/super/legal-hold-form";
import { formatIst, Notice, PageHeader } from "@/components/super/ui";
import { XpRulesForm } from "@/components/super/xp-rules-form";

export const metadata: Metadata = { title: "Policy · Super-admin" };

/** XP rules (editable), retention schedule (read-only) and the legal hold. */
export default async function SuperPolicyPage() {
  await requireSuperAdminPage();
  const [xpRow, retention] = await Promise.all([
    db.platformSetting.findUnique({ where: { key: XP_SETTING_KEY }, select: { value: true, updatedAt: true } }),
    readRetention(),
  ]);
  const override = xpRow ? xpRulesOverrideSchema.safeParse(xpRow.value) : null;
  const { rules, version } = effectiveXpRules(override?.success ? override.data : null);
  const changedAt = retention.setting.legalHoldChangedAt ? new Date(retention.setting.legalHoldChangedAt) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Policy" description="XP rules and data retention. Every change is audited with the previous value." />

      <Card>
        <CardHeader
          title="XP rules"
          subtitle={`Rules version ${version}${xpRow ? `, saved ${formatIst(xpRow.updatedAt)}` : " (defaults)"}`}
        />
        <CardBody className="space-y-3">
          {override && !override.success ? (
            <Notice tone="warning" title="The stored XP override is invalid and ignored; the defaults apply." />
          ) : null}
          <XpRulesForm
            initial={{
              easy: rules.firstSolve.EASY,
              medium: rules.firstSolve.MEDIUM,
              hard: rules.firstSolve.HARD,
              dailyChallengeMultiplier: rules.dailyChallengeMultiplier,
              assistedMultiplier: rules.assistedMultiplier,
              revisionMultiplier: rules.revisionMultiplier,
              easyPerDay: rules.caps.easyPerDay,
              totalPerDay: rules.caps.totalPerDay,
            }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Legal hold"
          subtitle="Suspends every purge: the scheduled retention jobs and requested submission purges."
          action={retention.legalHold ? <Badge tone="danger">In force</Badge> : <Badge>Not in force</Badge>}
        />
        <CardBody className="space-y-3">
          {!retention.valid ? (
            <Notice tone="danger" title="The stored retention setting is unreadable, so every purge is held." />
          ) : null}
          {retention.setting.legalHoldReason ? (
            <p className="text-sm text-text-secondary">
              Last change {formatIst(changedAt)}: {retention.setting.legalHoldReason}
            </p>
          ) : null}
          <LegalHoldForm active={retention.legalHold} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Retention schedule" subtitle="Fixed in code. Only the legal hold above can change it." />
        <CardBody>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>Visible-test output (SubmissionTestDetail): {LIMITS.detail.retentionDays} days.</li>
            <li>Run requests: {LIMITS.customRun.ttlHours} hours.</li>
            <li>Practice source code that was not accepted: 18 months, then archived. Verdicts are kept forever.</li>
            <li>Accepted, contest and assessment sources: kept.</li>
            <li>Audit log: 3 years (the hash chain is tamper-evident, not tamper-resistant).</li>
            <li>Students are never hard-deleted: Graduated or Archived keeps their history.</li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
