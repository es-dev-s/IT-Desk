"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { homeFor } from "@/lib/session";
import { isActivePath, navFor } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { useCurrentTeam, useSeatStats, useTransfers, useUser } from "@/store/selectors";
import { useWorkspace } from "@/store/workspace-provider";
import { useUI } from "@/store/ui-store";
import { useRequests } from "@/store/requests-store";
import { useChat } from "@/store/chat-store";
import { useSession } from "@/components/auth/session-provider";
import { RoleBadge } from "@/components/auth/role-badge";
import { TeamSwitcher } from "@/components/auth/team-switcher";
import { Avatar } from "@/components/ui/avatar";
import { Logo } from "./logo";

export function SidebarContent() {
  const pathname = usePathname();
  const { session, can } = useSession();
  const role = session.user.role;
  const team = useCurrentTeam();
  const user = useUser();
  const floorsCount = useWorkspace((s) => s.floors.length);
  const seatStats = useSeatStats(team?.id ?? "");
  const transfers = useTransfers();
  const pending = transfers.filter((t) => t.itStatus !== "completed").length;
  const requestCounts = useRequests((s) => s.counts);
  // IT: requests nobody has picked up yet. Others: their requests still with IT.
  const requestBadge = requestCounts ? (role === "it" ? requestCounts.unassigned : requestCounts.open + requestCounts.inProgress) : 0;
  const chatUnread = useChat((s) => s.unread?.unread ?? 0);
  const closeMobile = useUI((s) => s.setMobileNavOpen);
  const items = navFor(session.permissions);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center px-5">
        <Link href={homeFor(role)} onClick={() => closeMobile(false)} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/35">
          <Logo />
        </Link>
      </div>

      <div className="px-5 pb-6 pt-4">
        {role === "admin" ? (
          <>
            <p className="text-xs font-medium text-neutral-400">Organisation · viewing</p>
            <TeamSwitcher className="mt-1.5" />
            <p className="mt-1.5 truncate text-xs text-neutral-500">{team ? team.location : `All teams · ${floorsCount} ${floorsCount === 1 ? "floor" : "floors"}`}</p>
          </>
        ) : role === "it" ? (
          <>
            <p className="text-xs font-medium text-neutral-400">Workspace</p>
            <p className="mt-1 truncate text-sm font-medium text-neutral-900">IT operations</p>
            <p className="tnum truncate text-xs text-neutral-500">All teams · {pending} open</p>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-neutral-400">Team</p>
            <p className="mt-1 truncate text-sm font-medium text-neutral-900">{team?.name}</p>
            <p className="truncate text-xs text-neutral-500">{team?.location}</p>
          </>
        )}
      </div>

      <nav aria-label="Main" className="flex-1 px-3">
        <ul className="space-y-0.5">
          {items.map((item) => {
            const active = isActivePath(pathname, item.href);
            const Icon = item.icon;
            const isRequests = item.href === "/requests";
            const isMessages = item.href === "/messages";
            const badge = isRequests ? requestBadge : isMessages ? chatUnread : (item.href === "/transfers" && role !== "it") || item.href === "/queue" ? pending : 0;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => closeMobile(false)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-3 rounded-lg px-2 text-[13px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/35",
                    active ? "bg-accent-soft text-accent-ink" : "text-neutral-600 hover:bg-neutral-900/[0.035] hover:text-neutral-900",
                  )}
                >
                  <Icon className={cn("size-4", active ? "text-accent" : "text-neutral-400")} aria-hidden />
                  {item.label}
                  {badge > 0 ? (
                    <span className="tnum ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-accent-muted px-1.5 text-[11px] font-semibold text-accent-ink" aria-label={isRequests ? `${badge} ${role === "it" ? "unassigned" : "active"} requests` : isMessages ? `${badge} unread ${badge === 1 ? "message" : "messages"}` : `${badge} open device moves`}>
                      {badge}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="space-y-4 border-t border-line p-5">
        {can("floor.view") && seatStats.total > 0 ? (
          <div>
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-neutral-500">{team ? "Zone seats in use" : "Seats in use"}</span>
              <span className="tnum font-medium text-neutral-800">
                {seatStats.used}/{seatStats.total}
              </span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-neutral-900/[0.06]">
              <div className="h-full rounded-full bg-neutral-900" style={{ width: `${(seatStats.used / seatStats.total) * 100}%` }} />
            </div>
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          <Avatar name={user.name} ring size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-neutral-900">{user.name}</p>
            <p className="truncate text-xs text-neutral-500">{user.title || session.roleLabel}</p>
          </div>
          <RoleBadge role={role} />
        </div>
      </div>
    </div>
  );
}
