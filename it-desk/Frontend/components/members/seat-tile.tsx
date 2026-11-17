"use client";

import { LeadBadge } from "@/components/floors/lead-badge";
import { Check, ChevronRight, Laptop } from "lucide-react";
import { useMemberDetailLink } from "@/lib/member-detail-link";
import { memo } from "react";
import type { ItStatus, RosterEntry } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { IT_STATUS_LABEL, ItStatusGlyph } from "@/components/ui/status";
import { MemberContextMenu, MemberMenuButton } from "./member-actions";
import { seatLabel } from "@/lib/floors";

/** Controls fade in on hover / keyboard focus (always shown on touch, and while selecting). */
const reveal =
  "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-data-[state=open]:opacity-100";

/**
 * A seat card. Hierarchy: desk code → person → context (group, devices, state).
 * Fixed height so every row lines up; hover lift is transform + shadow only, so nothing reflows.
 */
export const SeatTile = memo(function SeatTile({
  entry,
  teamName,
  selected,
  selecting,
  pending,
  onToggle,
  selectable = true,
}: {
  entry: RosterEntry;
  teamName?: string;
  /** False for read-only roles: no selection controls at all. */
  selectable?: boolean;
  selected: boolean;
  selecting: boolean;
  /** IT status of an open transfer that involves this member, if any. */
  pending?: ItStatus;
  onToggle: (id: string) => void;
}) {
  const member = "status" in entry ? entry : null;
  const isLead = member?.isLead ?? true;
  const active = !member || member.status === "active";
  const canSelect = Boolean(member && active && selectable);
  const designation = "title" in entry ? entry.title || "Team Lead" : entry.role;
  const seat = seatLabel(member?.seat, "No seat");
  const toggle = () => onToggle(entry.id);
  const { open } = useMemberDetailLink();
  const view = () => open(entry.id);
  // While a selection is in progress a click keeps selecting; otherwise it opens the details.
  const onCard = selecting && canSelect ? toggle : view;
  const card = (
    <div
      data-card
      data-selected={selected || undefined}
      data-testid="member-card"
      role={member ? "button" : undefined}
      tabIndex={member ? 0 : undefined}
      aria-label={member ? `${entry.name}${isLead ? ", team lead" : ""}, seat ${seatLabel(member.seat, "none")}. ${selecting && canSelect ? "Toggle selection" : "View details"}` : undefined}
      onClick={member ? onCard : undefined}
      onKeyDown={member ? (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          e.preventDefault();
          view();
        } else if (e.key === " " && canSelect) {
          e.preventDefault();
          toggle();
        }
      } : undefined}
      className={cn(
        "group relative flex h-[156px] select-none flex-col rounded-2xl p-4 outline-none max-sm:h-[140px] max-sm:p-3.5",
        member && "cursor-pointer",
        "focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        "transition-[transform,box-shadow,background-color] duration-200 ease-out will-change-transform",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/35 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-canvas",
        active
          ? selected
            ? "bg-white shadow-[0_0_0_2px_var(--color-accent),0_8px_24px_-12px_rgb(201_72_10/0.45)]"
            : "bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.04),0_2px_6px_-2px_rgb(0_0_0/0.04)] motion-safe:[@media(hover:hover)]:hover:-translate-y-0.5 [@media(hover:hover)]:hover:shadow-[0_0_0_1px_rgb(0_0_0/0.07),0_2px_4px_rgb(0_0_0/0.04),0_12px_28px_-12px_rgb(0_0_0/0.18)]"
          : "bg-neutral-50/80 shadow-[0_0_0_1px_rgb(0_0_0/0.05)]",
      )}
    >
      {/* Seat + controls */}
      <div className="flex h-7 items-start justify-between gap-2">
        <span
          className={cn(
            "tnum inline-flex h-7 items-center rounded-lg px-2 text-[14px] font-semibold tracking-[-0.01em]",
            !active ? "bg-neutral-900/[0.04] text-neutral-400" : selected ? "bg-accent text-white" : "bg-neutral-900/[0.05] text-neutral-900",
          )}
        >
          {seat}
        </span>
        {(member && active) || isLead ? (
          <div className="-mr-1 -mt-0.5 flex h-7 items-center gap-0.5">
            {canSelect ? (
              <span className={cn("transition-opacity duration-150", !(selected || selecting) && reveal)}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  aria-label={`Select ${entry.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle();
                  }}
                  className="grid size-7 place-items-center rounded-full outline-none"
                >
                  <span
                    className={cn(
                      "grid size-[18px] place-items-center rounded-full border transition-[background-color,border-color] duration-150",
                      selected ? "border-accent bg-accent text-white" : "border-neutral-300 bg-white group-hover:border-neutral-400",
                    )}
                  >
                    {selected ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
                  </span>
                </button>
              </span>
            ) : null}
            {member && active ? <MemberMenuButton member={member} className={cn("rounded-full", reveal)} /> : null}
            {isLead ? <LeadBadge compact className="ml-1 mr-1 size-5" /> : null}
          </div>
        ) : null}
      </div>

      {/* Person */}
      <div className="mt-auto flex min-w-0 items-center gap-3">
        <span className="relative shrink-0 max-sm:hidden">
          <Avatar name={entry.name} size="md" ring={active ? true : "muted"} className={isLead ? "ring-2 ring-amber-400" : undefined} />
        </span>
        <div className="min-w-0">
          <p
            title={entry.name}
            className={cn("truncate text-[15px] font-semibold leading-5 tracking-[-0.015em]", active ? "text-neutral-900" : "text-neutral-500")}
          >
            {entry.name}
          </p>
          <p title={designation} className="truncate text-xs leading-4 text-neutral-500">
            {designation}
          </p>
          {isLead && teamName ? <p title={teamName} className="truncate text-xs leading-4 text-neutral-500">{teamName}</p> : null}
        </div>
      </div>

      {/* Context */}
      <div className="mt-3 flex h-6 items-center gap-2 border-t border-neutral-900/[0.06] pt-3 text-xs text-neutral-500 max-sm:mt-2.5 max-sm:pt-2.5">
        <span title={member?.subGroup ?? entry.email} className="min-w-0 truncate">
          {member?.subGroup ?? entry.email}
        </span>
        {member ? (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {!active ? (
              <StateTag tone={member.status === "resigned" ? "red" : "amber"}>{member.status === "resigned" ? "Resigned" : "Unknown"}</StateTag>
            ) : pending ? (
              <span
                title={`Transfer in progress · ${IT_STATUS_LABEL[pending]}`}
                className="inline-flex h-5 items-center gap-1 rounded-full bg-accent-soft pl-1 pr-2 text-[11px] font-medium text-accent-ink ring-1 ring-inset ring-accent-line"
              >
                <ItStatusGlyph status={pending} className="size-3.5" />
                <span className="max-sm:hidden">Moving</span>
              </span>
            ) : (
              <span className="tnum inline-flex items-center gap-1" title={`${member.devices.length} devices`}>
                <Laptop className="size-3.5 text-neutral-400" aria-hidden />
                {member.devices.length}
              </span>
            )}
            <button
              type="button"
              data-testid="member-view-details"
              aria-label={`View details for ${member.name}`}
              onClick={(e) => {
                e.stopPropagation();
                view();
              }}
              onKeyDown={(e) => e.stopPropagation()}
              className="-mr-1.5 inline-flex h-6 items-center gap-0.5 rounded-md pl-1.5 pr-1 text-[12px] font-medium text-neutral-600 outline-none transition-colors hover:bg-accent-soft hover:text-accent-ink focus-visible:ring-2 focus-visible:ring-accent/35"
            >
              <span className="max-[420px]:hidden">View details</span>
              <span className="hidden max-[420px]:inline">Details</span>
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
  return member ? <MemberContextMenu member={member}>{card}</MemberContextMenu> : card;
});

function StateTag({ tone, children }: { tone: "red" | "amber"; children: React.ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-white px-2 text-[11px] font-medium text-neutral-600 ring-1 ring-inset ring-neutral-900/[0.08]">
      <span className={cn("size-1.5 rounded-full", tone === "red" ? "bg-red-500" : "bg-amber-500")} />
      {children}
    </span>
  );
}
