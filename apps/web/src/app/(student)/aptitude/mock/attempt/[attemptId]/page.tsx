import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guards";
import { sittingViewFor } from "@/server/queries/aptitude-sitting";
import { MockSitting } from "@/components/aptitude/mock-sitting";

export const metadata: Metadata = { title: "Mock in progress" };

/**
 * `/aptitude/mock/attempt/[attemptId]` — sitting a mock (Phase 7e).
 *
 * Ownership is a `where` clause on `userId`, never a trusted param: a sitting
 * id in a URL is not authorisation, and somebody else's sitting reads as "not
 * found" so an id cannot be probed.
 *
 * It is HARD-BLOCKED below 768px, with an explanation. SPEC §7's DO NOT list
 * says plainly "Do not build a serious phone-based solving experience", and a
 * timed multi-section paper is exactly that — the same floor the contest
 * arena has. Topic practice at `/aptitude/[topic]` is fully supported at
 * 375px, because reading one question and tapping an option is the one thing
 * a phone is genuinely good at (`docs/OPEN-QUESTIONS.md`).
 *
 * A finished sitting is redirected to its review rather than re-rendered:
 * there is nothing here for somebody whose paper is scored.
 */
export default async function MockAttemptPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const user = await requireUser();
  const { attemptId } = await params;
  const view = await sittingViewFor(attemptId, user.id, new Date());
  if (!view) notFound();
  if (view.status !== "IN_PROGRESS") redirect(`/aptitude/mock/attempt/${attemptId}/review`);

  return (
    <div>
      {/* The floor. Below 768px the sitting is absent and explained, not
          restyled — the same treatment the arena gets. */}
      <div className="md:hidden">
        <div className="space-y-3 rounded-xl border border-border p-5">
          <h1 className="font-display text-xl font-bold tracking-tight">This needs a bigger screen</h1>
          <p className="text-sm text-text-secondary">
            A timed mock has several sections, a question palette and a clock that all have to be visible at once. On a
            phone one of them is always hidden, and in a timed paper that costs you marks — so we do not pretend
            otherwise.
          </p>
          <p className="text-sm text-text-secondary">
            Your sitting is safe and its clock is running. Open this page on a laptop or a tablet held wide to carry
            on.
          </p>
          <p className="text-sm">
            <Link href="/aptitude" className="text-primary underline">
              Practise one topic at a time instead
            </Link>{" "}
            — that works here.
          </p>
        </div>
      </div>

      <div className="hidden md:block">
        <MockSitting view={view} />
      </div>
    </div>
  );
}
