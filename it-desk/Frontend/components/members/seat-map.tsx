"use client";

import { MapPinned } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Member } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { useFloors, useOccupancy, useTeamColors, useTeamsById } from "@/store/selectors";
import { FloorCanvas } from "@/components/floors/floor-canvas";

/**
 * Floor view of the people list, on the real floor plans. Shows the floors
 * holding the team's zone (every floor in the organisation-wide view). Filters
 * dim seats instead of removing them, so nothing ever moves; clicking a person
 * selects them for a transfer or exit.
 */
export function SeatMap({
  teamId,
  members,
  matches,
  selected,
  onToggle,
}: {
  teamId: string;
  members: Member[];
  matches: Set<string>;
  selected: Record<string, true>;
  onToggle: (id: string) => void;
}) {
  const floors = useFloors();
  const teams = useTeamsById();
  const colors = useTeamColors();
  const occ = useOccupancy();
  const teamName = (id: string) => teams[id]?.name ?? "Another team";
  const mine = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const relevant = useMemo(
    () =>
      teamId
        ? floors.filter((f) => f.elements.some((e) => e.kind === "seat" && (e.teamId === teamId || (occ.get(e.id)?.memberId && mine.has(occ.get(e.id)!.memberId)))))
        : floors,
    [floors, teamId, occ, mine],
  );
  const [tab, setTab] = useState<string | null>(null);
  const floor = relevant.find((f) => f.id === tab) ?? relevant[0];

  const highlight = useMemo(() => {
    if (!floor || matches.size === members.length) return null;
    const out = new Set<string>();
    for (const e of floor.elements) {
      const o = occ.get(e.id);
      if (o?.memberId && matches.has(o.memberId)) out.add(e.id);
    }
    return out;
  }, [floor, occ, matches, members.length]);
  const selectedSeats = useMemo(() => new Set(members.filter((m) => selected[m.id] && m.seatId).map((m) => m.seatId as string)), [members, selected]);

  const unseated = members.filter((m) => !m.seatId).length;

  if (!floor) {
    return (
      <div className="flex items-start gap-3 rounded-card border border-line bg-white px-5 py-6 text-[13px] text-neutral-600 shadow-xs" data-testid="seat-map-empty">
        <MapPinned className="mt-0.5 size-4 shrink-0 text-neutral-400" aria-hidden />
        <p>
          {teamId ? `${teamName(teamId)} has no zone on a published floor yet.` : "No floors are published yet."}{" "}
          <Link href="/floors" className="font-medium text-accent-ink underline-offset-2 hover:underline">
            Open Floors
          </Link>
        </p>
      </div>
    );
  }

  const seatsHere = floor.elements.filter((e) => e.kind === "seat" && (!teamId || e.teamId === teamId));
  const taken = seatsHere.filter((e) => occ.has(e.id)).length;

  return (
    <div className="space-y-3" data-testid="seat-map">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {relevant.length > 1 ? (
          <div role="tablist" aria-label="Floors" className="scrollbar-thin flex gap-1 overflow-x-auto">
            {relevant.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={f.id === floor.id}
                onClick={() => setTab(f.id)}
                className={cn(
                  "h-8 shrink-0 rounded-lg px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/35",
                  f.id === floor.id ? "bg-neutral-900 text-white" : "bg-white text-neutral-600 ring-1 ring-inset ring-line hover:bg-neutral-50",
                )}
              >
                {f.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[13px] font-medium text-neutral-900">{floor.name}</p>
        )}
        <p className="tnum text-xs text-neutral-500">
          {teamId ? "Zone" : "Floor"}: {taken} taken · {seatsHere.length - taken} free
          {unseated ? ` · ${unseated} without a seat` : ""} ·{" "}
          <Link href={`/floors?floor=${floor.id}`} className="font-medium text-accent-ink hover:underline">
            Open in Floors
          </Link>
        </p>
      </div>
      <FloorCanvas
        key={floor.id}
        label={`Floor plan, ${floor.name}`}
        cols={floor.cols}
        rows={floor.rows}
        elements={floor.elements}
        colors={colors}
        teamName={teamName}
        occupant={(id) => occ.get(id)}
        selected={selectedSeats}
        highlight={highlight}
        focusTeamId={teamId || null}
        mode="view"
        testId="members-floor"
        maxHeight="min(56dvh, 640px)"
        onSeatClick={(s) => {
          const o = occ.get(s.id);
          if (o?.memberId && mine.has(o.memberId)) onToggle(o.memberId);
        }}
      />
    </div>
  );
}
