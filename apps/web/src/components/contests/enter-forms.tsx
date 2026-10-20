"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@recx/design";
import { registerForContest, startVirtualContest } from "@/server/actions/contests";

/**
 * The two buttons a student presses on a contest landing page. Leaf client
 * components: everything they do is a server action, and the rules they
 * enforce live there (and in the database), never here.
 */

export function RegisterButton({ slug, rated }: { slug: string; rated: boolean }) {
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  return (
    <Button
      loading={pending}
      onClick={() =>
        start(async () => {
          const result = await registerForContest({ slug });
          if (result.ok) {
            toast(rated ? "Registered. Good luck." : "Registered for this unrated contest.", "success");
            router.refresh();
          } else {
            toast(result.error, "error");
          }
        })
      }
    >
      Register
    </Button>
  );
}

export function StartVirtualButton({ slug }: { slug: string }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  if (!confirming) {
    return (
      <Button variant="outline" onClick={() => setConfirming(true)}>
        Start a virtual run
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-text-secondary">
        The clock starts now and runs for the contest&apos;s full length. It is unrated and stays off the standings.
      </p>
      <Button variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
        Not now
      </Button>
      <Button
        loading={pending}
        onClick={() =>
          start(async () => {
            const result = await startVirtualContest({ slug });
            if (result.ok) {
              toast("Virtual run started. Your clock is running.", "success");
              router.refresh();
            } else {
              toast(result.error, "error");
            }
          })
        }
      >
        Start now
      </Button>
    </div>
  );
}
