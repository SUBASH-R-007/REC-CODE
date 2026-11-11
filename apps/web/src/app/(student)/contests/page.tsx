import type { Metadata } from "next";
import Link from "next/link";
import { Trophy } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { formatCampusDateTime } from "@/lib/help/copy";
import { KIND_LABEL, PHASE_LABEL, contestHref, formatDuration, phaseTone } from "@/components/contests/model";
import { listContests, type ContestListRow } from "@/server/queries/contests";

export const metadata: Metadata = { title: "Contests" };

function Section({ title, description, rows }: { title: string; description: string; rows: ContestListRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={`${title.toLowerCase()}-heading`} className="mt-8">
      <h2 id={`${title.toLowerCase()}-heading`} className="font-display text-lg font-bold tracking-tight text-text">
        {title}
      </h2>
      <p className="mt-1 text-sm text-text-secondary">{description}</p>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2">
        {rows.map((c) => (
          <li key={c.id}>
            <Card>
              <CardHeader
                title={
                  <Link className="text-primary underline-offset-2 hover:underline" href={contestHref(c.slug)}>
                    {c.title}
                  </Link>
                }
                subtitle={`${KIND_LABEL[c.kind]} · ${formatDuration(c.durationMinutes)} · ${c.problemCount} problem${c.problemCount === 1 ? "" : "s"}`}
                action={<Badge tone={phaseTone(c.phase)}>{PHASE_LABEL[c.phase]}</Badge>}
              />
              <CardBody>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-text-secondary">Starts</dt>
                    <dd className="text-text">{formatCampusDateTime(c.startsAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">Rating</dt>
                    <dd className="text-text">{c.isRated ? "Rated" : "Unrated"}</dd>
                  </div>
                </dl>
                {c.registeredAs ? (
                  <p className="mt-3 text-sm text-success">
                    {c.registeredAs === "VIRTUAL" ? "Virtual run started" : "You are registered"}
                  </p>
                ) : null}
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Contests (Phase 5): what is running, what is coming and what is over.
 * A DRAFT contest is never listed, and a COHORT contest only appears to the
 * cohort it is for (both decided in server/queries/contests.ts).
 */
export default async function ContestsPage() {
  const user = await requireUser();
  const contests = await listContests(user);

  const running = contests.filter((c) => c.phase === "running");
  const upcoming = contests.filter((c) => c.phase === "upcoming").reverse();
  const finished = contests.filter((c) => c.phase === "finished");

  return (
    <div>
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-text">Contests</h1>
        <p className="mt-2 max-w-2xl text-text-secondary">
          Timed rounds against the rest of the college. Your rating moves only in rated contests, and only after at
          least 30 students take part.
        </p>
      </header>

      {contests.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<Trophy className="h-6 w-6" aria-hidden />}
            title="No contests yet"
            description="When your department schedules one, it will appear here with its rules before it starts."
          />
        </div>
      ) : (
        <>
          <Section title="Running" description="Open now. Enter the arena to solve." rows={running} />
          <Section title="Upcoming" description="Register in advance; the problems appear when the clock starts." rows={upcoming} />
          <Section title="Finished" description="Read the analysis, or replay one virtually against the original clock." rows={finished} />
        </>
      )}
    </div>
  );
}
