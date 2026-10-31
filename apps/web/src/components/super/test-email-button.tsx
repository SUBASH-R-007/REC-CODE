"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { sendTestEmail } from "@/server/actions/super-integrations";

/** Queue a test email to yourself through the security-mail outbox. */
export function TestEmailButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await sendTestEmail();
          if (result.ok) {
            toast("Test email queued. The scheduler sends it on its next tick.", "success");
            router.refresh();
          } else {
            toast(result.error, "error");
          }
        })
      }
    >
      <Mail className="h-4 w-4" aria-hidden />
      Send me a test email
    </Button>
  );
}
