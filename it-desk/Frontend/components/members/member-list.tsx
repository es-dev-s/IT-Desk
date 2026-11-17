"use client";

import { LeadBadge } from "@/components/floors/lead-badge";
import type { RosterEntry } from "@/lib/schemas";
import { cn, pluralize } from "@/lib/utils";
import { useTeamsById } from "@/store/selectors";
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
  members: RosterEntry[];
  selected: Record<string, true>;
  onToggle: (id: string) => void;
}) {
  const { open } = useMemberDetailLink();
  const teams = useTeamsById();
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
        {members.map((entry) => {
          const m = "status" in entry ? entry : null;
          const isLead = m?.isLead ?? true;
          const active = m?.status === "active" && selectable;
          const isSelected = Boolean(m && selected[m.id]);
          const designation = "title" in entry ? entry.title || "Team Lead" : entry.role;
          const teamName = teams[entry.teamId]?.name;
          const row = (
            <li
              key={entry.id}
              data-testid="member-row"
              tabIndex={m ? 0 : undefined}
              aria-label={m ? `${m.name}${isLead ? ", team lead" : ""}. ${selecting && active ? "Toggle selection" : "View details"}` : undefined}
              onClick={m ? () => (selecting && active ? onToggle(m.id) : open(m.id)) : undefined}
              onKeyDown={m ? (e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  open(m.id);
                } else if (e.key === " " && active) {
                  e.preventDefault();
                  onToggle(m.id);
                }
              } : undefined}
              className={cn(
                "flex h-14 select-none items-center gap-4 px-4 outline-none transition-colors duration-150 focus-visible:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/35",
                m && "cursor-pointer",
                isSelected ? "bg-accent-soft/50" : "hover:bg-neutral-50",
              )}
            >
              {m && active ? (
                <Checkbox checked={isSelected} onCheckedChange={() => onToggle(m.id)} label={`Select ${m.name}`} />
              ) : (
                <span className="w-[18px]" />
              )}
              <span className={cn("tnum w-16 text-[15px] font-semibold tracking-[-0.01em]", active || (isLead && m?.seat) ? "text-neutral-900" : "text-neutral-300")}>
                {m?.seat ? (
                  <>
                    <span className="mr-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">Seat</span>
                    {m.seat}
                  </>
                ) : (
                  isLead ? <span className="text-xs font-medium text-neutral-500">No seat</span> : "—"
                )}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className={cn("relative shrink-0", isLead && "max-[420px]:hidden")}>
                  <Avatar name={entry.name} size="sm" ring={active ? true : "muted"} className={isLead ? "ring-2 ring-amber-400" : undefined} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-neutral-900" title={isLead ? entry.name : undefined}>{entry.name}</span>
                  {isLead ? (
                    <>
                      <span className="block truncate text-xs text-neutral-500" title={designation}>{designation}</span>
                      <span className="block truncate text-xs text-neutral-500" title={teamName}>{teamName}</span>
                    </>
                  ) : m ? (
                    <span className="block truncate text-xs text-neutral-500">
                      {active ? m.email || m.employeeId || m.role : <MemberStatusDot status={m.status} />}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="hidden w-44 truncate text-[13px] text-neutral-600 md:block">{m?.subGroup}</span>
              <span className="tnum hidden w-20 text-[13px] text-neutral-600 md:block">{m ? pluralize(m.devices.length, "device") : ""}</span>
              <span className="flex min-w-0 items-center justify-end gap-1">
                {m ? (
                  <>
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
                  </>
                ) : null}
                {isLead ? <LeadBadge compact className="self-start" /> : null}
              </span>
            </li>
          );
          return m ? <MemberContextMenu key={m.id} member={m}>{row}</MemberContextMenu> : row;
        })}
      </ul>
    </div>
  );
}
