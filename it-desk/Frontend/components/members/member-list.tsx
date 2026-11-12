"use client";

import { LeadBadge } from "@/components/floors/lead-badge";
import type { Member } from "@/lib/schemas";
import { cn, pluralize } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { MemberStatusDot } from "@/components/ui/status";
import { ChevronRight } from "lucide-react";
import { useMemberDetailLink } from "@/lib/member-detail-link";
import { MemberContextMenu, MemberMenuButton } from "./member-actions";

export function MemberList({
  members,
  selected,
  onToggle,
  selectable = true,
}: {
  selectable?: boolean;
  members: Member[];
  selected: Record<string, true>;
  onToggle: (id: string) => void;
}) {
  const { open } = useMemberDetailLink();
  const selecting = Object.keys(selected).length > 0;
  return (
    <div className="overflow-hidden rounded-card border border-line bg-white shadow-xs">
      <div className="hidden h-10 items-center gap-4 border-b border-line bg-subtle px-4 text-xs font-medium text-neutral-500 md:flex">
        <span className="w-[18px]" />
        <span className="w-14">Seat</span>
        <span className="flex-1">Name</span>
        <span className="w-44">Sub-group</span>
        <span className="w-20">Devices</span>
        <span className="w-[104px]" />
      </div>
      <ul className="divide-y divide-line">
        {members.map((m) => {
          const active = m.status === "active" && selectable;
          const isSelected = Boolean(selected[m.id]);
          return (
            <MemberContextMenu key={m.id} member={m}>
              <li
                data-testid="member-row"
                tabIndex={0}
                aria-label={`${m.name}. ${selecting && active ? "Toggle selection" : "View details"}`}
                onClick={selecting && active ? () => onToggle(m.id) : () => open(m.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    open(m.id);
                  } else if (e.key === " " && active) {
                    e.preventDefault();
                    onToggle(m.id);
                  }
                }}
                className={cn(
                  "flex h-14 cursor-pointer select-none items-center gap-4 px-4 outline-none transition-colors duration-150 focus-visible:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/35",
                  isSelected ? "bg-accent-soft/50" : "hover:bg-neutral-50",
                )}
              >
                {active ? (
                  <Checkbox checked={isSelected} onCheckedChange={() => onToggle(m.id)} label={`Select ${m.name}`} />
                ) : (
                  <span className="w-[18px]" />
                )}
                <span className={cn("tnum w-16 text-[15px] font-semibold tracking-[-0.01em]", active ? "text-neutral-900" : "text-neutral-300")}>
                  {m.seat ? (
                    <>
                      <span className="mr-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">Seat</span>
                      {m.seat}
                    </>
                  ) : (
                    "—"
                  )}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="relative shrink-0"><Avatar name={m.name} size="sm" ring={active ? true : "muted"} className={m.isLead ? "ring-2 ring-amber-400" : undefined} />{m.isLead ? <LeadBadge compact className="absolute -right-1 -top-1" /> : null}</span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-[13px] font-medium text-neutral-900">{m.name}</span>{m.isLead ? <LeadBadge className="h-[18px] text-[10px]" /> : null}</span>
                    <span className="block truncate text-xs text-neutral-500">{active ? m.email || m.employeeId || m.role : <MemberStatusDot status={m.status} />}</span>
                  </span>
                </span>
                <span className="hidden w-44 truncate text-[13px] text-neutral-600 md:block">{m.subGroup}</span>
                <span className="tnum hidden w-20 text-[13px] text-neutral-600 md:block">{pluralize(m.devices.length, "device")}</span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="member-view-details"
                    aria-label={`View details for ${m.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      open(m.id);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="inline-flex h-7 items-center gap-0.5 rounded-md pl-2 pr-1 text-[12px] font-medium text-neutral-600 outline-none transition-colors hover:bg-accent-soft hover:text-accent-ink focus-visible:ring-2 focus-visible:ring-accent/35"
                  >
                    <span className="max-sm:hidden">View details</span>
                    <ChevronRight className="size-3.5" aria-hidden />
                  </button>
                  <span className="w-7">
                    <MemberMenuButton member={m} />
                  </span>
                </span>
              </li>
            </MemberContextMenu>
          );
        })}
      </ul>
    </div>
  );
}
