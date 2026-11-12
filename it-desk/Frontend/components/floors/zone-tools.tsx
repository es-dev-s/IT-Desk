"use client";

import { ArrowRightLeft, Crown, Eraser, Loader2, MousePointerSquareDashed, PaintBucket } from "lucide-react";
import { useMemo, useState } from "react";
import { floorsApi } from "@/lib/api";
import type { Floor } from "@/lib/schemas";
import { NO_TEAM_COLOR } from "@/lib/team-colors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select";
import { TeamCombobox } from "@/components/teams/team-combobox";
import { useOccupancy, useTeamColors, useTeams, useTeamsById } from "@/store/selectors";
import type { ZoneOp } from "./zone-action";
import { RenumberSeats, SeatCodeEditor } from "./seat-codes";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Admin zone editing on a published floor: give the selected seats to a team,
 * take them out of any zone, mark lead desks, or move a team's whole zone
 * (from this or another floor) onto the selection — people can move along.
 * Every change previews first; occupied seats ask what to do with the people.
 */
export function ZoneTools({
  floor,
  floors,
  selection,
  onClear,
  execute,
  busy,
  editNumber = false,
  onNumberDone,
}: {
  floor: Floor;
  floors: readonly Floor[];
  selection: ReadonlySet<string>;
  onClear: () => void;
  execute: (op: ZoneOp) => Promise<void>;
  busy: boolean;
  /** Open the number field straight away (double-click on a seat). */
  editNumber?: boolean;
  onNumberDone?: () => void;
}) {
  const teams = useTeams();
  const byId = useTeamsById();
  const colors = useTeamColors();
  const occ = useOccupancy();
  const [assignTeam, setAssignTeam] = useState("");
  const [moveTeam, setMoveTeam] = useState("");
  const [fromFloor, setFromFloor] = useState("");
  const [carry, setCarry] = useState(true);

  const picked = useMemo(() => floor.elements.filter((e) => e.kind === "seat" && selection.has(e.id)), [floor, selection]);
  const ids = picked.map((e) => e.id);
  const n = picked.length;
  const taken = picked.filter((e) => occ.has(e.id)).length;
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of picked) m.set(e.teamId ?? "", (m.get(e.teamId ?? "") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [picked]);
  const single = groups.length === 1 && groups[0][0] ? groups[0][0] : null;
  const allLead = n > 0 && picked.every((e) => e.leadSeat);
  const name = (id: string) => byId[id]?.name ?? "Unknown team";

  // Where each team has seats, for "move zone".
  const zoneFloors = useMemo(() => {
    const out: Record<string, { id: string; name: string; seats: number }[]> = {};
    for (const f of floors) {
      for (const [teamId, seats] of Object.entries(f.stats.byTeam)) {
        if (!seats) continue;
        (out[teamId] ??= []).push({ id: f.id, name: f.name, seats });
      }
    }
    return out;
  }, [floors]);
  const sources = moveTeam ? (zoneFloors[moveTeam] ?? []) : [];
  const from = sources.find((s) => s.id === fromFloor) ?? [...sources].sort((a, b) => b.seats - a.seats)[0];

  const assign = (teamId: string | null) =>
    execute({
      title: teamId ? `Give ${plural(n, "seat")} to ${name(teamId)}?` : `Take ${plural(n, "seat")} out of their zone?`,
      done: teamId ? `${plural(n, "seat")} on ${floor.name} → ${name(teamId)}` : `${plural(n, "seat")} on ${floor.name} are no longer zoned`,
      run: (o) => floorsApi.assignZone(floor.id, { teamId, seatIds: ids, ...o }),
    });

  const toggleLead = () =>
    single &&
    execute({
      title: allLead ? "Clear the lead desk?" : "Mark as lead desk?",
      done: allLead ? `Lead desk cleared on ${floor.name}` : `Lead desk set on ${floor.name}`,
      run: (o) => floorsApi.assignZone(floor.id, { teamId: single, seatIds: ids, leadSeat: !allLead, ...o }),
    });

  const move = () =>
    moveTeam &&
    from &&
    execute({
      title: `Move ${name(moveTeam)} from ${from.name} to ${floor.name}?`,
      done: `${name(moveTeam)} now sits on ${floor.name}`,
      run: (o) => floorsApi.moveZone({ teamId: moveTeam, fromFloorId: from.id, toSeatIds: ids, carry, ...o }),
    });

  if (n === 0) {
    return (
      <div className="space-y-3 text-[13px] text-neutral-600" data-testid="zone-tools-empty">
        <div className="flex items-center gap-2 text-neutral-900">
          <MousePointerSquareDashed className="size-4 text-accent" aria-hidden />
          <h2 className="text-[15px] font-semibold">Edit zones</h2>
        </div>
        <p>
          Select seats on the plan: click one, Shift-click to add, or drag a box around a block of desks. Click a team in the legend to select its whole area
          here.
        </p>
        <p>Then give them to a team, take them out of a zone, or move a team’s whole zone here from any floor.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="zone-tools">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-neutral-900" data-testid="zone-selection-count">
            {plural(n, "seat")} selected
          </h2>
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </div>
        <p className="text-[12px] text-neutral-500">{taken ? `${taken} taken · ${n - taken} free` : "All free"}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {groups.map(([teamId, count]) => {
            const c = (teamId && colors[teamId]) || NO_TEAM_COLOR;
            return (
              <span
                key={teamId || "none"}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
                style={{ background: c.soft, borderColor: c.line, color: c.ink }}
              >
                <span className="size-1.5 rounded-full" style={{ background: c.fill }} aria-hidden />
                {teamId ? name(teamId) : "No team"} · {count}
              </span>
            );
          })}
        </div>
      </div>

      {n === 1 ? (
        <section className="rounded-xl border border-line bg-neutral-50/60 px-3 py-2.5" data-testid="zone-seat-number">
          <SeatCodeEditor
            key={`${picked[0].id}:${picked[0].code}:${editNumber ? 1 : 0}`}
            floor={floor}
            seat={picked[0]}
            editable
            startEditing={editNumber}
            onDone={onNumberDone}
          />
        </section>
      ) : (
        <RenumberSeats key={ids.join(",")} floor={floor} seats={picked} />
      )}

      <section className="space-y-2 border-t border-line pt-4">
        <h3 className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-neutral-500">
          <PaintBucket className="size-3.5" aria-hidden /> Give to a team{" "}
          <span className="font-normal normal-case tracking-normal text-neutral-400">· optional</span>
        </h3>
        <TeamCombobox
          teams={teams}
          value={assignTeam}
          onChange={setAssignTeam}
          label="Team for the selected seats"
          placeholder="Choose a team"
          testId="zone-team"
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={!assignTeam || busy} onClick={() => void assign(assignTeam)} data-testid="zone-assign">
            {busy ? <Loader2 className="animate-spin" /> : null}
            Assign {plural(n, "seat")}
          </Button>
          <Button size="sm" disabled={busy || groups.every(([t]) => !t)} onClick={() => void assign(null)} data-testid="zone-unassign">
            <Eraser /> Unassign
          </Button>
          <Button
            size="sm"
            disabled={busy || !single}
            onClick={() => void toggleLead()}
            data-testid="zone-lead"
            title={single ? undefined : "Select seats of one team"}
          >
            <Crown /> {allLead ? "Clear lead desk" : "Lead desk"}
          </Button>
        </div>
      </section>

      <section className="space-y-2 border-t border-line pt-4">
        <h3 className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-neutral-500">
          <ArrowRightLeft className="size-3.5" aria-hidden /> Move a team’s zone here
        </h3>
        <TeamCombobox
          teams={teams.filter((t) => zoneFloors[t.id]?.length)}
          value={moveTeam}
          onChange={(v) => {
            setMoveTeam(v);
            setFromFloor("");
          }}
          label="Team to move"
          placeholder="Choose a team with a zone"
          meta={(t) => <span className="text-[11px] text-neutral-400">{(zoneFloors[t.id] ?? []).map((f) => f.name).join(", ")}</span>}
          testId="zone-move-team"
        />
        {moveTeam && sources.length > 1 ? (
          <SelectField
            label="From floor"
            prefix="From"
            value={from?.id ?? ""}
            onValueChange={setFromFloor}
            options={sources.map((s) => ({ value: s.id, label: `${s.name} (${s.seats})` }))}
            className="w-full"
          />
        ) : moveTeam && from ? (
          <p className="text-[12px] text-neutral-500">
            From {from.name} ({plural(from.seats, "seat")})
          </p>
        ) : null}
        <label className="flex items-center gap-2 text-[13px] text-neutral-700">
          <Checkbox checked={carry} onCheckedChange={setCarry} label="Move the team’s people along" />
          Move the team’s people along
        </label>
        {moveTeam && from && carry && from.seats > n ? (
          <p className="text-[12px] text-amber-700">
            {name(moveTeam)} has {from.seats} seats there but you picked {n}; anyone who doesn’t fit is unseated (you’ll see who first).
          </p>
        ) : null}
        <Button variant="primary" size="sm" disabled={!moveTeam || !from || busy} onClick={() => void move()} data-testid="zone-move">
          {busy ? <Loader2 className="animate-spin" /> : null}
          Move zone to these {plural(n, "seat")}
        </Button>
      </section>
    </div>
  );
}
