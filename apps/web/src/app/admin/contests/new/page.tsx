import type { Metadata } from "next";
import Link from "next/link";
import { requirePageRole } from "@/lib/auth/guards";
import { CreateContestForm } from "@/components/admin/contests/contest-forms";

export const metadata: Metadata = { title: "New contest" };

/**
 * Create a contest as a DRAFT. Only a SUPER_ADMIN is offered the
 * college-wide option — an ADMIN scoped to one department must not address
 * everybody — and the action refuses it regardless of what the form sends.
 */
export default async function NewContestPage() {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");

  return (
    <div>
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-text">New contest</h1>
        <p className="mt-2 max-w-2xl text-text-secondary">
          It starts as a draft: invisible to students until you add its problems and publish it. Publishing fixes the
          window, the scoring and whether it is rated.
        </p>
        <p className="mt-2 text-sm text-text-secondary">
          <Link className="text-primary underline-offset-2 hover:underline" href="/admin/contests">
            Back to contests
          </Link>
        </p>
      </header>
      <CreateContestForm canGoCollegeWide={user.role === "SUPER_ADMIN"} />
    </div>
  );
}
