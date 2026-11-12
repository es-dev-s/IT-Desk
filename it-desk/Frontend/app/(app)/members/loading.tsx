import { SeatTileSkeleton, Skeleton } from "@/components/ui/skeleton";

/** Mirrors the real one-row toolbar (same container breakpoints) and tile sizes so nothing shifts. */
export default function MembersLoading() {
  return (
    <div aria-busy="true" aria-label="Loading members">
      <div className="@container mb-6">
        <div className="flex h-9 items-center gap-2">
          <Skeleton className="h-9 min-w-0 flex-1 rounded-lg @min-[920px]:max-w-72" />
          <Skeleton className="hidden h-9 w-[300px] rounded-lg @min-[920px]:block" />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Skeleton className="h-9 w-9 rounded-lg @min-[480px]:w-[84px]" />
            <Skeleton className="size-9 rounded-lg" />
            <span aria-hidden className="mx-0.5 h-5 w-px bg-line-strong" />
            <Skeleton className="h-9 w-[114px] rounded-lg @min-[600px]:w-[232px]" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 max-sm:grid-cols-2 max-sm:gap-3">
        {Array.from({ length: 12 }, (_, i) => (
          <SeatTileSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
