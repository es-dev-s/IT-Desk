"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { KeyRound, LogOut, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { menuContentClass, menuItemClass, menuSeparatorClass } from "@/components/ui/menu";
import { Avatar } from "@/components/ui/avatar";
import { useSession } from "./session-provider";
import { RoleBadge } from "./role-badge";

export function UserMenu() {
  const router = useRouter();
  const { session, signOut, signingOut } = useSession();
  const { user } = session;

  const onSignOut = async () => {
    try {
      await signOut();
    } catch {
      toast.error("Couldn’t sign out", { description: "Check your connection and try again." });
    }
  };

  return (
    <DM.Root modal={false}>
      <DM.Trigger
        aria-label={`Account: ${user.name}`}
        data-testid="user-menu"
        className="grid size-8 place-items-center rounded-full outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-accent/35 data-[state=open]:ring-2 data-[state=open]:ring-accent/25"
      >
        <Avatar name={user.name} ring size="sm" />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={8} collisionPadding={8} className={`${menuContentClass} w-64`}>
          <div className="flex items-start gap-3 px-2 pb-2.5 pt-2">
            <Avatar name={user.name} ring size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-neutral-900">{user.name}</p>
              <p className="truncate text-xs text-neutral-500">{user.email}</p>
              <RoleBadge role={user.role} className="mt-1.5" />
            </div>
          </div>
          <DM.Separator className={menuSeparatorClass} />
          <DM.Item className={menuItemClass} onSelect={() => router.push("/settings")}>
            <Settings />
            Settings
          </DM.Item>
          <DM.Item className={menuItemClass} onSelect={() => router.push("/change-password")}>
            <KeyRound />
            Change password
          </DM.Item>
          <DM.Separator className={menuSeparatorClass} />
          <DM.Item className={menuItemClass} disabled={signingOut} onSelect={() => void onSignOut()} data-testid="sign-out">
            <LogOut />
            {signingOut ? "Signing out…" : "Sign out"}
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
