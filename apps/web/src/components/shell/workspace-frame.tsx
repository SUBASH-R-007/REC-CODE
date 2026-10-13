import { cn } from "@recx/design";

/**
 * Full-bleed opt-in for the student shell — used by the coding workspace
 * (/problems/[slug]).
 *
 * HOW TO USE: render the page's content inside <WorkspaceFrame>. Nothing
 * else is needed: no layout change, no client JS, no route-group move.
 *
 * HOW IT WORKS: the frame carries `data-shell-bleed`. AppShell's root is a
 * Tailwind group named `shell`, and its pieces react to the attribute with
 * CSS :has(), so the switch happens in the first paint of the
 * server-rendered HTML and follows client-side navigation automatically
 * (the attribute leaves the DOM with the page):
 *   - <main> drops its max-width, side gutters and padding;
 *   - the >= 1024 px sidebar and the < 1024 px bottom bar are hidden, and
 *     the wordmark moves into the top bar;
 *   - the glass top bar stays (search, notifications, account).
 *
 * The frame fills the viewport below the 3.5 rem top bar on wide screens
 * (`--shell-top`, set on the shell root) and is at least that tall below
 * 1024 px, where the workspace stacks and the page scrolls. Panes inside
 * should use `min-h-0` so they can shrink.
 */
export const SHELL_BLEED_ATTRIBUTE = "data-shell-bleed";

export function WorkspaceFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      data-shell-bleed=""
      className={cn(
        "flex min-h-[calc(100dvh-var(--shell-top,3.5rem))] w-full min-w-0 flex-col lg:h-[calc(100dvh-var(--shell-top,3.5rem))] lg:min-h-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
