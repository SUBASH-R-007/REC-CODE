import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card } from "@recx/design";
import { LIMITS } from "@recx/shared";
import { requirePageRole } from "@/lib/auth/guards";
import { suggestDisplayCode } from "@/server/queries/admin-problems";
import { CreateProblemForm } from "@/components/admin/problems/create-problem-form";
import { COMPARE_MODE_OPTIONS, ORIGIN_OPTIONS } from "@/components/admin/problems/options";

export const metadata: Metadata = { title: "New problem" };

/**
 * Create a problem: its identity, the declared comparator, the statement and
 * the base limits. It starts as draft revision 1; tests, reference
 * solutions, hints and the rest are added on the problem's page.
 */
export default async function NewProblemPage() {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");
  const code = await suggestDisplayCode({ id: user.id, role: user.role });
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-sm text-text-secondary">
          <li>
            <Link href="/admin/problems" className="rounded-md px-1 hover:text-text hover:underline">
              Problems
            </Link>
          </li>
          <li aria-hidden>
            <ChevronRight className="h-3.5 w-3.5" />
          </li>
          <li aria-current="page" className="px-1 font-medium text-text">
            New problem
          </li>
        </ol>
      </nav>
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">New problem</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Every problem is originally authored. No GPU, machine-learning, multi-process or distributed problems, and nothing
          over 15 s or 1 GB — see docs/AUTHORING.md.
        </p>
      </div>
      <Card className="p-5">
        <CreateProblemForm
          suggestedDisplayCode={code}
          compareModes={COMPARE_MODE_OPTIONS}
          origins={ORIGIN_OPTIONS}
          defaultMemoryMb={LIMITS.memory.defaultKb / 1024}
        />
      </Card>
    </div>
  );
}
