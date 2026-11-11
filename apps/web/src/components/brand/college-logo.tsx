import { cn } from "@recx/design";
import { COLLEGE_NAME } from "@/lib/brand/names";

/**
 * The college's own mark (Phase 13b).
 *
 * `Wordmark` is the PRODUCT's mark — a glyph and the words "REC Code" —
 * and it belongs in every shell's top-left, where it says which
 * application you are in. This is the INSTITUTION's mark, and it belongs
 * where the institution is making a statement: the sign-in page, the
 * password-recovery pages, the footer of a signed-in shell, the page a
 * recruiter opens to verify a record, and the checks a candidate reads
 * before an exam. The two are not interchangeable and neither replaces
 * the other.
 *
 * **The white plaque is deliberate.** The artwork is one colour (REC
 * purple, with the torch in gold) on transparency, and this product has a
 * dark theme. Purple ink on a near-black surface fails contrast and looks
 * broken; recolouring the mark would mean inventing a variant of somebody
 * else's identity. So the mark always sits on white, which is the surface
 * it was drawn for. On a light page the plaque is invisible; on a dark
 * page, and on the sign-in page's purple panel, it reads as a small card.
 * `bg-white` rather than a theme token for exactly that reason: this one
 * surface must NOT follow the theme.
 *
 * No border or ring around the plaque. With one, a light page showed the
 * mark sitting in a little box -- a second card inside the card. Without
 * it, the plaque disappears into a light page and only appears where it
 * has work to do.
 *
 * No `dark:` variant anywhere here, which is also the house style — this
 * design system flips tokens on `.dark` and components never branch on
 * the theme themselves.
 *
 * It lives in `components/brand/` rather than `components/shell/` because
 * the exam tree may use it: `tests/repo/exam-isolation.test.ts` refuses
 * every import from the shell directory -- rightly, since that is where
 * the sidebar, the search and the nav live -- and a static mark is none
 * of those. Putting it here means the readiness page can carry it
 * without a hole being cut in that fence.
 *
 * A plain `<img>`, not `next/image`: the sign-in page is Pages Router with
 * `unstable_runtimeJS: false` and a size budget that asserts it ships NO
 * script at all. Width and height are the artwork's own, so the box is
 * reserved before the bytes arrive and nothing shifts.
 */

const INTRINSIC = { width: 288, height: 93 } as const;

/** Rendered heights. The width follows the aspect ratio. */
const HEIGHT = {
  sm: "h-5",
  md: "h-7",
  lg: "h-9",
} as const;

export function CollegeLogo({
  size = "md",
  decorative = false,
  className,
}: {
  readonly size?: keyof typeof HEIGHT;
  /**
   * True where the college's name is already written beside the mark, so
   * a screen reader is not made to say it twice. The plaque is then
   * announced as nothing at all, which is what a repeated logo is.
   */
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        /**
         * `w-fit` because `inline-flex` is not enough: in a flex column --
         * which the sign-in page's brand panel is -- the default
         * `align-self: stretch` widened the plaque to the full panel and
         * the mark sat in the corner of a white band across the bottom.
         * Caught by looking at the page rather than by any test.
         */
        "inline-flex w-fit items-center rounded-lg bg-white px-2.5 py-1.5",
        className,
      )}
    >
      {/*
        A plain <img>, and the rule is disabled rather than worked around.
        `next/image` is a client component: on the sign-in page -- Pages
        Router, `unstable_runtimeJS: false`, with a size budget that
        asserts the served HTML carries NO script -- it would break the
        one page that must work before any JavaScript does. The artwork is
        a 21 KB PNG at its display size, so there is nothing for an
        optimiser to win here either.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/rec-college-logo.png"
        alt={decorative ? "" : COLLEGE_NAME}
        width={INTRINSIC.width}
        height={INTRINSIC.height}
        decoding="async"
        className={cn("w-auto", HEIGHT[size])}
      />
    </span>
  );
}
