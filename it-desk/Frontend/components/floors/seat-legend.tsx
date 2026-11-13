"use client";

import { Crown } from "lucide-react";
import { NOW_MARK_CLASS, seatLook, type SeatRelation, type SeatTone } from "@/components/floors/floor-canvas";
import { NO_TEAM_COLOR, type TeamColor } from "@/lib/team-colors";
import { cn } from "@/lib/utils";

/** One legend entry: the same inputs `seatLook` gets for a real seat in that state. */
export type SeatLegendItem = {
  key: string;
  label: string;
  color?: TeamColor;
  zoned?: boolean;
  occupied?: boolean;
  lead?: boolean;
  tone?: SeatTone;
  outOfFocus?: boolean;
  relation?: SeatRelation;
  /** Draw the "now" mark (current desk). */
  now?: boolean;
};

/** A mini seat tile styled by `seatLook` — the exact function the floor plan uses. */
export function SeatSwatch({ item }: { item: SeatLegendItem }) {
  const color = item.color ?? NO_TEAM_COLOR;
  const look = seatLook({
    color,
    zoned: item.zoned ?? false,
    occupied: item.occupied ?? false,
    lead: item.lead,
    tone: item.tone,
    outOfFocus: item.outOfFocus,
    relation: item.relation,
  });
  return (
    <span
      aria-hidden
      data-swatch={item.key}
      className={cn("relative inline-flex h-3.5 shrink-0 items-center justify-center rounded-[3px] border", item.now ? "w-7" : "w-3.5", look.className, "z-0")}
      style={look.style}
    >
      {item.occupied ? <span className="size-1 rounded-full" style={{ background: color.fill }} /> : null}
      {item.lead ? (
        <Crown className="absolute -right-0.5 -top-0.5 size-2 text-amber-600" strokeWidth={2.5} fill="currentColor" fillOpacity={0.18} />
      ) : null}
      {item.now ? <span className={cn(NOW_MARK_CLASS, "text-[7.5px] leading-none")}>now</span> : null}
    </span>
  );
}

/** One wrapping row of mini seat tiles + labels. */
export function SeatLegend({ items, className, testId = "seat-legend" }: { items: SeatLegendItem[]; className?: string; testId?: string }) {
  if (!items.length) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-neutral-600", className)} data-testid={testId} aria-label="Seat legend">
      {items.map((it) => (
        <li key={it.key} className="inline-flex items-center gap-1.5" data-legend={it.key}>
          <SeatSwatch item={it} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
