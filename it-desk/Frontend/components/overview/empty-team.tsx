"use client";

import { LayoutGrid, LifeBuoy, Sparkles, UserPlus, UserRoundPlus } from "lucide-react";
import Link from "next/link";
import { useSeatStats } from "@/store/selectors";
import type { Team } from "@/lib/schemas";
import { useRequests } from "@/store/requests-store";
import { useUI } from "@/store/ui-store";
import { useSession } from "@/components/auth/session-provider";
import { Button, buttonClass } from "@/components/ui/button";
import { TeamBadge } from "@/components/teams/team-badge";

/** Shown on the overview while a team has nobody on its roster yet (new teams start empty). */
export function EmptyTeamCard({ team }: { team: Team }) {
  const { session, can } = useSession();
  const openRequest = useRequests((s) => s.openDialog);
  const openMemberDialog = useUI((s) => s.openMemberDialog);
  const canManage = can("members.manage");
  const isAdmin = session.user.role === "admin";
  const needsLead = team.leads.length === 0;
  const zone = useSeatStats(team.id);
  return (
    <section
      aria-label={`${team.name} has no members yet`}
      data-testid="empty-team"
      className="mb-3 overflow-hidden rounded-card border border-line bg-white shadow-xs"
    >
      <div className="flex flex-col gap-5 bg-[radial-gradient(120%_140%_at_0%_0%,var(--color-accent-soft),transparent_60%)] p-5 sm:flex-row sm:items-center sm:p-6">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <TeamBadge code={team.code} size="md" className="mt-0.5" />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[15px] font-semibold tracking-[-0.01em] text-neutral-900">
              {team.name} is ready to go
              <Sparkles className="size-4 text-accent" aria-hidden />
            </p>
            <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-neutral-600">
              No one is on the roster yet{zone.total ? `, so all ${zone.total} seats in the team’s zone are free` : ", and the team has no floor zone yet"}. People appear here once they’re
              added or transferred in, and moves, exits and IT work will fill in the numbers below.
              {isAdmin && needsLead ? " This team doesn’t have a lead yet." : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canManage ? (
            <Button size="sm" variant="primary" onClick={() => openMemberDialog()} data-testid="empty-team-add-member">
              <UserRoundPlus aria-hidden />
              Add a member
            </Button>
          ) : null}
          {isAdmin && needsLead ? (
            <Link href="/teams" className={buttonClass(canManage ? "secondary" : "primary", "sm")}>
              <UserPlus aria-hidden />
              Add a team lead
            </Link>
          ) : null}
          {can("requests.create") ? (
            <Button size="sm" variant={isAdmin || canManage ? "secondary" : "primary"} onClick={() => openRequest()} data-testid="empty-team-request">
              <LifeBuoy aria-hidden />
              Request IT
            </Button>
          ) : null}
          <Link href="/floors" className={buttonClass("secondary", "sm")}>
            <LayoutGrid aria-hidden />
            Floors
          </Link>
        </div>
      </div>
    </section>
  );
}
