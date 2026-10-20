import type { Metadata } from "next";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "@recx/design";
import { FEATURE_FLAG_KEYS, FEATURE_FLAGS } from "@recx/shared";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { getFeatureFlags } from "@/lib/flags";
import { FlagToggle } from "@/components/super/flag-toggle";
import { PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Flags · Super-admin" };

/** The closed registry of governance kill switches with their effective values. */
export default async function SuperFlagsPage() {
  await requireSuperAdminPage();
  const flags = await getFeatureFlags();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Flags"
        description="Kill switches for the two governance powers that can be misused quietly. The list is fixed in code."
      />
      <ul className="space-y-3">
        {FEATURE_FLAG_KEYS.map((key) => {
          const flag = FEATURE_FLAGS[key];
          const on = flags[key];
          return (
            <li key={key}>
              <Card>
                <CardHeader
                  title={flag.label}
                  subtitle={flag.description}
                  action={<FlagToggle flag={key} label={flag.label} enabled={on} />}
                />
                <CardBody>
                  <p className={`inline-flex items-center gap-1.5 text-sm font-medium ${on ? "text-success" : "text-danger"}`}>
                    {on ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
                    {on ? "On" : "Off"}
                    <span className="font-normal text-text-secondary">(default {flag.default ? "on" : "off"})</span>
                  </p>
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
