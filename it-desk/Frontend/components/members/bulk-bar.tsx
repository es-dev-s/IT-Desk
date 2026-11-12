"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { ArrowLeftRight, CircleHelp, Ellipsis, UserX, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { menuContentClass, menuItemClass, menuItemDangerClass } from "@/components/ui/menu";
import { useUI } from "@/store/ui-store";
import { Button } from "@/components/ui/button";
import { useSession } from "@/components/auth/session-provider";

/** Floating, fixed-position bar: appearing never shifts page content. */
export function BulkBar({ ids }: { ids: string[] }) {
  const openTransfer = useUI((s) => s.openTransfer);
  const openExit = useUI((s) => s.openExit);
  const clear = useUI((s) => s.clearSelection);
  const { can } = useSession();
  const canMove = can("transfers.create");
  const canExit = can("exits.create");
  if (ids.length === 0 || !(canMove || canExit)) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4 lg:pl-60">
      <div
        role="toolbar"
        aria-label="Selection actions"
        className="pointer-events-auto flex animate-pop-in items-center gap-1 rounded-xl border border-line bg-white p-1.5 shadow-overlay"
      >
        <span className="tnum px-2.5 text-[13px] font-medium text-neutral-900">{ids.length} selected</span>
        <span className="mx-1 h-5 w-px bg-line" />
        {canMove ? (
          <Button size="sm" variant="primary" onClick={() => openTransfer(ids)}>
            <ArrowLeftRight aria-hidden />
            Transfer
          </Button>
        ) : null}
        {canExit ? (
          <>
            <Button size="sm" variant="ghost" className="hidden sm:inline-flex" onClick={() => openExit("resigned", ids)}>
              Resigned
            </Button>
            <Button size="sm" variant="ghost" className="hidden sm:inline-flex" onClick={() => openExit("unknown", ids)}>
              Unknown
            </Button>
          </>
        ) : null}
        {/* Phones: exits live one tap away instead of crowding the bar. */}
        {canExit ? (
        <DM.Root modal={false}>
          <DM.Trigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="More actions" className="sm:hidden">
              <Ellipsis aria-hidden />
            </Button>
          </DM.Trigger>
          <DM.Portal>
            <DM.Content side="top" align="end" sideOffset={8} collisionPadding={8} className={menuContentClass}>
              <DM.Item onSelect={() => openExit("resigned", ids)} className={cn(menuItemClass, menuItemDangerClass)}>
                <UserX />
                Mark as resigned
              </DM.Item>
              <DM.Item onSelect={() => openExit("unknown", ids)} className={menuItemClass}>
                <CircleHelp />
                Mark as unknown
              </DM.Item>
            </DM.Content>
          </DM.Portal>
        </DM.Root>
        ) : null}
        <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={clear}>
          <X aria-hidden />
        </Button>
      </div>
    </div>
  );
}
