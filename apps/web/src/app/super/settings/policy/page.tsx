import type { Metadata } from "next";
import { Badge, Card, CardBody, CardHeader } from "@recx/design";
import { effectiveXpRules, LIMITS, xpRulesOverrideSchema } from "@recx/shared";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { readRetention } from "@/lib/privileged/retention";
import { XP_SETTING_KEY } from "@/lib/progress/xp-config";
import { consentContact } from "@/lib/exam/consent";
import { secondFactorPolicy } from "@/lib/auth/second-factor";
import { secondFactorConfigured } from "@/lib/auth/totp";
import { ConsentContactForm } from "@/components/super/consent-contact-form";
import { SecondFactorPolicyForm } from "@/components/super/second-factor-policy-form";
import { LegalHoldForm } from "@/components/super/legal-hold-form";
import { formatIst, Notice, PageHeader } from "@/components/super/ui";
import { XpRulesForm } from "@/components/super/xp-rules-form";

export const metadata: Metadata = { title: "Policy · Super-admin" };

/** XP rules (editable), retention schedule (read-only) and the legal hold. */
export default async function SuperPolicyPage() {
  await requireSuperAdminPage();
  const [xpRow, retention, contact, secondFactorRequired, adminsWithoutFactor] = await Promise.all([
    db.platformSetting.findUnique({ where: { key: XP_SETTING_KEY }, select: { value: true, updatedAt: true } }),
    readRetention(),
    consentContact(),
    secondFactorPolicy(),
    // How many accounts the switch would affect, so the decision is taken
    // with the number in view rather than afterwards.
    db.user.count({
      where: {
        role: { in: ["ADMIN", "SUPER_ADMIN"] },
        status: { in: ["ACTIVE", "SOFT_RESTRICTED"] },
        OR: [{ totpCredential: null }, { totpCredential: { confirmedAt: null } }],
      },
    }),
  ]);
  const override = xpRow ? xpRulesOverrideSchema.safeParse(xpRow.value) : null;
  const { rules, version } = effectiveXpRules(override?.success ? override.data : null);
  const changedAt = retention.setting.legalHoldChangedAt ? new Date(retention.setting.legalHoldChangedAt) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Policy" description="XP rules and data retention. Every change is audited with the previous value." />

      {/*
        Phase 16e. SPEC §6 asks for the named Data Protection Officer or
        grievance contact to be ON SCREEN beside what a proctored sitting
        records. It is here rather than in Integrations because it is a
        policy commitment to candidates, not a connection to a system.
      */}
      <Card>
        <CardHeader
          title="Proctoring data contact"
          subtitle="Shown to every candidate on the readiness page, beside what the sitting records."
        />
        <CardBody>
          {contact ? null : (
            <Notice tone="warning" title="No contact is named yet">
              Candidates are told to ask their department instead. Name somebody here.
            </Notice>
          )}
          <ConsentContactForm current={contact} />
        </CardBody>
      </Card>

      {/*
        Phase 16j (ROADMAP §3.1). A single password stood in front of
        impersonation, the roster import commit, result release, the
        placement export, the AI provider settings and the judge node
        controls. Here rather than in Integrations for the same reason the
        contact above is: it is a policy about who may act, not a
        connection to a system.
      */}
      <Card>
        <CardHeader
          title="Two-step sign-in for admins"
          subtitle="An authenticator app in front of every ADMIN and SUPER_ADMIN sign-in."
          action={secondFactorRequired ? <Badge tone="success">Required</Badge> : <Badge>Not required</Badge>}
        />
        <CardBody className="space-y-3">
          {secondFactorRequired && adminsWithoutFactor > 0 ? (
            <Notice
              tone="warning"
              title={`${adminsWithoutFactor} admin ${adminsWithoutFactor === 1 ? "account has" : "accounts have"} not set one up yet`}
            >
              Each of them reaches only /account/two-factor until they do. They can do it themselves; nobody has to be
              let in by hand.
            </Notice>
          ) : null}
          {!secondFactorRequired && adminsWithoutFactor > 0 ? (
            <p className="text-sm text-text-secondary">
              {adminsWithoutFactor} admin {adminsWithoutFactor === 1 ? "account has" : "accounts have"} no
              authenticator app. Turning this on makes each of them set one up before they can do anything else.
            </p>
          ) : null}
          <SecondFactorPolicyForm required={secondFactorRequired} configured={secondFactorConfigured()} />
        </CardBody>
      </Card>

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
