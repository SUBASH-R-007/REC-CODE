import type { Metadata } from "next";
import { Card, CardBody, CardHeader } from "@recx/design";
import {
  AI_DAILY_LIMIT,
  AI_HELPER_SETTING_KEY,
  AI_MODEL_PRESETS,
  AI_PROVIDER_LABEL,
  AI_PROVIDER_NOTE,
  HINT_POLICY,
  formatCampusTime,
} from "@recx/shared";
import { countCollegeAsksToday } from "@/lib/ai/ask";
import { getAiRuntime } from "@/lib/ai/settings";
import { foldAiUsage } from "@/lib/ai/usage";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { AiHelperForm } from "@/components/super/ai-helper-form";
import { Notice, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "AI helper · Super-admin" };

/**
 * `/super/settings/ai` — the assistant, and the switch that stops it.
 *
 * The page leads with what the helper actually does to a student, because a
 * dropdown of model names tells a super-admin nothing about the thing they
 * are turning on. Two facts belong above the form and nowhere else: a
 * student's draft code leaves the college when this is on, and a solve that
 * followed an answer stops counting as unassisted evidence of readiness.
 */
const AI_PROVIDERS_NOTE_LIST = (Object.keys(AI_PROVIDER_NOTE) as (keyof typeof AI_PROVIDER_NOTE)[]).map((provider) => ({
  provider,
  note: AI_PROVIDER_NOTE[provider],
}));

