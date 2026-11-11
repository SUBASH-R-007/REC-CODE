import type { Metadata } from "next";
import Link from "next/link";
import { DifficultyBadge, SolveStatus, VerdictBadge } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { COLLEGE_NAME, PRODUCT_NAME } from "@/lib/brand/names";

export const metadata: Metadata = { title: "Accessibility statement" };

/**
 * The contact named in docs/ACCESSIBILITY.md. The college has not named the
 * person yet; the statement says so plainly rather than inventing an address.
 * Replace with the name and email once they are confirmed.
 */
const ACCESSIBILITY_CONTACT = "To be named by the college";
const LAST_REVIEWED = "10 October 2026";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="scroll-mt-20">
      <h2 id={`${id}-heading`} className="font-display text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-text-secondary [&_strong]:font-semibold [&_strong]:text-text">
        {children}
      </div>
    </section>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-elevated px-1.5 py-0.5 font-sans text-xs text-text">{children}</kbd>;
}

/** The accessibility statement (mirrors docs/ACCESSIBILITY.md). */
export default async function AccessibilityPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-2xl font-bold tracking-tight">Accessibility statement</h1>
      <p className="mt-1 text-sm text-text-secondary">
        {PRODUCT_NAME} is built for every student at {COLLEGE_NAME}. Last reviewed {LAST_REVIEWED}.
      </p>

      <div className="mt-8 space-y-10">
        <Section id="target" title="Our target">
          <p>
            {PRODUCT_NAME} aims to conform to the <strong>Web Content Accessibility Guidelines (WCAG) 2.2, Level AA</strong>{" "}
            on every page, for every role. Two deliberate exceptions are described below.
          </p>
        </Section>

        <Section id="colour" title="Colour is never the only signal">
          <p>
            About one in twelve men cannot tell red from green, and the two most common signals here — a pass against a
            fail, an Easy problem against a Hard one — sit on exactly that axis. So every state that matters also has an
            icon or shape and words:
          </p>
          <ul className="space-y-2.5">
            <li className="flex flex-wrap items-center gap-2">
              <VerdictBadge verdict="AC" size="sm" />
              <VerdictBadge verdict="WA" size="sm" />
              <span>verdicts: a tick against a cross, the full name and a short code.</span>
            </li>
            <li className="flex flex-wrap items-center gap-2">
              <DifficultyBadge difficulty="EASY" />
              <DifficultyBadge difficulty="HARD" />
              <span>difficulty: the word plus a one-to-three bar meter.</span>
            </li>
            <li className="flex flex-wrap items-center gap-2">
              <SolveStatus status="solved" />
              <SolveStatus status="attempted" />
              <span>progress: a filled check against a dashed circle, always with the word.</span>
            </li>
          </ul>
          <p>The activity heatmap uses lightness steps, outlines empty days, and has a text equivalent for every day.</p>
        </Section>

        <Section id="keyboard" title="Keyboard and screen readers">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              Every control works with the keyboard and shows a visible focus ring. A <strong>Skip to content</strong>{" "}
              link is the first thing Tab reaches.
            </li>
            <li>
              <Kbd>Ctrl</Kbd> + <Kbd>K</Kbd> (<Kbd>⌘</Kbd> + <Kbd>K</Kbd> on a Mac), or <Kbd>/</Kbd> when you are not
              typing, opens search. <Kbd>Esc</Kbd> closes it and any dialog.
            </li>
            <li>
              The final verdict of a submission is announced once to screen readers; per-test progress stays on screen
              instead of flooding your reader.
            </li>
            <li>The workspace&apos;s resizable panes can also be resized from the keyboard on their handles.</li>
            <li>Animations and spinners stop when your system asks for reduced motion.</li>
            <li>Sign-in needs no puzzle or memory test, and password managers and pasting work.</li>
          </ul>
        </Section>

        <Section id="exceptions" title="Two deliberate exceptions">
          <ol className="list-decimal space-y-3 pl-5">
            <li>
              <strong>The coding workspace keeps a two-dimensional layout.</strong> On wide screens the problem, the
              editor and the results sit side by side so the statement stays in view while you write code; below 1024
              pixels they stack. Code itself is never reflowed: indentation carries meaning (in Python), so long lines
              scroll sideways. This uses the WCAG 1.4.10 (Reflow) allowance for content that needs a two-dimensional
              layout. Every other page reflows to a 320-pixel-wide screen without sideways scrolling.
            </li>
            <li>
              <strong>The code editor uses the Tab key to indent</strong>, as every code editor does. To move focus out
              of it, press <Kbd>Esc</Kbd> and then <Kbd>Tab</Kbd>. Or press <Kbd>Ctrl</Kbd> + <Kbd>M</Kbd> (
              <Kbd>Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>M</Kbd> on a Mac) to make Tab move focus for the rest of your
              session. The workspace repeats this next to the editor.
            </li>
          </ol>
        </Section>

        <Section id="testing" title="How we check">
          <p>
            Each release is tested keyboard-only and with the NVDA screen reader in Chrome and Firefox, at 200% and 400%
            zoom, in light and dark themes. Colour contrast and colour-vision simulations are checked automatically, and
            automated accessibility checks run on the main pages.
          </p>
        </Section>

        <Section id="report" title="Report a barrier">
          <p>
            If something in {PRODUCT_NAME} is hard or impossible to use with your setup, we treat it as a bug with the
            same priority as any other.
          </p>
          <div className="rounded-2xl border border-border bg-surface p-4">
            <p className="text-text">
              <strong>Accessibility contact:</strong> {ACCESSIBILITY_CONTACT}.
            </p>
            <p className="mt-1">
              Until the contact is named, tell your faculty coordinator, who will pass it to the {PRODUCT_NAME} team.
            </p>
          </div>
          <p>It helps to include:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>the page address and what you were trying to do;</li>
            <li>what happened instead;</li>
            <li>your browser, device, and any assistive technology (screen reader, magnifier, voice control).</li>
          </ul>
          <p>
            See also{" "}
            <Link href="/help" className="font-medium text-text underline underline-offset-2 hover:text-primary">
              how judging works
            </Link>
            .
          </p>
        </Section>
      </div>
    </div>
  );
}
