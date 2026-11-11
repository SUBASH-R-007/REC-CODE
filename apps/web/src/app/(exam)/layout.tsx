import { requireUser } from "@/lib/auth/guards";

/**
 * The exam shell (Phase 6c).
 *
 * SPEC §5 is explicit that this layout imports NOTHING from the app shell:
 *
 *   Own route group (exam) with its own layout importing nothing from the app
 *   shell: no sidebar, no bottom bar, no search, no command palette, no
 *   notifications, no leaderboard, no XP chip, no theme toggle (fixed at
 *   start so there is no mid-exam repaint), no outbound links except an
 *   in-page "Report a problem" dialog.
 *
 * Every one of those is a way out of the exam, a distraction, or a repaint
 * mid-question. `tests/repo/exam-isolation.test.ts` enforces it statically,
 * because the natural thing for a future contributor to do is reach for
 * `AppShell` and get a sidebar with a leaderboard link in it.
 *
 * The service worker needs nothing here: `/assessments/[slug]/attempt` is
 * already an exam path in `components/pwa/sw-routes.ts`, so the worker
 * refuses to intercept it and unregisters itself when one is navigated to,
 * and the root layout's registration does the same. "A stale cached shell
 * must never serve an exam" is therefore already true, and a second
 * mechanism here would be one more thing to keep in step.
 *
 * The guard runs here and again in the page: a layout guard alone is not
 * RBAC, and the attempt guard (ownership + token + deadline) runs per
 * request in `lib/exam/attempt.ts`.
 */
export default async function ExamLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <div className="min-h-dvh bg-surface text-text">{children}</div>;
}