export default async function SuperAiPage() {
  await requireSuperAdminPage();
  const [runtime, row] = await Promise.all([
    getAiRuntime(),
    db.platformSetting.findUnique({
      where: { key: AI_HELPER_SETTING_KEY },
      select: { updatedAt: true },
    }),
  ]);
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [asked, failed, students, usage, today] = await Promise.all([
    db.aiAssist.count({ where: { failed: false, askedAt: { gte: since } } }),
    db.aiAssist.count({ where: { failed: true, askedAt: { gte: since } } }),
    db.aiAssist.findMany({
      where: { failed: false, askedAt: { gte: since } },
      distinct: ["userId"],
      select: { userId: true },
    }),
    /**
     * Which models answered, and which failed (Phase 15g).
     *
     * A super-admin may now name any model, which is only half a decision
     * without a way to see what the last one did. `AiAssist.modelId` has
     * recorded the model that answered since Phase 12b and nothing read it
     * back; with a closed catalogue of four that was almost information,
     * and with a free field it is the feedback loop. It also survives the
     * switch: the row from the model that was in use last week is still
     * here next to the new one.
     */
    db.aiAssist.groupBy({
      by: ["modelId", "failed"],
      where: { askedAt: { gte: since } },
      _count: { _all: true },
      _max: { askedAt: true },
    }),
    // The day's spend against the ceiling (Phase 15j). The same count the
    // student path uses, so the page and the refusal cannot disagree.
    countCollegeAsksToday(now),
  ]);
  const collegeLeft = Math.max(0, runtime.setting.dailyPerCollege - today);

  const models = foldAiUsage(
    usage.map((row) => ({
      modelId: row.modelId,
      failed: row.failed,
      count: row._count._all,
      lastAt: row._max.askedAt,
    })),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI helper"
        description="A student stuck on a practice problem can ask what they have got wrong, or how to approach it. Practice only — never a contest, never an assessment."
      />

      {runtime.misconfiguration ? (
        <Notice tone="warning" title="The assistant cannot answer yet">
          {runtime.misconfiguration} Until that is fixed the helper is invisible to students, whatever this page says.
        </Notice>
      ) : null}

      <Card>
        <CardHeader title="What this is, and what it costs" />
        <CardBody className="space-y-3 text-sm">
          <p>
            The assistant teaches; it does not finish the work. It is told, every time, never to write a complete
            solution and never more than three lines of code at once — to name the bug, or the idea the student is
            missing, and let them write it. <strong>And it is held to that rather than asked.</strong> Every answer is
            measured before anybody sees it: a code block longer than three lines, or a program written three lines at
            a time, is taken out and the student is told that it was. The explanation around it is left alone.
          </p>
          <p>
            <strong>A student&apos;s own draft code leaves the college when this is on.</strong> Each question sends
            the public problem statement, the student&apos;s current draft, the verdict of their last run and the
            sample case it failed. It never sends hidden test data, another student&apos;s work, or anything that says
            who the student is. The API key lives in the server environment and cannot be set from this page.
          </p>
          <p>
            <strong>Using it makes a later first solve assisted.</strong> That solve still counts and still pays XP at
            the assisted rate, but it is excluded from the unassisted evidence a readiness score is built on — the same
            rule the tier-3 hint and the editorial already follow. Without that, every readiness number in the college
            would quietly inflate.
          </p>
          <p>
            A student cannot ask straight away: the button unlocks after one judged submission or{" "}
            {HINT_POLICY.tier2.activeMinutes} minutes of work on that problem, which is the same threshold hint 2 uses.
            Each student gets a set number of questions a day, from {AI_DAILY_LIMIT.min} to {AI_DAILY_LIMIT.max}.
          </p>
          <p>
            <strong>And the college has an allowance of its own.</strong> The per-student number is not a budget —
            five thousand students at ten questions each is fifty thousand paid calls in a day. The college ceiling is
            what stops that: reaching it rests the assistant for everybody until midnight IST, and the student is told
            it is not about their own allowance. A failed ask costs neither.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Settings"
          subtitle={
            row
              ? `Saved ${formatCampusTime(row.updatedAt)}`
              : "Never saved — these are the defaults the code ships, with the assistant off."
          }
        />
        <CardBody>
          <AiHelperForm initial={runtime.setting} endpoints={runtime.endpoints} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="The model"
          subtitle="Any model the provider publishes. The familiar ones are one click away; the field is free underneath."
        />
        <CardBody className="space-y-3 text-sm">
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt className="font-medium">In use</dt>
            <dd>
              {runtime.model ? (
                <>
                  <span className="font-mono text-xs">{runtime.model.id}</span>{" "}
                  <span className="text-text-secondary">via {AI_PROVIDER_LABEL[runtime.setting.provider]}</span>
                  {runtime.model.baseUrl ? (
                    <span className="text-text-secondary"> at {runtime.model.baseUrl}</span>
                  ) : null}
                </>
              ) : (
                <span className="text-text-secondary">Nothing this deployment can reach — see above.</span>
              )}
            </dd>
            <dt className="font-medium">Addresses allowed</dt>
            <dd className="text-text-secondary">
              {runtime.endpoints.length > 0 ? (
                <span className="font-mono text-xs">{runtime.endpoints.join(", ")}</span>
              ) : (
                "None. An OpenAI-compatible endpoint needs AI_BASE_URL set on the server, which can name several, separated by commas."
              )}
            </dd>
          </dl>
          <p className="text-text-secondary">
            Two things are not set from this page, and both for the same reason — they are where the key and a
            student&apos;s draft would go. The API key lives in the server environment and cannot be set, read or
            cleared from this page. The addresses that may be reached are{" "}
            <code className="font-mono text-xs">AI_BASE_URL</code>; a super-admin chooses among them and cannot add
            one, so a stolen session cannot point the assistant at itself.
          </p>
          <ul className="space-y-2">
            {AI_PROVIDERS_NOTE_LIST.map(({ provider, note }) => (
              <li key={provider}>
                <span className="font-medium">{AI_PROVIDER_LABEL[provider]}</span>{" "}
                <span className="text-text-secondary">{note}</span>
              </li>
            ))}
          </ul>
          <p className="text-text-secondary">
            Suggested, not required:{" "}
            {AI_MODEL_PRESETS.map((preset) => preset.label).join(", ")}.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Today"
          subtitle="The college's allowance resets at midnight IST. A failed ask does not count against it."
        />
        <CardBody>
          <p className="text-sm">
            <strong>
              {today} of {runtime.setting.dailyPerCollege}
            </strong>{" "}
            questions answered across the college today.{" "}
            {collegeLeft === 0 ? (
              <span className="text-warning">
                The allowance is used up, so the assistant is resting until midnight IST. Raise the ceiling above to
                bring it back today.
              </span>
            ) : (
              <span className="text-text-secondary">{collegeLeft} left before it rests for the day.</span>
            )}
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="The last 30 days" subtitle="Questions answered, and by which model. Never the questions themselves." />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="inline font-medium">Answered </dt>
              <dd className="inline">{asked}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Failed </dt>
              <dd className="inline">{failed}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Students who asked </dt>
              <dd className="inline">{students.length}</dd>
            </div>
          </dl>

          {models.length > 0 ? (
            <table className="mt-4 w-full text-left text-sm">
              <caption className="sr-only">
                Questions answered and failed in the last 30 days, by the model that answered
              </caption>
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Model
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Answered
                  </th>
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Failed
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Last asked
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.modelId} className="border-b border-border/50 last:border-0">
                    <th scope="row" className="py-1 pr-4 font-mono text-xs font-normal">
                      {model.modelId}
                    </th>
                    <td className="py-1 pr-4">{model.answered}</td>
                    <td className="py-1 pr-4">{model.failed}</td>
                    <td className="py-1 text-text-secondary">
                      {model.lastAt ? formatCampusTime(model.lastAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-4 text-text-secondary">
              Nobody has asked yet, so there is nothing to compare. Once they have, this says which model answered and
              how often it did not — which is the only way to tell whether a change of model was an improvement.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
