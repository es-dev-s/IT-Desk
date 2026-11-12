"use client";

import { Suspense, useEffect } from "react";
import { useUI } from "@/store/ui-store";
import { useRequests } from "@/store/requests-store";
import { useSession } from "@/components/auth/session-provider";
import { Sheet } from "@/components/ui/sheet";
import { ExitDialog } from "@/components/members/exit-dialog";
import { TransferDetailSheet } from "@/components/transfers/transfer-detail-sheet";
import { TransferSheet } from "@/components/transfer/transfer-sheet";
import { MemberDialog } from "@/components/members/member-dialog";
import { MemberDetailSheet } from "@/components/members/member-detail-sheet";
import { RequestDetailSheet } from "@/components/requests/request-detail-sheet";
import { RequestDialog } from "@/components/requests/request-dialog";
import { RequestsSync } from "@/components/requests/requests-sync";
import { ChatUnreadSync } from "@/components/messages/chat-unread-sync";
import { RealtimeSync } from "@/components/realtime/realtime-sync";
import { CommandPalette } from "./command-palette";
import { Footer } from "./footer";
import { SidebarContent } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const mobileNavOpen = useUI((s) => s.mobileNavOpen);
  const setMobileNavOpen = useUI((s) => s.setMobileNavOpen);
  const { can } = useSession();
  const canRequest = can("requests.create");
  const canSeeRequests = can("requests.view");
  const canChat = can("requests.comment");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const ui = useUI.getState();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      // "R" opens Request IT — only with no modifiers, outside text fields and when nothing modal is open.
      if (!canRequest || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "r") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      e.preventDefault();
      useRequests.getState().openDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canRequest]);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="fixed left-4 top-3 z-[90] -translate-y-16 rounded-lg bg-neutral-900 px-3 py-2 text-[13px] font-medium text-white focus:translate-y-0"
      >
        Skip to content
      </a>
      <aside className="hidden w-60 shrink-0 border-r border-line bg-sidebar lg:block">
        <div className="sticky top-0 h-dvh">
          <SidebarContent />
        </div>
      </aside>
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen} side="left" title="Navigation" header={<span />} className="bg-sidebar">
        <SidebarContent />
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main id="main" className="flex-1 px-4 pb-16 pt-6 sm:px-6 lg:px-8 2xl:px-12">
          {children}
        </main>
        <Footer />
      </div>

      <CommandPalette />
      <TransferSheet />
      <MemberDialog />
      <Suspense fallback={null}>
        <MemberDetailSheet />
      </Suspense>
      <TransferDetailSheet />
      <ExitDialog />
      <RealtimeSync />
      {canChat ? <ChatUnreadSync /> : null}
      {canSeeRequests ? (
        <>
          <RequestsSync />
          <RequestDetailSheet />
        </>
      ) : null}
      {canRequest ? <RequestDialog /> : null}
    </div>
  );
}
