"use client";

import { UsersRound } from "lucide-react";
import { staffHue } from "@/lib/it-staff";
import { counterpart, type ChatThread } from "@/lib/chat";
import { dayKey, formatShortDate, formatTime } from "@/lib/format";
import { nowMs } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";

/** The person (or the IT team) on the other side of a conversation. */
export function CounterpartAvatar({ thread, size = "md", className }: { thread: ChatThread; size?: "sm" | "md" | "lg"; className?: string }) {
  const c = counterpart(thread);
  if (c.unassigned && thread.side === "requester") {
    const box = size === "lg" ? "size-11" : size === "md" ? "size-9" : "size-8";
    return (
      <span aria-hidden className={cn("grid shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-500 ring-1 ring-inset ring-line", box, className)}>
        <UsersRound className={size === "lg" ? "size-5" : "size-4"} />
      </span>
    );
  }
  return <Avatar name={c.name} hue={staffHue(c.name)} size={size} className={className} />;
}

/** "9:41 AM" today, "Mar 3" otherwise. */
export function listTime(iso: string) {
  return dayKey(new Date(iso).getTime()) === dayKey(nowMs()) ? formatTime(iso) : formatShortDate(iso);
}

export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn("tnum grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white", className)}
      aria-label={`${count} unread`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
