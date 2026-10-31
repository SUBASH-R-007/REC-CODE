"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@recx/design";
import { EXPORT_DEFAULT_DAYS, formatCampusDay } from "@recx/shared";
import { createProfileExport, revokeProfileExport } from "@/server/actions/profile-export";

/**
 * A student's own signed links (Phase 9f).
 *
 * The copy does the work here. A student about to put a link on a CV needs to
 * know three things before they click, not after: what it says, who can read
 * it, and how to take it back. All three are on the page.
 *
 * "Withdraw" rather than "delete", because that is what it does: the link
 * keeps working and starts saying the student withdrew it. A deleted link
 * would give a recruiter "not found", which reads as a mistake — they would
 * ask again, and the withdrawal would be lost.
 */
export function ExportLinks({
  appUrl,
  links,
}: {
  appUrl: string;
  links: readonly {
    readonly code: string;
    readonly kind: string;
    readonly issuedOn: string;
    readonly expiresOn: string | null;
    readonly revokedOn: string | null;
  }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const create = () => {
    setError(null);
    start(async () => {
      const result = await createProfileExport({ kind: "PROFILE" });
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  const withdraw = (code: string) => {
    setError(null);
    start(async () => {
      const result = await revokeProfileExport({ code });
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  const live = links.filter((link) => link.revokedOn === null);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="max-w-2xl text-sm text-text-secondary">
          A link anybody can open to check this record came from REC Code and has not been changed. It shows your
          name, your handle, your batch, your coverage figures and your solved counts — and nothing else. Never your
          email, your roll number, your department or your section.
        </p>
        <p className="max-w-2xl text-sm text-text-secondary">
          Each link lasts {EXPORT_DEFAULT_DAYS} days, and you can withdraw one at any time. A withdrawn link keeps
          working and says you withdrew it, so nobody is left looking at a page that merely failed to load.
        </p>
      </div>

      <Button onClick={create} disabled={pending}>
        {pending ? "Making a link…" : "Make a link"}
      </Button>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {links.length === 0 ? (
        <p className="text-sm text-text-secondary">You have not made any links yet.</p>
      ) : (
        <ul className="space-y-3">
          {links.map((link) => {
            const url = `${appUrl}/verify/${link.code}`;
            return (
              <li key={link.code} className="space-y-2 rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  {/*
                    The URL in full, selectable. A "copy" button that needs
                    JavaScript would leave a student with nothing to copy when
                    it fails; a visible URL always works.
                  */}
                  <code className="break-all text-xs">{url}</code>
                  <span className="text-xs text-text-secondary">
                    {link.revokedOn
                      ? `withdrawn ${formatCampusDay(link.revokedOn)}`
                      : link.expiresOn
                        ? `valid until ${formatCampusDay(link.expiresOn)}`
                        : "no expiry"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(url).then(() => setCopied(link.code));
                    }}
                  >
                    {copied === link.code ? "Copied" : "Copy"}
                  </Button>
                  {link.revokedOn === null ? (
                    <Button variant="ghost" onClick={() => withdraw(link.code)} disabled={pending}>
                      Withdraw
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {live.length > 1 ? (
        <p className="text-xs text-muted">
          You have {live.length} live links. A link you have forgotten about is a link you cannot withdraw, so
          withdraw the ones you are not using.
        </p>
      ) : null}
    </div>
  );
}
