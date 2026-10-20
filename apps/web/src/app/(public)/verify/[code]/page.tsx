import type { Metadata } from "next";
import {
  READINESS_TIER_LABEL,
  TOPIC_LABEL,
  TOPICS,
  VERIFY_COPY,
  formatCampusDay,
  isExportCode,
  topicsTouched,
} from "@recx/shared";
import { db } from "@/lib/db";
import { verifyStored } from "@/lib/export/signature";

export const metadata: Metadata = { title: "Verify a REC Code record" };

/**
 * `/verify/[code]` — public verification (Phase 9f).
 *
 * No guard, by design: a recruiter holding a link is not a user of this
 * platform and must not be asked to become one. That makes every other
 * decision on this page a privacy decision.
 *
 *   - It renders only the signed payload. Not the live database: the page
 *     attests to what the student chose to publish on the day they published
 *     it, and a page that read current rows would publish changes the student
 *     never agreed to.
 *   - The signature is RE-DERIVED from the stored payload rather than
 *     compared to a stored copy. If the row were ever altered, a stored
 *     comparison would still pass and a re-derivation fails — which is the
 *     only reason to sign anything.
 *   - A revoked link renders as revoked rather than 404: a recruiter who gets
 *     "not found" reads it as a mistake and asks again, and the student's
 *     withdrawal is lost.
 *   - An unreadable code renders the same "no record" page as a well-formed
 *     one that does not exist, so codes cannot be probed.
 *
 * Readable at 320 px and complete without JavaScript, which it is by
 * construction: it is a server component with no client code at all.
 */
export default async function VerifyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  // A malformed code is answered exactly as a missing one, with no query.
  const row = isExportCode(code)
    ? await db.profileExport.findUnique({
        where: { code },
        select: {
          code: true,
          kind: true,
          payload: true,
          signature: true,
          algorithm: true,
          issuedAt: true,
          expiresAt: true,
          revokedAt: true,
        },
      })
    : null;

  if (!row) return <Shell status="unknown" message={VERIFY_COPY.unknown} />;

  const verdict = verifyStored(row);
  if (!verdict.ok) return <Shell status="tampered" message={VERIFY_COPY.tampered} />;

  const revoked = row.revokedAt !== null;
  const expired = row.expiresAt !== null && row.expiresAt.getTime() < Date.now();
  const status = revoked ? "revoked" : expired ? "expired" : "valid";
  const message = revoked ? VERIFY_COPY.revoked : expired ? VERIFY_COPY.expired : VERIFY_COPY.valid;
  const payload = verdict.payload;

  return (
    <Shell status={status} message={message}>
      <section className="space-y-1">
        <h2 className="font-display text-xl font-bold tracking-tight">{payload.name}</h2>
        <p className="text-sm text-text-secondary">
          @{payload.handle}
          {payload.batchYear ? ` · batch ${payload.batchYear}` : ""}
        </p>
        <p className="text-xs text-muted">
          Issued {formatCampusDay(payload.issuedOn)}
          {row.expiresAt ? `, valid until ${formatCampusDay(row.expiresAt.toISOString().slice(0, 10))}` : ""}.
        </p>
      </section>

      {payload.tiers.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Preparation coverage
          </h3>
          <table className="w-full border-collapse text-sm">
            <caption className="pb-2 text-left text-xs text-text-secondary">{VERIFY_COPY.denominator}</caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  Tier
                </th>
                <th scope="col" className="py-1.5 font-semibold">
                  Covered
                </th>
              </tr>
            </thead>
            <tbody>
              {payload.tiers.map((tier) => (
                <tr key={tier.tier} className="border-b border-border last:border-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                    {READINESS_TIER_LABEL[tier.tier]}
                  </th>
                  <td className="py-1.5 tabular-nums">
                    {tier.score === null
                      ? "not measurable"
                      : `${tier.score} out of ${tier.availableWeight} measurable`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {payload.computedOn ? (
            <p className="text-xs text-muted">
              Computed {formatCampusDay(payload.computedOn)} under weights version {payload.rulesVersion}.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Practice</h3>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Row label="Problems solved" value={payload.solvedTotal} />
          <Row label="Solved without a hint or an editorial" value={payload.solvedUnassisted} />
          <Row label="Topics with any unassisted solve" value={`${topicsTouched(payload)} of ${TOPICS.length}`} />
          <Row
            label="Contest rating"
            value={payload.rating === null ? "none yet" : `${payload.rating} over ${payload.contestsRated} rated contests`}
          />
          <Row
            label="Released assessment scores"
            value={
              payload.releasedAssessments === 0
                ? "none"
                : `${payload.releasedAssessments}, averaging ${payload.assessmentScoreAverage}%`
            }
          />
        </dl>
      </section>

      {payload.kind === "PROFILE" ? (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Unassisted solves by topic
          </h3>
          <ul className="grid gap-x-6 text-sm sm:grid-cols-2">
            {TOPICS.map((topic) => (
              <li key={topic} className="flex items-baseline justify-between gap-3 border-b border-border py-1">
                <span>{TOPIC_LABEL[topic]}</span>
                <span className="tabular-nums text-text-secondary">{payload.topics[topic] ?? 0}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-wrap gap-x-2 border-b border-border py-1">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * The page's frame, so every outcome carries the same framing.
 *
 * The status is TEXT, with a border tone as a redundant encoding. A page
 * whose only signal was a green or red border would tell a colour-blind
 * reader nothing at all — and this is the one page in the product read by
 * people who have never seen it before and will not look twice.
 */
function Shell({
  status,
  message,
  children,
}: {
  status: "valid" | "revoked" | "expired" | "unknown" | "tampered";
  message: string;
  children?: React.ReactNode;
}) {
  const tone =
    status === "valid"
      ? "border-success/40 bg-success-subtle"
      : status === "revoked" || status === "tampered"
        ? "border-danger/40 bg-danger-subtle"
        : "border-warning/40 bg-warning-subtle";
  const heading =
    status === "valid"
      ? "Verified"
      : status === "revoked"
        ? "Withdrawn by the student"
        : status === "expired"
          ? "Expired"
          : status === "tampered"
            ? "Does not verify"
            : "Not found";

  return (
    <main id="main-content" className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">REC Code</p>
        <h1 className="font-display text-2xl font-bold tracking-tight">Verify a record</h1>
      </header>

      <div className={`space-y-1 rounded-xl border p-4 ${tone}`}>
        <p className="font-display text-base font-semibold">{heading}</p>
        <p className="text-sm">{message}</p>
      </div>

      {children}

      <footer className="space-y-2 border-t border-border pt-5 text-xs text-muted">
        <p>{VERIFY_COPY.framing}</p>
        <p>
          Rajalakshmi Engineering College. This page shows only what the student chose to publish, as it stood on the
          day they published it.
        </p>
      </footer>
    </main>
  );
}
