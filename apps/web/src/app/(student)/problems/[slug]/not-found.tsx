import { ButtonLink, EmptyState } from "@recx/design";

export default function ProblemNotFound() {
  return (
    <EmptyState
      title="Problem not found"
      description="This problem does not exist or is not published yet."
      action={
        <ButtonLink href="/problems" variant="outline">
          Browse problems
        </ButtonLink>
      }
    />
  );
}
