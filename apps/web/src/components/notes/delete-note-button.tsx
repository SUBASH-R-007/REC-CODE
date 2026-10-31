"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button, Dialog, useToast } from "@recx/design";
import { deleteNote } from "@/server/actions/notes";

/** Delete with a confirmation dialog (deleting a note cannot be undone). */
export function DeleteNoteButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function confirm() {
    setError(null);
    start(async () => {
      const result = await deleteNote({ id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast("Note deleted.", "success");
      router.push("/notes");
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" aria-hidden />
        Delete
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Delete this note?" size="sm">
        <p className="text-sm text-text-secondary">
          “{title}” will be deleted permanently. This cannot be undone.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Keep note
          </Button>
          <Button variant="danger" onClick={confirm} loading={pending}>
            Delete note
          </Button>
        </div>
      </Dialog>
    </>
  );
}
