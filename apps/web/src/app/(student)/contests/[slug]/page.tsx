import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, Card, CardBody, CardHeader } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { formatCampusDateTime } from "@/lib/help/copy";
import { renderMarkdown } from "@/lib/markdown";
import { RegisterButton, StartVirtualButton } from "@/components/contests/enter-forms";
import {
  KIND_DESCRIPTION,
  KIND_LABEL,
  PHASE_LABEL,
  contestHref,
  formatDuration,
  freezeNotice,
  phaseTone,
  ratedNotice,
} from "@/components/contests/model";
import { getContest } from "@/server/queries/contests";
import { canFreeze } from "@recx/shared";

export const metadata: Metadata = { title: "Contest" };

/**
 * The rules are authored markdown. Same shape as the problem statement
 * classes in app/(student)/problems/[slug]/submissions/[id] and
 * app/admin/problems/[id] — tokens only, no hardcoded colour.
 */
const RULES_CLASSES = [
  "text-sm leading-relaxed text-text",
  "[&_p]:my-3 [&_strong]:font-semibold [&_em]:italic",
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-display [&_h3]:font-semibold [&_h4]:mt-4 [&_h4]:font-semibold",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_code]:rounded-md [&_code]:bg-primary-subtle [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline",
].join(" ");

/**
 * A contest's landing page: the rules, stated before the start, and the way
 * in. The problem list appears only once this student's own clock has
 * started (the query decides that, so a virtual run sees it at its own
 * start).
 */
export default async function ContestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser();
  const contest = await getContest(slug, user);
  if (!contest) notFound();

  const rated = ratedNotice(contest);
  const freeze = freezeNotice({ canFreeze: canFreeze(contest.window), freezeMinutes: contest.freezeMinutes });
  const started = contest.phase !== "upcoming";
  const live = contest.phase === "running";
  const registered = contest.registeredAs !== null;
  const virtual = contest.registeredAs === "VIRTUAL";

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text">{contest.title}</h1>
          <p className="mt-2 text-text-secondary">
            {KIND_LABEL[contest.kind]} · {formatDuration(Math.round((contest.window.endsAt.getTime() - contest.window.startsAt.getTime()) / 60_000))}
            {virtual ? " · virtual run" : ""}
          </p>
        </div>
        <Badge tone={phaseTone(contest.phase)}>{PHASE_LABEL[contest.phase]}</Badge>
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {live && registered ? <ButtonLink href={contestHref(slug, "arena")}>Enter the arena</ButtonLink> : null}
        {live && !registered ? <RegisterButton slug={slug} rated={contest.isRated} /> : null}
        {contest.phase === "upcoming" && !registered ? <RegisterButton slug={slug} rated={contest.isRated} /> : null}
        {contest.phase === "finished" && !registered ? <StartVirtualButton slug={slug} /> : null}
        {virtual && contest.phase === "running" ? <ButtonLink href={contestHref(slug, "arena")}>Continue the virtual run</ButtonLink> : null}
        <ButtonLink variant="outline" href={contestHref(slug, "standings")}>
          Standings
        </ButtonLink>
        {contest.phase === "finished" ? (
          <ButtonLink variant="outline" href={contestHref(slug, "analysis")}>
            Analysis
          </ButtonLink>
        ) : null}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <section aria-labelledby="rules-heading" className="lg:col-span-2">
          <Card>
            <CardHeader title="Rules" subtitle={KIND_DESCRIPTION[contest.kind]} />
            <CardBody>
              <h2 id="rules-heading" className="sr-only">
                Rules
              </h2>
              <div
                className={RULES_CLASSES}
                // The rules are authored markdown, sanitised server-side by
                // renderMarkdown (the same path as a problem statement).
                dangerouslySetInnerHTML={{ __html: renderMarkdown(contest.rules) }}
              />
            </CardBody>
          </Card>
        </section>

        <aside aria-labelledby="facts-heading" className="space-y-4">
          <Card>
            <CardHeader title="This contest" />
            <CardBody>
              <h2 id="facts-heading" className="sr-only">
                Contest facts
              </h2>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-text-secondary">{virtual ? "Your clock started" : "Starts"}</dt>
                  <dd className="text-text">{formatCampusDateTime(contest.window.startsAt)}</dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Ends</dt>
                  <dd className="text-text">{formatCampusDateTime(contest.window.endsAt)}</dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Rating</dt>
                  <dd className="text-text">{virtual ? "Unrated — virtual runs never change a rating." : rated.text}</dd>
                </div>
                {freeze ? (
                  <div>
                    <dt className="text-text-secondary">Standings freeze</dt>
                    <dd className="text-text">{freeze}</dd>
                  </div>
                ) : null}
              </dl>
            </CardBody>
          </Card>
        </aside>
      </div>

      {started && contest.problems.length > 0 ? (
        <section aria-labelledby="problems-heading" className="mt-8">
          <h2 id="problems-heading" className="font-display text-lg font-bold tracking-tight text-text">
            Problems
          </h2>
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
            {contest.problems.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="font-mono text-sm font-semibold text-text-secondary">{p.index}</span>
                  <Link
                    className="truncate text-primary underline-offset-2 hover:underline"
                    href={`/problems/${p.slug}`}
                  >
                    {p.title}
                  </Link>
                </span>
                <span className="shrink-0 text-sm">
                  {p.own?.solved ? (
                    <Badge tone="success">Solved</Badge>
                  ) : p.own && p.own.wrongAttempts > 0 ? (
                    <span className="text-text-secondary">
                      {p.own.wrongAttempts} attempt{p.own.wrongAttempts === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <span className="text-muted">Not attempted</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!started ? (
        <p className="mt-8 text-sm text-text-secondary">
          The problems appear when the clock starts. Registering now means you can go straight in.
        </p>
      ) : null}
    </div>
  );
}
