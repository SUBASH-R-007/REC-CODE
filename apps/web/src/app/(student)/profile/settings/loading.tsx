import { CardSkeleton, Skeleton } from "@recx/design";

export default function ProfileSettingsLoading() {
  return (
    <div role="status" aria-label="Loading your settings" className="mx-auto max-w-2xl">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-3 h-8 w-56" />
      <div className="mt-6">
        <CardSkeleton lines={8} />
      </div>
    </div>
  );
}
