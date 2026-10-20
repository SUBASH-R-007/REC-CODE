import { CardSkeleton, Skeleton } from "@recx/design";

export default function ProfileLoading() {
  return (
    <div role="status" aria-label="Loading your profile">
      <div className="flex items-center gap-4">
        <Skeleton className="h-14 w-14 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <CardSkeleton lines={4} />
        <div className="lg:col-span-2">
          <CardSkeleton lines={6} />
        </div>
      </div>
    </div>
  );
}
