import Link from "next/link";
import { MonitorSmartphone } from "lucide-react";
import { contestHref } from "./model";

/**
 * The arena is hard-blocked below 768 px (SPEC §5 and §7: "Hard-block the
 * arena below 768px with an explanatory page, not a degraded experience").
 *
 * It is done in CSS, not by sniffing the user agent, so it follows the
 * viewport rather than the device and cannot be fooled by a desktop-mode
 * phone browser:
 *
 *   - this panel is `md:hidden`  — shown only under 768 px;
 *   - the arena itself is `hidden md:block` — rendered only at 768 px and up.
 *
 * Both are in the markup, so a narrow viewport gets the explanation with no
 * JavaScript and no layout flash.
 */
export function ArenaNarrowBlock({ slug, title }: { slug: string; title: string }) {
  return (
    <div className="md:hidden" data-testid="arena-narrow-block">
      <div className="mx-auto max-w-md px-4 py-12 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-subtle text-primary">
          <MonitorSmartphone className="h-6 w-6" aria-hidden />
        </span>
        <h1 className="mt-5 font-display text-xl font-bold tracking-tight text-text">
          The contest arena needs a wider screen
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">
          {title} is a timed contest, and the arena puts the statement, the editor and the console side by side. On a
          screen under 768 pixels wide that becomes a worse experience than no contest at all, so we do not offer a cut
          down version of it.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">
          Use a laptop or a desktop — a lab machine is fine. Everything else about the contest works here.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Link
            className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover"
            href={contestHref(slug, "standings")}
          >
            See the standings
          </Link>
          <Link
            className="inline-flex h-10 items-center justify-center rounded-xl border border-border px-4 text-sm font-medium text-text hover:bg-elevated"
            href={contestHref(slug)}
          >
            Back to the contest
          </Link>
        </div>
      </div>
    </div>
  );
}
