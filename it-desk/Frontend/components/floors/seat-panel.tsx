"use client";

import { useMemberDetailLink } from "@/lib/member-detail-link";

import { ArrowRightLeft, ChevronRight, Laptop, Loader2, UserMinus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { Floor, FloorElement, Member } from "@/lib/schemas";
import { NO_TEAM_COLOR } from "@/lib/team-colors";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/auth/session-provider";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";
import { useOccupancy, useSeatIndex, useTeamColors, useTeamsById } from "@/store/selectors";
import { LeadBadge } from "./lead-badge";
import { SeatCodeEditor } from "./seat-codes";

/** A person waiting to be put on a seat (the next seat click places them). */
export type MoveState = {
  memberId: string;
  name: string;
  fromSeatId: string;
  place: (seat: FloorElement) => Promise<void>;
};

/**
 * Details for one seat: who sits there (with lead badge and devices) and what
 * this viewer may do — seat someone on a free desk, move or unseat a person.
 * The admin can seat anyone anywhere; a lead only their people in their zone.
 */
export function SeatPanel({
  floor,
  seat,
  onClose,
  canSeat,
  onMove,
  onMoved,
  editNumber = false,
  onNumberDone,
}: {
  floor: Floor;
  seat: FloorElement;
  onClose: () => void;
  canSeat: boolean;
  onMove: (m: MoveState) => void;
  onMoved: () => void;
  /** Open the number field straight away (admin double-clicked the seat). */
  editNumber?: boolean;
  onNumberDone?: () => void;
}) {
  const { session } = useSession();
  const isAdmin = session.user.role === "admin";
  const myTeam = session.user.teamId ?? "";
  const api = useWorkspaceApi();
  const teams = useTeamsById();
  const colors = useTeamColors();
  const occ = useOccupancy();
  const index = useSeatIndex();
  const members = useWorkspace((s) => s.members);
  const memberIds = useWorkspace((s) => s.memberIds);
  const { open: openDetail } = useMemberDetailLink();
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const o = occ.get(seat.id);
  const zoneColor = (seat.teamId && colors[seat.teamId]) || NO_TEAM_COLOR;
  const zoneName = seat.teamId ? (teams[seat.teamId]?.name ?? "Unknown team") : "No team";
  const mayMove = canSeat && Boolean(o?.memberId) && (isAdmin || o?.teamId === myTeam);
  const maySeatHere = canSeat && !o && (isAdmin || (seat.teamId !== null && seat.teamId === myTeam));

  const assign = async (memberId: string, seatId: string | null, label: string) => {
    setBusy(memberId);
    const res = await api.getState().assignSeat(memberId, seatId);
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    toast.success(label);
    return true;
  };

  const startMove = () => {
    if (!o?.memberId) return;
    const id = o.memberId;
    const name = o.name || "This person";
    onMove({
      memberId: id,
      name,
      fromSeatId: seat.id,
      place: async (to) => {
        const ok = await assign(id, to.id, `${name} moved to Seat ${to.code}`);
        if (ok) onMoved();
      },
    });
  };

  const candidates = useMemo(() => {
    if (!maySeatHere) return [] as Member[];
    const t = query.trim().toLowerCase();
    return memberIds
      .map((id) => members[id])
      .filter((m): m is Member => Boolean(m) && m.status === "active" && (isAdmin || m.teamId === myTeam))
      .filter((m) => !t || m.name.toLowerCase().includes(t) || (teams[m.teamId]?.name ?? "").toLowerCase().includes(t))
      .sort(
        (a, b) =>
          Number(Boolean(a.seatId)) - Number(Boolean(b.seatId)) ||
          Number(b.teamId === seat.teamId) - Number(a.teamId === seat.teamId) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 60);
  }, [maySeatHere, query, memberIds, members, isAdmin, myTeam, teams, seat.teamId]);

  return (
    <div className="space-y-4" data-testid="seat-panel" data-seat={seat.code}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <SeatCodeEditor
            key={`${seat.id}:${seat.code}:${editNumber ? 1 : 0}`}
            floor={floor}
            seat={seat}
            editable={isAdmin}
            startEditing={editNumber}
            onDone={onNumberDone}
          />
          <p className="text-[12px] text-neutral-500">{floor.name}</p>
        </div>
        <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close seat details">
          <X />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] font-medium"
          style={{ background: zoneColor.soft, borderColor: zoneColor.line, color: zoneColor.ink }}
          data-testid="seat-zone"
        >
          <span className="size-2 rounded-full" style={{ background: zoneColor.fill }} aria-hidden />
          {zoneName}
        </span>
        {seat.leadSeat ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[12px] font-medium text-amber-800">Lead desk</span> : null}
      </div>

      {o ? (
        <div className={cn("rounded-xl border p-3", o.isLead ? "border-amber-300 bg-amber-50/50" : "border-line")} data-testid="seat-occupant">
          <div className="flex items-center gap-3">
            <span className="relative">
              <Avatar name={o.redacted || !o.name ? "?" : o.name} hue={o.hue} size="md" className={o.isLead ? "ring-2 ring-amber-400" : undefined} />
              {o.isLead ? <LeadBadge compact className="absolute -right-1 -top-1" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-neutral-900">{o.redacted || !o.name ? "Someone from another team" : o.name}</p>
              <p className="truncate text-[12px] text-neutral-500">{teams[o.teamId]?.name ?? "Another team"}</p>
            </div>
            {!o.redacted && o.memberId && members[o.memberId] ? (
              <button
                type="button"
                data-testid="member-view-details"
                onClick={() => {
                  const id = o.memberId;
                  onClose();
                  openDetail(id);
                }}
                className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md pl-2 pr-1 text-[12px] font-medium text-neutral-600 outline-none transition-colors hover:bg-accent-soft hover:text-accent-ink focus-visible:ring-2 focus-visible:ring-accent/35"
              >
                View details
                <ChevronRight className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
            {o.isLead ? <LeadBadge /> : null}
            {!o.redacted ? (
              <span className="inline-flex items-center gap-1">
                <Laptop className="size-3.5" aria-hidden /> {o.devices} {o.devices === 1 ? "device" : "devices"}
              </span>
            ) : null}
            {seat.teamId && o.teamId !== seat.teamId ? <span className="text-amber-700">Outside {teams[o.teamId]?.name ?? "their team"}’s zone</span> : null}
          </div>
          {mayMove ? (
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={startMove} data-testid="seat-move">
                <ArrowRightLeft /> Move
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                data-testid="seat-unseat"
                onClick={() => void assign(o.memberId, null, `${o.name} no longer has a seat`).then((ok) => ok && onClose())}
              >
                {busy ? <Loader2 className="animate-spin" /> : <UserMinus />} Unseat
              </Button>
            </div>
          ) : null}
        </div>
      ) : maySeatHere ? (
        <div data-testid="seat-assign">
          <h3 className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-neutral-500">Seat someone here</h3>
          <SearchField
            value={query}
            onChange={setQuery}
            label="Find a person"
            placeholder={isAdmin ? "Anyone in the organisation" : "Your people"}
            className="mb-2"
          />
          {candidates.length ? (
            <ul className="scrollbar-thin -mx-1 max-h-80 space-y-0.5 overflow-y-auto px-1">
              {candidates.map((m) => {
                const now = m.seatId ? index.get(m.seatId) : undefined;
                const outside = seat.teamId !== null && m.teamId !== seat.teamId;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void assign(m.id, seat.id, `${m.name} is now on Seat ${seat.code}`).then((ok) => ok && onClose())}
                      data-testid="seat-candidate"
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-neutral-50 disabled:opacity-50"
                    >
                      <span className="relative shrink-0">
                        <Avatar name={m.name} hue={m.hue} size="sm" className={m.isLead ? "ring-2 ring-amber-400" : undefined} />
                        {m.isLead ? <LeadBadge compact className="absolute -right-1 -top-1 scale-75" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-neutral-900">{m.name}</span>
                        <span className="block truncate text-[11px] text-neutral-500">
                          {isAdmin ? `${teams[m.teamId]?.name ?? ""} · ` : ""}
                          {now ? `now Seat ${now.code} · ${now.floorName}` : "No seat"}
                          {isAdmin && outside ? " · other zone" : ""}
                        </span>
                      </span>
                      {busy === m.id ? <Loader2 className="size-4 animate-spin text-neutral-400" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[13px] text-neutral-500">{query ? "No one matches." : "No one to seat."}</p>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-neutral-500" data-testid="seat-readonly">
          {!canSeat
            ? "Free seat."
            : seat.teamId
              ? `Free seat in ${zoneName}’s zone. To move someone into another team’s area, use a transfer.`
              : "Free seat outside any zone. Only an admin can seat people here."}
        </p>
      )}
    </div>
  );
}
