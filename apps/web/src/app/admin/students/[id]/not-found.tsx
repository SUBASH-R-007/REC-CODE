import { UserX } from "lucide-react";
import { ButtonLink, Card, EmptyState } from "@recx/design";

/** A missing student and one outside the viewer's scope look the same. */
export default function StudentNotFound() {
  return (
    <Card>
      <EmptyState
        icon={<UserX className="h-6 w-6" />}
        title="That student was not found"
        description="The link may be wrong, or the student is outside the departments and batches you manage."
        action={
          <ButtonLink href="/admin/students" variant="outline">
            Back to students
          </ButtonLink>
        }
      />
    </Card>
  );
}
