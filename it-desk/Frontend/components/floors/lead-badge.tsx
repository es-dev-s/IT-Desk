import { Crown } from "lucide-react";
import { cn } from "@/lib/utils";

/** Team-lead marker used everywhere a person or seat is shown: amber crown (+ "Lead" when there's room). */
export function LeadBadge({ compact = false, className }: { compact?: boolean; className?: string }) {
  if (compact) {
    return (
      <span
        title="Team lead"
        aria-label="Team lead"
        className={cn("inline-grid size-4 shrink-0 place-items-center rounded-full bg-amber-400 text-amber-950 ring-2 ring-white", className)}
      >
        <Crown className="size-2.5" strokeWidth={2.5} aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-900 ring-1 ring-inset ring-amber-300",
        className,
      )}
      data-testid="lead-badge"
    >
      <Crown className="size-3" strokeWidth={2.5} aria-hidden />
      Team lead
    </span>
  );
}
