import { Info } from "lucide-react";

/**
 * The notice SPEC §5 requires beside every seeded pattern's name.
 *
 * ONE component, rendering ONE constant, so there is nowhere for the wording
 * to drift and nothing to forget. `tests/repo/aptitude-notice.test.ts` fails
 * if any module writes a company name without rendering this.
 *
 * The notice is passed in rather than computed here, because the pattern that
 * models nobody gets a different and truthful one — telling a student that
 * the generic campus pattern is "modelled on the publicly described pattern"
 * would be the one false sentence on the page.
 *
 * It is text, not a tooltip and not a title attribute: a label somebody has
 * to hover to find is a label a screen reader user and a phone user never
 * see, and the whole point is that it cannot be missed.
 */
export function PatternNotice({ notice, className }: { notice: string; className?: string }) {
  return (
    <p className={`flex items-start gap-1.5 text-xs text-text-secondary ${className ?? ""}`}>
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{notice}</span>
    </p>
  );
}
