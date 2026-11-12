"use client";

import * as CM from "@radix-ui/react-context-menu";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Armchair, CircleHelp, Ellipsis, Building2, PanelRightOpen, PencilLine, UserX } from "lucide-react";
import { useMemberDetailLink } from "@/lib/member-detail-link";
import type { Member } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { useUI } from "@/store/ui-store";
import { useSession } from "@/components/auth/session-provider";
import { menuContentClass, menuItemClass, menuItemDangerClass, menuLabelClass, menuSeparatorClass } from "@/components/ui/menu";

type Action = { id: string; label: string; icon: React.ComponentType; danger?: boolean; run: () => void };

/** One action list for both the right-click menu and the ⋯ menu. Acts on the selection when the member is in it. */
function useMemberActions(member: Member) {
  const selected = useUI((s) => s.members.selected);
  const openTransfer = useUI((s) => s.openTransfer);
  const openExit = useUI((s) => s.openExit);
  const openMemberDialog = useUI((s) => s.openMemberDialog);
  const { can } = useSession();
  const { open: openDetail } = useMemberDetailLink();
  const active = member.status === "active";
  const selectedIds = Object.keys(selected);
  const ids = selected[member.id] && selectedIds.length > 1 ? selectedIds : [member.id];
  const heading = ids.length > 1 ? `${ids.length} selected` : member.name;
  const edits: Action[] =
    can("members.manage") && ids.length === 1
      ? [{ id: "edit", label: "Edit details", icon: PencilLine, run: () => openMemberDialog(member.id) }]
      : [];
  const moves: Action[] = active && can("transfers.create")
    ? [
        { id: "seat", label: "Move to another seat", icon: Armchair, run: () => openTransfer(ids, "internal") },
        { id: "team", label: "Transfer to another team", icon: Building2, run: () => openTransfer(ids, "team") },
      ]
    : [];
  const exits: Action[] = active && can("exits.create")
    ? [
        { id: "resigned", label: "Mark as resigned", icon: UserX, danger: true, run: () => openExit("resigned", ids) },
        { id: "unknown", label: "Mark as unknown", icon: CircleHelp, run: () => openExit("unknown", ids) },
      ]
    : [];
  const view: Action[] = [{ id: "view", label: "View details", icon: PanelRightOpen, run: () => openDetail(member.id) }];
  const actions: (Action | "sep")[] = [];
  for (const group of [view, edits, moves, exits]) {
    if (!group.length) continue;
    if (actions.length) actions.push("sep");
    actions.push(...group);
  }
  const disabled = actions.length === 0;
  return { actions, heading, disabled };
}

export function MemberContextMenu({ member, children }: { member: Member; children: React.ReactNode }) {
  const { actions, heading, disabled } = useMemberActions(member);
  return (
    <CM.Root>
      <CM.Trigger asChild disabled={disabled}>
        {children}
      </CM.Trigger>
      <CM.Portal>
        <CM.Content className={menuContentClass} collisionPadding={8}>
          <CM.Label className={menuLabelClass}>{heading}</CM.Label>
          {actions.map((a, i) =>
            a === "sep" ? (
              <CM.Separator key={i} className={menuSeparatorClass} />
            ) : (
              <CM.Item key={a.id} onSelect={a.run} className={cn(menuItemClass, a.danger && menuItemDangerClass)}>
                <a.icon />
                {a.label}
              </CM.Item>
            ),
          )}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

export function MemberMenuButton({ member, className }: { member: Member; className?: string }) {
  const { actions, heading, disabled } = useMemberActions(member);
  if (disabled) return null;
  return (
    <DM.Root modal={false}>
      <DM.Trigger
        aria-label={`Actions for ${member.name}`}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "grid size-7 place-items-center rounded-md text-neutral-400 outline-none transition-[background-color,color,opacity] duration-150 hover:bg-neutral-900/[0.05] hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-accent/35 data-[state=open]:bg-neutral-900/[0.05] data-[state=open]:text-neutral-800 data-[state=open]:opacity-100",
          className,
        )}
      >
        <Ellipsis className="size-4" aria-hidden />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={4} collisionPadding={8} className={menuContentClass} onClick={(e) => e.stopPropagation()}>
          <DM.Label className={menuLabelClass}>{heading}</DM.Label>
          {actions.map((a, i) =>
            a === "sep" ? (
              <DM.Separator key={i} className={menuSeparatorClass} />
            ) : (
              <DM.Item key={a.id} onSelect={a.run} className={cn(menuItemClass, a.danger && menuItemDangerClass)}>
                <a.icon />
                {a.label}
              </DM.Item>
            ),
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
