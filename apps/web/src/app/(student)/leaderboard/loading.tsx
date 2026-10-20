import { Skeleton } from "@recx/design";

export default function LeaderboardLoading() {
  return (
    <div role="status" aria-label="Loading the leaderboard">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      <div className="mt-5 flex flex-wrap gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-28 rounded-full" />
        ))}
      </div>
      <Skeleton className="mt-5 h-24 w-full rounded-2xl" />
      <div className="mt-6 space-y-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
