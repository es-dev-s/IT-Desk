"use client";

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { computeOverview } from "@/lib/analytics";
import { nowMs } from "@/lib/clock";
import { compareSeats } from "@/lib/constants";
import { occupancy, seatIndex } from "@/lib/floors";
import type { Member, Transfer } from "@/lib/schemas";
import { teamColorMap } from "@/lib/team-colors";
import { useWorkspace } from "./workspace-provider";

export const useUser = () => useWorkspace((s) => s.user);
export const useCurrentTeam = () => useWorkspace((s) => s.teams[s.currentTeamId]);
export const useTeamsById = () => useWorkspace((s) => s.teams);
export const useTeams = () => {
  const ids = useWorkspace(useShallow((s) => s.teamIds));
  const byId = useTeamsById();
  return useMemo(() => ids.map((id) => byId[id]), [ids, byId]);
};

/** Everyone on the team in focus (active or not); the whole organisation in the admin's "All teams" view. */
export function useTeamMembers(): Member[] {
  const members = useWorkspace(
    useShallow((s) =>
      s.memberIds.map((id) => s.members[id]).filter((m) => s.currentTeamId === "" || m.teamId === s.currentTeamId),
    ),
  );
  return members;
}

export function useActiveMembers(): Member[] {
  const members = useTeamMembers();
  return useMemo(
    () => members.filter((m) => m.status === "active").sort((a, b) => compareSeats(a.seat, b.seat)),
    [members],
  );
}

export function useTransfers(): Transfer[] {
  return useWorkspace(useShallow((s) => s.transferIds.map((id) => s.transfers[id])));
}

export function useOverview() {
  const transfers = useTransfers();
  const teamId = useWorkspace((s) => s.currentTeamId);
  // Re-anchored on every successful sync, so "this week" rolls over without a reload.
  const syncedAt = useWorkspace((s) => s.lastSyncedAt);
  return useMemo(() => computeOverview(transfers, teamId, nowMs()), [transfers, teamId, syncedAt]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const useFloors = () => useWorkspace((s) => s.floors);
/** Floor layouts are read-only: hide the builder, New floor and Duplicate. */
export const useFloorLayoutLocked = () => useWorkspace((s) => s.floorLayoutLocked);

/** Seat id → seat (code, floor, zone) across the published floors. */
export function useSeatIndex() {
  const floors = useFloors();
  return useMemo(() => seatIndex(floors), [floors]);
}

/** Seat id → who sits there (server occupancy overlaid with local, optimistic members). */
export function useOccupancy() {
  const floors = useFloors();
  const members = useWorkspace((s) => s.members);
  const ids = useWorkspace((s) => s.memberIds);
  return useMemo(() => occupancy(floors, members, ids), [floors, members, ids]);
}

/** Stable 24-colour palette by directory order. */
export function useTeamColors() {
  const ids = useWorkspace(useShallow((s) => s.teamIds));
  return useMemo(() => teamColorMap(ids), [ids]);
}

/** Seats in a team's zone and how many are taken ("" = every seat on every floor). */
export function useSeatStats(teamId: string) {
  const index = useSeatIndex();
  const occ = useOccupancy();
  return useMemo(() => {
    let total = 0;
    let used = 0;
    for (const seat of index.values()) {
      if (teamId && seat.teamId !== teamId) continue;
      total++;
      const o = occ.get(seat.id);
      if (o && (!teamId || o.teamId === teamId || seat.teamId === teamId)) used++;
    }
    return { total, used };
  }, [index, occ, teamId]);
}
