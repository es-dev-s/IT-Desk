import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-neutral-900/[0.05]", className)} />;
}

/** Same outer box as SeatTile, so swapping skeleton → content never resizes anything. */
export function SeatTileSkeleton() {
  return (
    <div aria-hidden className="flex h-[156px] flex-col rounded-2xl bg-white p-4 shadow-[0_0_0_1px_rgb(0_0_0/0.06)] max-sm:h-[140px] max-sm:p-3.5">
      <Skeleton className="h-7 w-12 rounded-lg" />
      <div className="mt-auto flex items-center gap-3">
        <Skeleton className="size-9 rounded-full max-sm:hidden" />
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="mt-3 border-t border-neutral-900/[0.06] pt-3">
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}
