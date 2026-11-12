import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Cable, Headphones, Keyboard, Laptop, Monitor, Mouse, Phone } from "lucide-react";
import type { DeviceKind, Direction, ItStatus, MemberStatus } from "@/lib/schemas";
import { cn } from "@/lib/utils";

export const IT_STATUS_LABEL: Record<ItStatus, string> = {
  requested: "Requested",
  scheduled: "IT scheduled",
  moved: "Devices moved",
  completed: "Completed",
};

const STEP: Record<ItStatus, number> = { requested: 1, scheduled: 2, moved: 3, completed: 4 };

/** Linear-style progress ring: one accent colour, progress carries the meaning. */
export function ItStatusGlyph({ status, className }: { status: ItStatus; className?: string }) {
  const step = STEP[status];
  const r = 5;
  const c = 2 * Math.PI * r;
  const done = status === "completed";
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0", className)} aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" strokeWidth="1.5" className={done ? "stroke-neutral-900" : "stroke-accent"} strokeDasharray={done ? undefined : "2 1.4"} />
      {done ? (
        <>
          <circle cx="8" cy="8" r="6.5" className="fill-neutral-900" />
          <path d="M5.2 8.2l1.9 1.8 3.7-3.9" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <circle
          cx="8"
          cy="8"
          r={r / 2}
          fill="none"
          strokeWidth={r}
          className="stroke-accent"
          strokeDasharray={`${(c / 2) * (step / 4)} ${c}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

export function ItStatusLabel({ status, className }: { status: ItStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap text-[13px] text-neutral-700", className)}>
      <ItStatusGlyph status={status} />
      {IT_STATUS_LABEL[status]}
    </span>
  );
}

const DIRECTION_ICON = { in: ArrowDownLeft, out: ArrowUpRight, internal: ArrowLeftRight } as const;
export const DIRECTION_LABEL: Record<Direction, string> = { in: "Moved in", out: "Moved out", internal: "Seat move" };

export function DirectionLabel({ direction, className }: { direction: Direction; className?: string }) {
  const Icon = DIRECTION_ICON[direction];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-neutral-600", className)}>
      <Icon className={cn("size-3.5", direction === "in" ? "text-accent" : "text-neutral-400")} aria-hidden />
      {DIRECTION_LABEL[direction]}
    </span>
  );
}

export const MEMBER_STATUS_LABEL: Record<MemberStatus, string> = { active: "Active", resigned: "Resigned", unknown: "Unknown" };

export function MemberStatusDot({ status }: { status: MemberStatus }) {
  if (status === "active") return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500">
      <span className={cn("size-1.5 rounded-full", status === "resigned" ? "bg-red-500" : "bg-amber-500")} />
      {MEMBER_STATUS_LABEL[status]}
    </span>
  );
}

export const DEVICE_ICON: Record<DeviceKind, React.ComponentType<{ className?: string }>> = {
  laptop: Laptop,
  monitor: Monitor,
  dock: Cable,
  phone: Phone,
  keyboard: Keyboard,
  mouse: Mouse,
  headset: Headphones,
};

export const DEVICE_LABEL: Record<DeviceKind, string> = {
  laptop: "Laptop",
  monitor: "Monitor",
  dock: "Dock",
  phone: "Desk phone",
  keyboard: "Keyboard",
  mouse: "Mouse",
  headset: "Headset",
};
