"use client";

import { MapPinned } from "lucide-react";
import { ScrollTabs } from "@/components/ui/scroll-tabs";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { occupancy, type SeatHolder } from "@/lib/floors";
import type { FloorElement } from "@/lib/schemas";
import type { RulesState } from "@/lib/transfer-rules";
import { cn } from "@/lib/utils";
import { useTeamColors } from "@/store/selectors";
import { FloorCanvas, type FloorCanvasHandle, type SeatTone } from "@/components/floors/floor-canvas";
import { SeatLegend, type SeatLegendItem } from "@/components/floors/seat-legend";

export type Mover = { id: string; name: string; hue: number; seatId: string | null; isLead?: boolean };

/**
 * Seat picking on the real floor plans (the same renderer as the Floors
 * page). Shows the floors that hold the destination team's zone as tabs; seats
 * outside that zone or already taken are disabled. With `anyZone` (admin),
 * every free seat on every floor is pickable.
 */
export function SeatPicker({
  rules,
  destId,
  anyZone = false,
  claimNoZone = false,
  internal,
  movers,
  seats,
  activeId,
  onPick,
  height = "min(46dvh, 420px)",
  colorByTeam = false,
}: {
  rules: RulesState;
  destId: string;
  anyZone?: boolean;
  /** Team lead adding/editing a member: free seats with no zone are pickable and join destId's zone on save. */
  claimNoZone?: boolean;
  /** Movers' current seats count as free (they're vacating them). */
  internal: boolean;
  movers: Mover[];
  /** memberId → chosen seat id. */
  seats: Record<string, string>;
  activeId: string | null;
  onPick: (seatId: string) => void;
  height?: string;
  /** Add-member picker: occupied seats are green for destId's team and red for other teams. */
  colorByTeam?: boolean;
}) {
  const colors = useTeamColors();
  const teamName = (id: string) => (rules.teams[id] as { name?: string } | undefined)?.name ?? "Another team";
  const moving = useMemo(() => new Set(movers.map((m) => m.id)), [movers]);
  const occ = useMemo(() => occupancy(rules.floors, rules.members, rules.memberIds), [rules.floors, rules.members, rules.memberIds]);
  const owner = useMemo(() => {
    const out = new Map<string, Mover>();
    for (const m of movers) {
      const s = seats[m.id];
      if (s && !out.has(s)) out.set(s, m);
    }
    return out;
  }, [movers, seats]);
  const active = movers.find((m) => m.id === activeId) ?? null;

  const candidates = useMemo(
    () => rules.floors.filter((f) => f.elements.some((e) => e.kind === "seat" && (anyZone || e.teamId === destId || (claimNoZone && !e.teamId)))),
    [rules.floors, anyZone, destId, claimNoZone],
  );
  const chosenFloor = (() => {
    const s = active ? seats[active.id] : undefined;
    return s ? candidates.find((f) => f.elements.some((e) => e.id === s))?.id : undefined;
  })();
  const [tab, setTab] = useState<string | null>(null);
  const floor = candidates.find((f) => f.id === (tab ?? chosenFloor)) ?? candidates[0];
  const canvas = useRef<FloorCanvasHandle>(null);

  if (!floor) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed border-line-strong px-4 py-4 text-[13px] text-neutral-600" data-testid="seat-picker-empty">
        <MapPinned className="mt-0.5 size-4 shrink-0 text-neutral-400" aria-hidden />
        <p>
          {destId ? `${teamName(destId)} has no seats on a published floor yet.` : "There are no published floors yet."} An admin can
          add a team zone on{" "}
          <Link href="/floors" className="font-medium text-accent-ink underline-offset-2 hover:underline">
            Floors
          </Link>
          .
        </p>
      </div>
    );
  }

  /** Who the picker shows on a seat. */
  const holder = (seatId: string): SeatHolder | undefined => {
    const m = owner.get(seatId);
    if (m) return { memberId: m.id, name: m.name, teamId: destId || rules.currentTeamId, isLead: Boolean(m.isLead), devices: 0, hue: m.hue, redacted: false };
    const o = occ.get(seatId);
    // Internal moves free up the movers' current desks.
    if (o && internal && o.memberId && moving.has(o.memberId)) return undefined;
    return o;
  };
  const tone = (s: FloorElement): SeatTone => {
    if (owner.has(s.id)) return "target";
    if (active && active.seatId === s.id) return "current";
    if (!anyZone && s.teamId !== destId && !(claimNoZone && !s.teamId)) return "disabled";
    const o = occ.get(s.id);
    if (o && !(internal && o.memberId && moving.has(o.memberId))) return "disabled";
    return active ? "default" : "disabled";
  };
  const selected = active && seats[active.id] ? new Set([seats[active.id]]) : undefined;
  const claimSeat =
    claimNoZone && !anyZone && active && seats[active.id]
      ? rules.floors.some((f) => f.elements.some((e) => e.id === seats[active.id] && e.kind === "seat" && !e.teamId))
      : false;
  const freeOn = (fid: string) => {
    const f = rules.floors.find((x) => x.id === fid);
    if (!f) return 0;
    return f.elements.filter((e) => e.kind === "seat" && (anyZone || e.teamId === destId || (claimNoZone && !e.teamId)) && tone(e) === "default").length;
  };

  /**
   * Legend for the states actually on this floor, each swatch fed the same
   * inputs the canvas gives `seatLook` for a representative seat.
   */
  const legendItems = (): SeatLegendItem[] => {
    const found = new Map<string, SeatLegendItem>();
    const add = (it: SeatLegendItem, prefer = false) => {
      if (prefer || !found.has(it.key)) found.set(it.key, it);
    };
    for (const e of floor.elements) {
      if (e.kind !== "seat") continue;
      const t = tone(e);
      const o = holder(e.id);
      const zoned = Boolean(e.teamId);
      const color = (e.teamId && colors[e.teamId]) || undefined;
      const outOfFocus = !anyZone && e.teamId !== destId;
      if (t === "target") add({ key: "chosen", label: "Selected", color, zoned, occupied: Boolean(o), tone: t });
      if (t === "target" && active?.seatId === e.id) add({ key: "current", label: "Current desk", color, zoned, occupied: Boolean(o), tone: t, now: true });
      else if (t === "current") add({ key: "current", label: "Current desk", color, zoned, occupied: Boolean(o), tone: t, now: true });
      else if (o && colorByTeam && destId) {
        const own = o.teamId === destId;
        add({ key: own ? "own" : "taken", label: own ? "Occupied · your team" : "Occupied · other team", color, zoned, occupied: true, tone: t, outOfFocus, relation: own ? "own" : "other" });
      } else if (o) add({ key: "taken", label: "Occupied", color, zoned, occupied: true, tone: t, outOfFocus }, e.teamId === destId);
      else if (t === "default") add({ key: "free", label: "Available", color, zoned, tone: t, outOfFocus }, e.teamId === destId);
      else if (outOfFocus) add(zoned ? { key: "other", label: "Other team", color, zoned, tone: t, outOfFocus } : { key: "unavailable", label: "Not available", zoned, tone: t, outOfFocus });
      else add({ key: "unavailable", label: "Not available", color, zoned, tone: t, outOfFocus });
      if (Boolean(o?.isLead) || e.leadSeat) add({ key: "lead", label: "Team lead desk", zoned: false, lead: true });
    }
    const order = ["free", "chosen", "current", "own", "taken", "other", "unavailable", "lead"];
    return order.flatMap((k) => (found.has(k) ? [found.get(k)!] : []));
  };

  return (
    <div className="space-y-2" data-testid="seat-picker">
      {candidates.length > 1 ? (
        <ScrollTabs
          label="Floors"
          active={floor.id}
          onChange={setTab}
          tabs={candidates.map((f) => ({
            id: f.id,
            label: (
              <>
                {f.name}
                <span className={cn("tnum text-[11px]", f.id === floor.id ? "text-neutral-500" : "text-neutral-400")}>{freeOn(f.id)} free</span>
              </>
            ),
          }))}
        />
      ) : (
        <p className="text-xs font-medium text-neutral-500">{floor.name}</p>
      )}
      <FloorCanvas
        ref={canvas}
        key={floor.id}
        label={`Choose a seat on ${floor.name}`}
        cols={floor.cols}
        rows={floor.rows}
        elements={floor.elements}
        colors={colors}
        teamName={teamName}
        occupant={holder}
        selected={selected}
        focusTeamId={anyZone ? null : destId}
        ownTeamId={colorByTeam ? destId || null : null}
        tone={tone}
        nowSeatId={active?.seatId || undefined}
        mode="pick"
        maxHeight={height}
        testId="seat-picker-canvas"
        onSeatClick={(s) => {
          const t = tone(s);
          if (t === "disabled" || t === "current") return;
          onPick(s.id);
        }}
      />
      {claimSeat ? (
        <p className="text-xs text-neutral-600" data-testid="seat-claim-hint">
          This desk isn&apos;t assigned to a team yet — it&apos;ll join {teamName(destId)} when you save.
        </p>
      ) : null}
      <SeatLegend items={legendItems()} testId="seat-picker-legend" />
    </div>
  );
}

