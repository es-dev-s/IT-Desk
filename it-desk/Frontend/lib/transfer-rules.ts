import { occupancy, seatIndex, type SeatRef } from "./floors";
import {
  transferDraftSchema,
  toFieldErrors,
  type FieldErrors,
  type Floor,
  type Member,
  type TransferDraft,
} from "./schemas";

/** The slice of workspace state the rules need. */
export type RulesState = {
  currentTeamId: string;
  teams: Record<string, unknown>;
  members: Record<string, Member>;
  memberIds: string[];
  floors: Floor[];
};

/** Seat ids taken on the published floors, optionally ignoring members who are moving. */
export function occupiedSeats(state: RulesState, excludeIds: ReadonlySet<string> = new Set()) {
  const taken = new Set<string>();
  for (const [seatId, o] of occupancy(state.floors, state.members, state.memberIds)) {
    if (o.memberId && excludeIds.has(o.memberId)) continue;
    taken.add(seatId);
  }
  return taken;
}

/** Seats in a team's zone, in floor then code order. */
export function zoneSeats(state: Pick<RulesState, "floors">, teamId: string): SeatRef[] {
  return [...seatIndex(state.floors).values()].filter((s) => s.teamId === teamId);
}

/** Free seats in a team's zone. */
export function freeZoneSeats(state: RulesState, teamId: string, excludeIds?: ReadonlySet<string>) {
  const taken = occupiedSeats(state, excludeIds);
  return zoneSeats(state, teamId).filter((s) => !taken.has(s.id));
}

/**
 * One source of truth for transfer validity. Used by the form (for inline
 * errors) and again inside the store's set() against the latest state, so a
 * stale form can never double-book a seat or move someone twice. A seat must
 * be on a published floor, inside the destination team's zone, and free.
 */
export function validateTransfer(state: RulesState, draft: TransferDraft): FieldErrors {
  const parsed = transferDraftSchema.safeParse(draft);
  const errors: FieldErrors = parsed.success ? {} : toFieldErrors(parsed.error);
  const set = (key: string, message: string) => {
    if (!errors[key]) errors[key] = message;
  };

  const dest = draft.mode === "internal" ? state.currentTeamId : draft.toTeamId;
  if (draft.mode === "team") {
    if (!state.teams[draft.toTeamId]) set("toTeamId", "Choose a destination team");
    else if (draft.toTeamId === state.currentTeamId) set("toTeamId", "Choose a different team");
  }

  const seats = seatIndex(state.floors);
  const movingIds = new Set(draft.assignments.map((a) => a.memberId));
  const occupied = occupiedSeats(state, draft.mode === "internal" ? movingIds : undefined);
  const claimed = new Set<string>();

  draft.assignments.forEach((a, i) => {
    const m = state.members[a.memberId];
    const key = `assignments.${i}.toSeat`;
    if (!m || m.teamId !== state.currentTeamId || m.status !== "active") {
      set(`assignments.${i}.memberId`, `${m?.name ?? "This member"} is no longer active on your team`);
      return;
    }
    if (!a.toSeatId) return set(key, "Pick a seat");
    const seat = seats.get(a.toSeatId);
    if (!seat) return set(key, "That seat is no longer on a published floor");
    if (seat.teamId !== dest) return set(key, `Seat ${seat.code} is outside the destination team's zone`);
    if (draft.mode === "internal" && seat.id === m.seatId) return set(key, "Already sits here");
    if (occupied.has(seat.id)) return set(key, `Seat ${seat.code} is taken`);
    if (claimed.has(seat.id)) return set(key, `Seat ${seat.code} is assigned twice`);
    claimed.add(seat.id);
  });

  if (new Set(draft.assignments.map((a) => a.memberId)).size !== draft.assignments.length) {
    set("assignments", "A member is listed twice");
  }
  return errors;
}

/** Fill empty seat assignments with the first free seats in the destination team's zone. */
export function autoAssign(state: RulesState, draft: Pick<TransferDraft, "mode" | "toTeamId" | "assignments">) {
  const dest = draft.mode === "internal" ? state.currentTeamId : draft.toTeamId;
  const movingIds = new Set(draft.assignments.map((a) => a.memberId));
  const occupied = occupiedSeats(state, draft.mode === "internal" ? movingIds : undefined);
  const used = new Set(draft.assignments.map((a) => a.toSeatId).filter(Boolean));
  const current = new Map(draft.assignments.map((a) => [a.memberId, state.members[a.memberId]?.seatId ?? null]));
  // Prefer genuinely empty desks; a mover's current desk is only used as a last resort.
  const vacating = new Set([...current.values()].filter(Boolean));
  const free = zoneSeats(state, dest)
    .filter((s) => !occupied.has(s.id) && !used.has(s.id))
    .sort((a, b) => Number(vacating.has(a.id)) - Number(vacating.has(b.id)));
  return draft.assignments.map((a) => {
    if (a.toSeatId) return a;
    const idx = free.findIndex((s) => draft.mode !== "internal" || s.id !== current.get(a.memberId));
    if (idx === -1) return a;
    const [seat] = free.splice(idx, 1);
    return { ...a, toSeatId: seat.id };
  });
}
