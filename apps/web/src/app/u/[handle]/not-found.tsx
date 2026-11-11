import { UserX } from "lucide-react";
import { ButtonLink, Card, EmptyState } from "@recx/design";

/**
 * One answer for "no such handle" and "not visible to you", so a 404 never
 * confirms that a hidden profile exists.
 */
export default function ProfileNotFound() {
  return (
    <Card className="mx-auto mt-6 max-w-md">
      <EmptyState
        icon={<UserX className="h-8 w-8" aria-hidden />}
        title="Profile not found"
        description="There is no profile here that you can see. It may not exist, or its owner may share it only with signed-in REC students or keep it private."
        action={<ButtonLink href="/">Go to REC Code</ButtonLink>}
      />
    </Card>
  );
}
