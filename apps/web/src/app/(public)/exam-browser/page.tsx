import type { Metadata } from "next";
import { headers } from "next/headers";
import { Card } from "@recx/design";
import { EXAM_BROWSER_PROTOCOL_VERSION } from "@recx/shared";
import { examBrowserVersionFloor } from "@/lib/exam/containment";
import { examBrowserDownloads, likelyPlatform } from "@/lib/exam/exam-browser-downloads";

export const metadata: Metadata = {
  title: "REC Exam Browser",
  description:
    "What REC Exam Browser is, what it does on your machine, what it deliberately cannot do, and how to install it.",
};

// Never prerendered: it reads the deployment's version floor.
export const dynamic = "force-dynamic";

/**
 * `/exam-browser` — what it is, before anybody installs it (Phase 14e).
 *
 * Public, and that is the point. A candidate is being asked to install
 * software on their own machine to sit an exam, and the least they are
 * owed is a page they can read first, without signing in, that says what
 * it does and what it cannot do. `docs/EXAM-BROWSER.md` §4 is the list;
 * this is that list in the second person.
 *
 * It does not overclaim, and `tests/repo/forbidden-words.test.ts` would
 * fail the build if it tried. `docs/PROCTORING.md` §1 is the posture:
 * detection, evidence and deterrence — never prevention.
 */
/** Bytes a person can read, for a file they are about to wait for. */
function megabytes(bytes: number | null): string | null {
  return bytes === null ? null : `${(bytes / 1_000_000).toFixed(0)} MB`;
}

export default async function ExamBrowserPage() {
  const [floor, downloads, userAgent] = await Promise.all([
    examBrowserVersionFloor(),
    examBrowserDownloads(),
    headers().then((all) => all.get("user-agent")),
  ]);
  // A guess at which button to put first, never a gate: every build stays
  // listed, because a candidate downloading on one machine for another is
  // ordinary the evening before a paper.
  const mine = likelyPlatform(userAgent);
  const offers = downloads.available
    ? [...downloads.offers].sort((a, b) => Number(b.platform === mine) - Number(a.platform === mine))
    : [];

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-display text-3xl font-semibold text-text">REC Exam Browser</h1>
      <p className="mt-3 text-text-secondary">
        A window of its own for one paper. Your department sets some assessments to be sat in it; the rest are sat in
        an ordinary browser, and you will be told which on the readiness check before anything starts.
      </p>

      <Card className="mt-8 p-5">
        <h2 className="font-display text-lg font-semibold text-text">What it does while you sit a paper</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-text-secondary">
          <li>Opens full screen on your exam and nothing else. No address bar, no tabs, no other sites.</li>
          <li>Proves to the server that the paper is being sat inside it, on every request.</li>
          <li>
            Signs itself in from the Launch you pressed in your own browser, so you never type your password into this
            window. The sitting shows up in your own list of signed-in devices as &ldquo;REC Exam Browser&rdquo;, and it
            ends when the paper does.
          </li>
          <li>
            Clears your clipboard when the sitting starts and when it ends. It does not read what was in it, and it
            does not stop you copying and pasting your own work inside the paper.
          </li>
          <li>Counts how many screens are attached, so you can unplug a second one before the clock starts.</li>
          <li>Asks the operating system to keep the window out of screen recordings and screen shares.</li>
        </ul>
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="font-display text-lg font-semibold text-text">What it cannot do</h2>
        <p className="mt-2 text-sm text-text-secondary">
          These are not settings. The software has no code for any of them, and a test in this project&apos;s own
          repository fails the build if any appears.
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-text-secondary">
          <li>It cannot use your camera, your microphone or record your screen.</li>
          <li>It cannot read what you type outside the exam, and does not record keystrokes anywhere.</li>
          <li>It cannot read what was in your clipboard — it clears it, which is not the same as looking at it.</li>
          <li>It cannot read your files, your browsing history or any password you have saved.</li>
          <li>
            It cannot keep you signed in afterwards. Nothing about the sitting is written to your disk, and the sign-in
            it used stops working when the paper ends.
          </li>
          <li>
            It does not keep running. There is no service, no startup entry and no icon left in your system tray; when
            the paper ends, the program ends.
          </li>
        </ul>
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="font-display text-lg font-semibold text-text">Installing it</h2>

        {downloads.available ? (
          <>
            <p className="mt-2 text-sm text-text-secondary">
              Download it here. This is your college&apos;s own copy, served from the same address you sign in to, so
              the build you install is one your department can vouch for — never install an exam browser from a link
              somebody sent you.
            </p>
            <ul className="mt-4 space-y-2">
              {offers.map((offer) => (
                <li key={offer.platform}>
                  <a
                    href={`/api/exam-browser/download/${offer.platform}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl border border-border px-4 py-3 text-sm hover:border-accent"
                    download
                  >
                    <span className="font-medium text-text">
                      {offer.label}
                      {offer.platform === mine ? (
                        <span className="ml-2 text-xs text-text-secondary">(this machine, probably)</span>
                      ) : null}
                    </span>
                    <span className="text-xs text-text-secondary tabular-nums">
                      {[`Version ${downloads.version}`, megabytes(offer.bytes), offer.signed ? null : "unsigned"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            {offers.some((offer) => offer.sha256) ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-text-secondary">
                  Checksums, if you want to verify the download yourself
                </summary>
                <dl className="mt-2 space-y-1 text-xs">
                  {offers
                    .filter((offer) => offer.sha256)
                    .map((offer) => (
                      <div key={offer.platform}>
                        <dt className="text-text-secondary">{offer.file}</dt>
                        <dd className="break-all font-mono text-text">{offer.sha256}</dd>
                      </div>
                    ))}
                </dl>
              </details>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">
            {downloads.reason === "switched_off"
              ? "Your college is not handing out the installer from this page. Ask your department or your invigilator for the current build — and ask them, rather than taking a copy from anywhere else."
              : "No build is published here yet. Ask your department or your invigilator for the current one."}
          </p>
        )}

        <p className="mt-3 text-sm text-text-secondary">
          The readiness check will tell you if the copy you have is too old to sit a paper with.
        </p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-text-secondary">Lowest version accepted</dt>
          <dd className="text-text tabular-nums">{floor ?? "any version"}</dd>
          <dt className="text-text-secondary">Handshake version</dt>
          <dd className="text-text tabular-nums">{EXAM_BROWSER_PROTOCOL_VERSION}</dd>
        </dl>
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="font-display text-lg font-semibold text-text">What it is worth, honestly</h2>
        <p className="mt-2 text-sm text-text-secondary">
          A proctored assessment is monitored and recorded, and this is one of the things doing the monitoring. It
          raises the cost of the easy ways to get help and it leaves a record a person reads. It is not a claim that
          nobody can cheat: the machine is yours, and a phone on the desk beside it is outside the reach of any
          software. The control that matters most is still a person in the room.
        </p>
        <p className="mt-3 text-sm text-text-secondary">
          Nothing it observes is ever acted on automatically. The most that can happen is that an attempt is marked
          for a human to review, and a reviewer decides.
        </p>
      </Card>
    </div>
  );
}
