import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@recx/design";
import { formatCampusTime } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { myStanding, myStatusHistory } from "@/server/queries/account";
import { ReactivateButton } from "@/components/account/reactivate-button";

export const metadata: Metadata = { title: "Your account" };

/**
 * `/account/reactivate` — where you stand, and the one button (Phase 8e).
 *
 * The page a restricted student is sent to, and the most important page in
 * Phase 8. Three things it has to get right:
 *
 *   1. The explanation comes BEFORE anything else in DOM order, so a
 *      screen-reader user meets it first rather than finding a button whose
 *      purpose they have to hunt for.
 *   2. It says what still works, as a list. A student who believes they have
 *      been thrown off stops trying; a student who reads "you can still
 *      solve, and solving fixes this" does the thing that fixes it.
 *   3. The word "disabled" appears nowhere, at any rung, and a copy test
 *      enforces that over this file.
 *
 * It must stay reachable to a restricted account. A route out that is behind
 * the restriction is not a route out.
 */
export default async function ReactivatePage() {
  const user = await requireUser();
  const [standing, history] = await Promise.all([myStanding(user.id), myStatusHistory(user.id)]);
  const paused = standing.stage !== "NONE";

  return (
    <div className="space-y-8">
      {/* The explanation first, in DOM order. */}
      <header className="space-y-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {paused ? standing.stageLabel : "Your account is active"}
        </h1>
        {paused ? (
          <>
            <p className="max-w-2xl text-sm">
              {standing.chip.show
                ? standing.chip.label
                : "Your account is paused because the platform has not seen you practise for a while."}
            </p>
            <p className="max-w-2xl text-sm text-text-secondary">
              This is not a mark against you and it is not on any record a recruiter sees. It exists so that somebody
              notices when a student goes quiet — because usually something is wrong, and usually it is fixable.
            </p>
          </>
        ) : (
          <p className="max-w-2xl text-sm text-text-secondary">
            Nothing is paused and nothing is restricted. You are on the leaderboard and you can enter contests.
          </p>
        )}
      </header>

      {paused ? (
        <>
          <section className="space-y-3 rounded-xl border border-border p-5">
            <h2 className="font-display text-lg font-semibold">Put it back now</h2>
            <p className="text-sm text-text-secondary">
              One click, no approval, and nobody is told. You can also just solve one problem — that lifts it too.
            </p>
            <ReactivateButton disabledReason={standing.selfClear.allowed ? null : standing.selfClear.reason} />
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            <section className="space-y-3">
              <h2 className="font-display text-base font-semibold">What still works</h2>
              {/* Deliberately the LONGER list, and first of the two. */}
              <ul className="space-y-2 text-sm">
                {standing.doesNotBlock.map((effect) => (
                  <li key={effect.key} className="flex gap-2">
                    <span aria-hidden="true" className="text-success">
                      ✓
                    </span>
                    <span>{effect.says}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-3">
              <h2 className="font-display text-base font-semibold">What is paused</h2>
              <ul className="space-y-2 text-sm">
                {standing.blocks.map((effect) => (
                  <li key={effect.key} className="flex gap-2">
                    <span aria-hidden="true" className="text-muted">
                      ·
                    </span>
                    <span>{effect.says}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted">
                Your XP is still being recorded while this is paused. Nothing is lost and nothing has to be earned
                again.
              </p>
            </section>
          </div>

          <section className="space-y-2 rounded-xl border border-border p-5 text-sm">
            <h2 className="font-display text-base font-semibold">If you were ill or away</h2>
            <p className="max-w-2xl text-text-secondary">
              Those days should not have counted at all. Tell us about them and the placement cell will excuse them —
              holidays, exam weeks and placement weeks are already excluded automatically.
            </p>
            <p>
              <Link href="/account/leave" className="text-primary underline">
                Ask for days to be excused
              </Link>
            </p>
          </section>
        </>
      ) : null}

      <section className="space-y-3 border-t border-border pt-5">
        <h2 className="font-display text-lg font-semibold">What has happened to your account</h2>
        {history.length === 0 ? (
          <p className="text-sm text-text-secondary">Nothing. Your account has never been paused or restricted.</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {history.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-2 border-b border-border pb-3 last:border-0">
                <Badge tone={entry.toStage === "NONE" ? "success" : "info"}>{entry.toStageLabel}</Badge>
                <span className="text-text-secondary">by {entry.by}</span>
                <span className="text-xs text-muted">{formatCampusTime(entry.at)}</span>
                {entry.reason ? <span className="w-full text-xs text-text-secondary">&ldquo;{entry.reason}&rdquo;</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="max-w-2xl text-xs text-muted">
          Every line here was recorded with the reasoning behind it. If you think any of it is wrong, the placement
          cell can see exactly what was counted and why — ask them.
        </p>
      </section>
    </div>
  );
}
