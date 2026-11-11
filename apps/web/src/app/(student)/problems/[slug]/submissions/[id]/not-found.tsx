import { ButtonLink, EmptyState } from "@recx/design";

export default function SubmissionNotFound() {
  return (
    <EmptyState
      title="Submission not found"
      description="This submission does not exist, or it is not yours to view."
      action={
        <ButtonLink href="/problems" variant="outline">
          Browse problems
        </ButtonLink>
      }
    />
  );
}
