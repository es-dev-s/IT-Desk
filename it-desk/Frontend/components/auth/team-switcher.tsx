"use client";

import { TeamCombobox } from "@/components/teams/team-combobox";
import { useTeams } from "@/store/selectors";
import { useWorkspace } from "@/store/workspace-provider";

/**
 * Admin/IT: choose which team the team-scoped pages show (kept in `?teamId=`).
 * The admin is not on a team, so "All teams" (org-wide) is the default.
 */
export function TeamSwitcher({ className }: { className?: string }) {
  const teams = useTeams();
  const currentTeamId = useWorkspace((s) => s.requestedTeamId ?? s.currentTeamId);
  const switching = useWorkspace((s) => s.switching);
  const memberCount = useWorkspace((s) => s.memberIds.length);
  const selectTeam = useWorkspace((s) => s.selectTeam);
  return (
    <div className={className} aria-busy={switching || undefined}>
      <TeamCombobox
        variant="toolbar"
        size="sm"
        className="w-full"
        label="Team in focus"
        value={currentTeamId}
        extras={[{ value: "", label: "All teams", hint: `Organisation-wide · ${memberCount} people` }]}
        onChange={(id) => void selectTeam(id)}
        teams={teams}
        showLeads
        testId="team-switcher"
      />
    </div>
  );
}
