"use client";

import { LifeBuoy, Menu, Plus, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { getBreadcrumbs } from "@/lib/nav";
import { homeFor } from "@/lib/session";
import { useCurrentTeam } from "@/store/selectors";
import { useSession } from "@/components/auth/session-provider";
import { UserMenu } from "@/components/auth/user-menu";
import { NotificationBell } from "@/components/realtime/notification-bell";
import { useUI } from "@/store/ui-store";
import { useRequests } from "@/store/requests-store";
import { Tip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Breadcrumb } from "./breadcrumb";

export function Topbar() {
  const pathname = usePathname();
  const team = useCurrentTeam();
  const { session, can } = useSession();
  const role = session.user.role;
  const crumbs = getBreadcrumbs(pathname, { role, teamName: team?.name, home: homeFor(role) });
  const setMobileNavOpen = useUI((s) => s.setMobileNavOpen);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const openTransfer = useUI((s) => s.openTransfer);
  const selectedIds = useUI((s) => s.members.selected);
  const openRequest = useRequests((s) => s.openDialog);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white/85 backdrop-blur-xl backdrop-saturate-150">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:px-8 2xl:px-12">
        <Button variant="ghost" size="icon-sm" className="-ml-1.5 lg:hidden" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>
          <Menu aria-hidden />
        </Button>
        <Breadcrumb crumbs={crumbs} className="lg:-ml-1.5" />

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-8 w-64 items-center gap-2 rounded-lg border border-line-strong bg-white pl-2.5 pr-1.5 text-[13px] text-neutral-400 shadow-xs outline-none transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-accent/35 md:flex"
          >
            <Search className="size-4" aria-hidden />
            Search people or tickets
            <Kbd className="ml-auto">⌘K</Kbd>
          </button>
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Search" onClick={() => setPaletteOpen(true)}>
            <Search aria-hidden />
          </Button>
          {can("requests.create") ? (
            <Tip label="Request IT · press R" side="bottom">
              <Button variant="secondary" size="sm" onClick={() => openRequest()} aria-label="Request IT" aria-keyshortcuts="R" data-testid="request-it">
                <LifeBuoy aria-hidden />
                <span className="hidden sm:inline">Request IT</span>
                <Kbd className="ml-0.5 hidden xl:inline-flex">R</Kbd>
              </Button>
            </Tip>
          ) : null}
          {can("transfers.create") ? (
            <Button variant="primary" size="sm" onClick={() => openTransfer(Object.keys(selectedIds))} aria-label="New transfer">
              <Plus aria-hidden />
              <span className="hidden sm:inline">New transfer</span>
            </Button>
          ) : null}
          <NotificationBell />
          <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
