import type { Metadata } from "next";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { languageRuntimeSchema, VERDICTS } from "@recx/shared";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { LanguageToggle } from "@/components/admin/language-toggle";
import { GlobalRejudgeForm } from "@/components/super/global-rejudge-form";
import { RotateTokenButton } from "@/components/super/rotate-token-button";
import { formatIst, PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Judge settings · Super-admin" };

/**
 * Judge governance: language toggles (the same audited
 * admin-judge#setLanguageEnabled as /admin/judge, which also refreshes
 * /judge), node token rotation (shown once, never audited) and the
 * two-person global rejudge request.
 */
export default async function SuperJudgeSettingsPage() {
  await requireSuperAdminPage();
  const [languages, nodes, problems] = await Promise.all([
    db.languageConfig.findMany({
      orderBy: [{ key: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        key: true,
        label: true,
        version: true,
        toolchainId: true,
        enabled: true,
        isCurrent: true,
        retiredAt: true,
        runtime: true,
      },
    }),
    db.judgeNode.findMany({
      orderBy: { id: "asc" },
      select: { id: true, hostname: true, status: true, lastHeartbeatAt: true, workerVersion: true },
    }),
    db.problem.findMany({
      where: { status: { in: ["PUBLISHED", "RETIRED"] } },
      orderBy: { displayCode: "asc" },
      take: 1_000,
      select: {
        id: true,
        displayCode: true,
        title: true,
        status: true,
        versions: {
          where: { frozenAt: { not: null } },
          orderBy: { revision: "desc" },
          select: { id: true, revision: true },
        },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Judge settings"
        description="Languages, node keys and global rejudges. Language changes show on the public /judge page at once."
      />

      <Card>
        <CardHeader title="Languages" subtitle="One row per pinned toolchain. Old rows stay so old submissions rejudge on their own toolchain." />
        <CardBody>
          <div role="region" tabIndex={0} aria-label="Languages" className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">Language configurations</caption>
              <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2">Language</th>
                  <th scope="col" className="px-3 py-2">Toolchain</th>
                  <th scope="col" className="px-3 py-2">Time multiplier</th>
                  <th scope="col" className="px-3 py-2">State</th>
                  <th scope="col" className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {languages.map((l) => {
                  const runtime = languageRuntimeSchema.safeParse(l.runtime);
                  return (
                    <tr key={l.id} className="border-t border-border">
                      <th scope="row" className="px-3 py-2 font-medium">
                        {l.label} <span className="text-text-secondary">{l.version}</span>
                      </th>
                      <td className="px-3 py-2 font-mono text-xs">{l.toolchainId}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {runtime.success
                          ? `×${runtime.data.fallbackMultiplier} + ${runtime.data.fallbackExtraMs} ms`
                          : "unreadable runtime"}
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap gap-1">
                          <Badge tone={l.enabled ? "success" : "default"}>{l.enabled ? "Enabled" : "Disabled"}</Badge>
                          {l.isCurrent ? <Badge tone="info">Current</Badge> : null}
                          {l.retiredAt ? <Badge>Retired</Badge> : null}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <LanguageToggle
                          languageConfigId={l.id}
                          label={l.label}
                          toolchainId={l.toolchainId}
                          enabled={l.enabled}
                          retired={l.retiredAt !== null}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Judge nodes"
          subtitle="Rotating a token cuts the node off until its worker gets the new one. Nodes are added with scripts/judge-node.ts."
        />
        <CardBody>
          {nodes.length === 0 ? (
            <EmptyState compact title="No judge nodes registered" />
          ) : (
            <ul className="space-y-2">
              {nodes.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3 text-sm">
                  <span className="font-mono font-medium">{n.id}</span>
                  <span className="text-text-secondary">{n.hostname}</span>
                  <Badge tone={n.status === "ONLINE" ? "success" : n.status === "QUARANTINED" ? "danger" : "default"}>
                    {n.status}
                  </Badge>
                  <span className="text-xs text-text-secondary">last heartbeat {formatIst(n.lastHeartbeatAt)}</span>
                  <span className="ml-auto">
                    <RotateTokenButton nodeId={n.id} hostname={n.hostname} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Global rejudge"
          subtitle="Two-person approval. One problem at a time, optionally narrowed; at most 25,000 submissions."
        />
        <CardBody>
          <GlobalRejudgeForm
            problems={problems.map((p) => ({
              id: p.id,
              label: `${p.displayCode} ${p.title}${p.status === "RETIRED" ? " (retired)" : ""}`,
              versions: p.versions.map((v) => ({ id: v.id, label: `Revision ${v.revision}` })),
            }))}
            languages={languages.filter((l) => l.isCurrent).map((l) => ({ key: l.key, label: l.label }))}
            verdicts={[...VERDICTS]}
          />
        </CardBody>
      </Card>
    </div>
  );
}
