"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button, useToast } from "@recx/design";
import { forceSignOutStudent } from "@/server/actions/admin-students";
import { ReasonDialog } from "@/components/admin/reason-dialog";

/** "Sign out everywhere" for one in-scope student, with an audited reason. */
export function SignOutEverywhereButton({ userId, name }: { userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <LogOut className="h-4 w-4" aria-hidden />
        Sign out everywhere
      </Button>
      <ReasonDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Sign ${name} out everywhere?`}
        description="Every session of this student ends now; they can sign in again at once. Use it for a lost or shared device."
        confirmLabel="Sign out everywhere"
        danger
        onConfirm={async (reason) => {
          const result = await forceSignOutStudent({ userId, reason });
          if (result.ok) {
            toast(`${name} was signed out everywhere.`, "success");
            router.refresh();
          }
          return result;
        }}
      />
    </>
  );
}
