import "server-only";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@recx/design";

/** Breadcrumb plus the three views of one problem (overview, test cases, validation). */
export function ProblemNav({
  problemId,
  displayCode,
  title,
  current,
  rev,
}: {
  problemId: string;
  displayCode: string;
  title: string;
  current: "overview" | "testcases" | "validate";
  /** Keep ?rev=N when moving between the views of an older revision. */
  rev: number | null;
}) {
  const q = rev !== null ? `?rev=${rev}` : "";
  const tabs = [
    { key: "overview", label: "Overview", href: `/admin/problems/${problemId}${q}` },
    { key: "testcases", label: "Test cases", href: `/admin/problems/${problemId}/testcases${q}` },
    { key: "validate", label: "Validation", href: `/admin/problems/${problemId}/validate${q}` },
  ] as const;
  return (
    <div className="space-y-3">
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
          <li aria-current="page" className="min-w-0 truncate px-1 font-medium text-text">
            <span className="font-mono text-xs text-muted">{displayCode}</span> {title}
          </li>
        </ol>
      </nav>
      <nav aria-label="Problem views">
        <ul className="flex flex-wrap gap-1 border-b border-border">
          {tabs.map((t) => (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={t.key === current ? "page" : undefined}
                className={cn(
                  "-mb-px inline-block border-b-2 px-3 py-2 text-sm font-medium",
                  t.key === current ? "border-primary text-primary" : "border-transparent text-text-secondary hover:text-text",
                )}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
