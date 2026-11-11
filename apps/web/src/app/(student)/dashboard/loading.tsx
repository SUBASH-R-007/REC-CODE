import { CardSkeleton, Skeleton } from "@recx/design";

/** Streams while the dashboard's read models load. */
export default function DashboardLoading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading your dashboard">
      <div>
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CardSkeleton lines={5} />
        </div>
        <CardSkeleton lines={4} />
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    </div>
  );
}
