"use client";

import { Building2, Crown, DoorOpen, Info, LayoutGrid, MousePointerSquareDashed, PencilRuler, X } from "lucide-react";
import { ScrollTabs } from "@/components/ui/scroll-tabs";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Floor, FloorElement } from "@/lib/schemas";
import { NO_TEAM_COLOR, type TeamColor } from "@/lib/team-colors";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/auth/session-provider";
import { Button, buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { SearchField } from "@/components/ui/search-field";
import { useFloors, useOccupancy, useTeamColors, useTeamsById } from "@/store/selectors";
import { FloorCanvas, type FloorCanvasHandle, type SeatTone } from "./floor-canvas";
import { SeatSwatch, type SeatLegendItem } from "./seat-legend";
import { SeatPanel, type MoveState } from "./seat-panel";
import { ZoneTools } from "./zone-tools";
import { useZoneAction } from "./zone-action";

type Cell = { x: number; y: number };
type Marquee = { a: Cell; b: Cell };

const seatsOf = (f: Floor) => f.elements.filter((e) => e.kind === "seat");

/**
 * The office floors, for everyone. Each team's zone is tinted in its colour,
 * leads wear a crown, and people show on their desks. Leads land on their own
 * zone and can seat their people there; the admin can seat anyone anywhere and,
 * in "Edit zones", re-draw any team's area on any published floor.
 */
export function FloorsView() {
  const { session, can } = useSession();
  const role = session.user.role;
  const myTeam = session.user.teamId ?? "";
  const isAdmin = role === "admin";
  const isLead = role === "team_lead";
  const canSeat = can("seats.assign");
  const canManage = can("floors.manage");

  const floors = useFloors();
  const occ = useOccupancy();
  const teams = useTeamsById();
  const colors = useTeamColors();
  const teamName = useCallback((id: string) => teams[id]?.name ?? "Another team", [teams]);

  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const wanted = params.get("floor");

  // Where to land: the linked floor, else (for a lead) the floor holding most of their zone.
  const landing = useMemo(() => {
    if (wanted && floors.some((f) => f.id === wanted)) return wanted;
    if (isLead && myTeam) {
      let best: Floor | undefined;
      let most = 0;
      for (const f of floors) {
        const n = f.stats.byTeam[myTeam] ?? seatsOf(f).filter((e) => e.teamId === myTeam).length;
        if (n > most) {
          most = n;
          best = f;
        }
      }
      if (best) return best.id;
    }
    return floors[0]?.id ?? "";
  }, [wanted, floors, isLead, myTeam]);

  const [floorId, setFloorId] = useState(landing);
  const [seen, setSeen] = useState(wanted);
  if (wanted !== seen) {
    setSeen(wanted);
    if (wanted && floors.some((f) => f.id === wanted)) setFloorId(wanted);
  }
  const floor = floors.find((f) => f.id === floorId) ?? floors.find((f) => f.id === landing) ?? floors[0];

  const [query, setQuery] = useState("");
  const [focusTeam, setFocusTeam] = useState<string | null>(isLead && myTeam ? myTeam : null);
  const [seatId, setSeatId] = useState<string | null>(null);
  // Seat whose number field opens straight away (admin double-click).
  const [numberFor, setNumberFor] = useState<string | null>(null);
  const [moving, setMoving] = useState<MoveState | null>(null);
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const canvas = useRef<FloorCanvasHandle>(null);
  const panelRef = useRef<HTMLElement>(null);
  const zone = useZoneAction();

  const go = useCallback(
    (id: string) => {
      setFloorId(id);
      setSeatId(null);
      setSel(new Set());
      const next = new URLSearchParams(params.toString());
      next.set("floor", id);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  // ---- search: seat code, person or team, across every floor ----
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const out = new Map<string, Set<string>>();
    if (!q) return out;
    for (const f of floors) {
      const set = new Set<string>();
      for (const e of seatsOf(f)) {
        const o = occ.get(e.id);
        const hit =
          e.code.toLowerCase().includes(q) ||
          (o && !o.redacted && o.name.toLowerCase().includes(q)) ||
          (e.teamId && teamName(e.teamId).toLowerCase().includes(q));
        if (hit) set.add(e.id);
      }
      if (set.size) out.set(f.id, set);
    }
    return out;
  }, [q, floors, occ, teamName]);
  const here = floor ? matches.get(floor.id) : undefined;
  const elsewhere = [...matches.entries()].filter(([id]) => id !== floor?.id);

  // ---- who can sit where (move mode) ----
  const canTarget = useCallback(
    (e: FloorElement) => {
      if (!moving) return false;
      const o = occ.get(e.id);
      if (o) return false;
      if (isAdmin) return true;
      return e.teamId === myTeam;
    },
    [moving, occ, isAdmin, myTeam],
  );
  const tone = useCallback(
    (e: FloorElement): SeatTone => {
      if (moving) {
        if (e.id === moving.fromSeatId) return "current";
        return canTarget(e) ? "default" : "disabled";
      }
      if (seatId === e.id && !editing) return "target";
      return "default";
    },
    [moving, canTarget, seatId, editing],
  );

  const highlight = useMemo(() => {
    if (!floor) return null;
    if (moving)
      return new Set(
        seatsOf(floor)
          .filter((e) => canTarget(e) || e.id === moving.fromSeatId)
          .map((e) => e.id),
      );
    if (q) return here ?? new Set<string>();
    return null;
  }, [floor, moving, canTarget, q, here]);

  // ---- edit zones: click / shift-click / drag-select seats ----
  const byCell = useMemo(() => {
    const m = new Map<string, FloorElement>();
    for (const e of floor ? seatsOf(floor) : []) m.set(`${e.x},${e.y}`, e);
    return m;
  }, [floor]);
  const drag = useRef<{
    start: Cell;
    add: boolean;
    base: Set<string>;
    moved: boolean;
  } | null>(null);
  const inRect = (a: Cell, b: Cell) => {
    const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    return (floor ? seatsOf(floor) : []).filter((e) => e.x >= x0 && e.x <= x1 && e.y >= y0 && e.y <= y1).map((e) => e.id);
  };
  const onDown = (c: Cell, e: React.PointerEvent) => {
    const hit = byCell.get(`${c.x},${c.y}`);
    if (e.detail >= 2 && hit) {
      // Double-click: just this seat, number field open.
      drag.current = null;
      setSel(new Set([hit.id]));
      setNumberFor(hit.id);
      return;
    }
    drag.current = {
      start: c,
      add: e.shiftKey || e.metaKey || e.ctrlKey,
      base: new Set(sel),
      moved: false,
    };
  };
  const onMove = (c: Cell) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && c.x === d.start.x && c.y === d.start.y) return;
    d.moved = true;
    setMarquee({ a: d.start, b: c });
    const next = d.add ? new Set(d.base) : new Set<string>();
    for (const id of inRect(d.start, c)) next.add(id);
    setSel(next);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setMarquee(null);
    if (!d || d.moved) return;
    const hit = byCell.get(`${d.start.x},${d.start.y}`);
    if (!hit) {
      if (!d.add) setSel(new Set());
      return;
    }
    const next = d.add ? new Set(d.base) : new Set<string>();
    if (d.add && next.has(hit.id)) next.delete(hit.id);
    else next.add(hit.id);
    setSel(next);
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (ev.key === "Escape") {
        if (moving) setMoving(null);
        else if (sel.size) setSel(new Set());
        else if (seatId) setSeatId(null);
        else if (editing) setEditing(false);
      } else if (editing && floor && (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        setSel(new Set(seatsOf(floor).map((e) => e.id)));
      } else if (canManage && !ev.metaKey && !ev.ctrlKey && !ev.altKey && ev.key.toLowerCase() === "e") {
        setEditing((v) => !v);
        setSel(new Set());
        setMoving(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moving, sel, seatId, editing, floor, canManage]);

  // When the panel sits under the map, bring it into view once a seat (or a
  // zone selection) needs it — but only if it is mostly off-screen.
  const wantsPanel = seatId ?? (editing && sel.size ? "sel" : null);
  useEffect(() => {
    const el = panelRef.current;
    if (!wantsPanel || !el || window.matchMedia("(min-width: 1800px)").matches) return;
    if (el.getBoundingClientRect().top > window.innerHeight - 160) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [wantsPanel]);

  if (!floor) {
    return (
      <>
        <h1 className="sr-only">Floors</h1>
        <EmptyState
          icon={Building2}
          title="No floors yet"
          description={canManage ? "Create the first floor, then paint each team’s zone on it." : "An admin hasn’t published any floor plans yet."}
          action={
            canManage ? (
              <Link href="/floors/manage" className={buttonClass("primary", "md")}>
                Set up floors
              </Link>
            ) : undefined
          }
        />
      </>
    );
  }

  const seats = seatsOf(floor);
  const used = seats.filter((e) => occ.has(e.id)).length;
  const legend = legendFor(floor, occ);
  const myZone = isLead && myTeam ? zoneSummary(floors, myTeam, occ) : null;
  const selectedSeat = seatId ? seats.find((e) => e.id === seatId) : undefined;

  const onSeatClick = (e: FloorElement, ev: React.MouseEvent | React.KeyboardEvent) => {
    // The second click of a double-click is the number edit, not "close".
    if ("detail" in ev && ev.detail >= 2) return;
    if (moving) {
      if (!canTarget(e)) return;
      void moving.place(e);
      return;
    }
    setSeatId((cur) => (cur === e.id ? null : e.id));
  };

  const toggleEditing = () => {
    setEditing((v) => !v);
    setSel(new Set());
    setMoving(null);
    setSeatId(null);
  };
  const onTeam = (teamId: string) => {
    if (editing) setSel(new Set(seats.filter((e) => e.teamId === teamId).map((e) => e.id)));
    else setFocusTeam((cur) => (cur === teamId ? null : teamId));
  };

  return (
    <>
      <h1 className="sr-only">Floors</h1>
      {zone.dialog}

      {/* One quiet toolbar: floors, search, legend, admin actions */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ScrollTabs
          label="Floors"
          testId="floor-tabs"
          tabTestId="floor-tab"
          className="order-last w-full lg:order-none lg:w-auto lg:flex-1"
          active={floor.id}
          onChange={go}
          tabs={floors.map((f) => {
            const mine = myTeam ? (f.stats.byTeam[myTeam] ?? 0) > 0 : false;
            const n = matches.get(f.id)?.size ?? 0;
            return {
              id: f.id,
              title: `${f.name} · ${f.stats.occupied}/${f.stats.seats} seats taken`,
              data: { floor: f.name },
              label: (
                <>
                  {f.name}
                  {mine ? <span className="size-1.5 rounded-full bg-amber-400" title="Your team sits here" /> : null}
                  {n ? <span className="tnum rounded-full bg-accent px-1.5 text-[10.5px] font-semibold leading-4 text-white">{n}</span> : null}
                </>
              ),
            };
          })}
        />
        <SearchField
          size="md"
          className="min-w-0 flex-1 lg:w-52 lg:flex-none"
          value={query}
          onChange={setQuery}
          label="Find a person, seat or team"
          placeholder="Person, seat number or team"
        />
        <LegendPopover color={(() => {
          const z = floor ? seatsOf(floor).find((e) => e.teamId && colors[e.teamId]) : undefined;
          return z?.teamId ? colors[z.teamId] : undefined;
        })()} moving={Boolean(moving)} />
      </div>

      {q ? (
        <p className="-mt-2 mb-3 text-[12.5px] text-neutral-500" data-testid="floor-search-count">
          {here?.size ?? 0} on {floor.name}
          {elsewhere.map(([id, set]) => (
            <button key={id} type="button" className="ml-2 rounded-md px-1.5 py-0.5 font-medium text-accent-ink hover:bg-accent/10" onClick={() => go(id)}>
              {set.size} on {floors.find((f) => f.id === id)?.name}
            </button>
          ))}
        </p>
      ) : null}

      {myZone ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-neutral-600" data-testid="my-zone">
          <Crown className="size-3.5 text-amber-500" aria-hidden />
          {myZone.total ? (
            <>
              <span>
                <b className="font-medium text-neutral-900">{teamName(myTeam)}</b> · {myZone.total} seats · {myZone.total - myZone.used} free
                {myZone.floors.length ? ` · ${myZone.floors.map((f) => f.name).join(", ")}` : ""}
              </span>
              {!myZone.floors.some((f) => f.id === floor.id) ? (
                <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => go(myZone.floors[0].id)}>
                  Go to your zone
                </button>
              ) : (
                <span className="text-neutral-400">Click a free seat in your zone to seat someone.</span>
              )}
            </>
          ) : (
            <span>Your team has no seats yet. An admin can give {teamName(myTeam)} a zone.</span>
          )}
        </div>
      ) : null}

      {editing ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-neutral-600" data-testid="edit-zones-hint">
          <span className="size-1.5 rounded-full bg-accent" aria-hidden />
          <span>
            <b className="font-medium text-neutral-900">Editing {floor.name}</b> — click, <Kbd>Shift</Kbd>-click or drag to select seats. Changes go live and
            can be undone.
          </span>
          <span className="text-neutral-400">
            <Kbd>⌘A</Kbd> all · <Kbd>Esc</Kbd> clear · <Kbd>E</Kbd> done
          </span>
        </div>
      ) : null}

      {moving ? (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-sky-50 px-3 py-1.5 text-[12.5px] text-sky-900" data-testid="move-hint">
          <span className="flex-1">
            Choose a free seat for <b className="font-medium">{moving.name}</b>
            {isAdmin ? " on any floor." : " in your zone."} <Kbd>Esc</Kbd> cancels.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setMoving(null)}>
            <X /> Cancel
          </Button>
        </div>
      ) : null}

      {/* The map takes the full width (so seats have room for names); the panel
          sits beside it only on very wide screens and under it otherwise. */}
      <div className="grid gap-4 min-[1800px]:grid-cols-[minmax(0,1fr)_300px]">
        <FloorCanvas
          ref={canvas}
          key={floor.id}
          label={floor.name}
          cols={floor.cols}
          rows={floor.rows}
          elements={floor.elements}
          colors={colors}
          teamName={teamName}
          occupant={(id) => occ.get(id)}
          selected={editing ? sel : undefined}
          highlight={highlight}
          focusTeamId={!editing && !moving && !q ? focusTeam : null}
          tone={tone}
          mode={editing ? "edit" : "view"}
          onSeatClick={onSeatClick}
          onSeatDoubleClick={(e) => {
            if (!canManage || moving) return;
            setSeatId(e.id);
            setNumberFor(e.id);
          }}
          onGridPointerDown={onDown}
          onGridPointerMove={onMove}
          onGridPointerUp={onUp}
          overlay={(cs) =>
            marquee ? (
              <div
                className="pointer-events-none absolute rounded-[4px] border border-accent bg-accent/[0.08]"
                style={{
                  left: Math.min(marquee.a.x, marquee.b.x) * cs,
                  top: Math.min(marquee.a.y, marquee.b.y) * cs,
                  width: (Math.abs(marquee.a.x - marquee.b.x) + 1) * cs,
                  height: (Math.abs(marquee.a.y - marquee.b.y) + 1) * cs,
                }}
              />
            ) : null
          }
          testId="floor-view"
          className="min-w-0"
          maxHeight="max(360px, calc(100dvh - 13rem))"
        />

        <aside ref={panelRef} className="min-w-0 scroll-mt-4 min-[1800px]:sticky min-[1800px]:top-4 min-[1800px]:self-start" data-testid="floor-panel">
          <div className="rounded-2xl border border-black/[0.06] bg-white p-4">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-neutral-900">{floor.name}</h2>
              {canManage ? (
                <div className="-mr-1.5 flex items-center gap-0.5">
                  <Button
                    size="sm"
                    variant={editing ? "dark" : "secondary"}
                    onClick={toggleEditing}
                    aria-pressed={editing}
                    data-testid="edit-zones"
                    title="Edit zones (E)"
                  >
                    <MousePointerSquareDashed />
                    {editing ? "Done" : "Edit zones"}
                  </Button>
                  <Link
                    href={`/floors/${floor.id}/edit`}
                    className={buttonClass("ghost", "icon-sm")}
                    data-testid="edit-layout"
                    title="Edit layout"
                    aria-label="Edit layout"
                  >
                    <PencilRuler />
                  </Link>
                  <Link
                    href="/floors/manage"
                    className={buttonClass("ghost", "icon-sm")}
                    data-testid="manage-floors"
                    title="Manage floors"
                    aria-label="Manage floors"
                  >
                    <LayoutGrid />
                  </Link>
                </div>
              ) : null}
            </div>
            {editing ? (
              <ZoneTools
                floor={floor}
                floors={floors}
                selection={sel}
                onClear={() => setSel(new Set())}
                execute={zone.execute}
                busy={zone.busy}
                editNumber={sel.size === 1 && numberFor !== null && sel.has(numberFor)}
                onNumberDone={() => setNumberFor(null)}
              />
            ) : selectedSeat ? (
              <SeatPanel
                floor={floor}
                seat={selectedSeat}
                editNumber={numberFor === selectedSeat.id}
                onNumberDone={() => setNumberFor(null)}
                onClose={() => setSeatId(null)}
                canSeat={canSeat}
                onMove={(m) => {
                  setSeatId(null);
                  setMoving(m);
                }}
                onMoved={() => setMoving(null)}
              />
            ) : null}
            {!selectedSeat || editing ? (
              <div className={cn(editing && "mt-5 border-t border-line pt-4")}>
                <FloorSummary
                  floor={floor}
                  used={used}
                  legend={legend}
                  isAdmin={isAdmin}
                  isLead={isLead}
                  canSeat={canSeat}
                  focusTeam={editing ? null : focusTeam}
                  editing={editing}
                  onTeam={onTeam}
                />
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </>
  );
}

/** Key to the plan, tucked into a small popover. */
function LegendPopover({ color, moving }: { color?: TeamColor; moving: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <Button size="md" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="legend-toggle">
        <Info />
        <span className="sr-only 2xl:not-sr-only">Legend</span>
      </Button>
      {open ? (
        <div
          className="absolute right-0 top-full z-40 mt-1.5 w-56 rounded-xl border border-black/[0.06] bg-white/95 p-3 text-[12.5px] text-neutral-600 shadow-[0_8px_30px_rgb(0_0_0/0.10)] backdrop-blur-md animate-fade-in"
          data-testid="floor-legend"
          role="dialog"
          aria-label="Legend"
        >
          <ul className="space-y-2">
            {(
              [
                { key: "taken", label: "Occupied", color, zoned: true, occupied: true },
                { key: "free", label: "Available", color, zoned: true },
                { key: "lead", label: "Team lead desk", zoned: false, lead: true },
                ...(moving
                  ? [
                      { key: "current", label: "Current desk", color, zoned: true, tone: "current" as const, now: true },
                      { key: "unavailable", label: "Not available for this move", color, zoned: true, occupied: true, tone: "disabled" as const },
                    ]
                  : [{ key: "chosen", label: "Selected", color, zoned: true, occupied: true, tone: "target" as const }]),
              ] satisfies SeatLegendItem[]
            ).map((it) => (
              <li key={it.key} className="flex items-center gap-2" data-legend={it.key}>
                <SeatSwatch item={it} />
                {it.label}
              </li>
            ))}
            <Key swatch="bg-black/[0.025] border border-black/[0.06]" label="Desk block" />
            <li className="flex items-center gap-2">
              <DoorOpen className="size-3.5 text-neutral-400" strokeWidth={1.5} aria-hidden /> Door · rooms are outlined
            </li>
          </ul>
          <p className="mt-3 border-t border-line pt-2 text-[11.5px] text-neutral-400">⌘ + scroll or pinch to zoom · Space + drag to pan</p>
        </div>
      ) : null}
    </div>
  );
}

function Key({ swatch, label }: { swatch: string; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={cn("size-3.5 rounded-[4px]", swatch)} aria-hidden />
      {label}
    </li>
  );
}

type LegendRow = { teamId: string; seats: number; used: number };

function legendFor(floor: Floor, occ: Map<string, { teamId: string }>): LegendRow[] {
  const m = new Map<string, LegendRow>();
  for (const e of seatsOf(floor)) {
    if (!e.teamId) continue;
    const r = m.get(e.teamId) ?? { teamId: e.teamId, seats: 0, used: 0 };
    r.seats++;
    if (occ.has(e.id)) r.used++;
    m.set(e.teamId, r);
  }
  return [...m.values()].sort((a, b) => b.seats - a.seats);
}

function zoneSummary(floors: readonly Floor[], teamId: string, occ: Map<string, unknown>) {
  let total = 0;
  let used = 0;
  const on: Floor[] = [];
  for (const f of floors) {
    let n = 0;
    for (const e of seatsOf(f)) {
      if (e.teamId !== teamId) continue;
      n++;
      if (occ.has(e.id)) used++;
    }
    if (n) on.push(f);
    total += n;
  }
  return { total, used, floors: on };
}

function FloorSummary({
  floor,
  used,
  legend,
  isAdmin,
  isLead,
  canSeat,
  focusTeam,
  editing,
  onTeam,
}: {
  floor: Floor;
  used: number;
  legend: LegendRow[];
  isAdmin: boolean;
  isLead: boolean;
  canSeat: boolean;
  focusTeam: string | null;
  editing: boolean;
  onTeam: (teamId: string) => void;
}) {
  const teams = useTeamsById();
  const colors = useTeamColors();
  const seats = floor.stats.seats;
  const zoned = legend.reduce((n, l) => n + l.seats, 0);
  const pct = seats ? Math.round((used / seats) * 100) : 0;
  return (
    <div className="space-y-4" data-testid="floor-summary">
      {!editing ? (
        <div>
          {floor.notes ? <p className="-mt-2 line-clamp-2 text-[12px] text-neutral-500">{floor.notes}</p> : null}
          <dl className="mt-3 flex items-baseline gap-4 text-[12px] text-neutral-500">
            <Stat label="seats" value={seats} />
            <Stat label="taken" value={used} />
            <Stat label="free" value={seats - used} />
          </dl>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-black/[0.05]" aria-hidden>
            <div className="h-full rounded-full bg-neutral-800/70 transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}
      <div>
        <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-400">{editing ? "Select a team’s seats" : "Teams"}</h3>
        {legend.length ? (
          <ul className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-x-6 min-[1800px]:block min-[1800px]:space-y-px" data-testid="team-list">
            {legend.map((l) => {
              const t = teams[l.teamId];
              const on = focusTeam === l.teamId;
              const leads = t?.leads ?? [];
              return (
                <li key={l.teamId}>
                  <button
                    type="button"
                    data-testid="legend-team"
                    data-team={l.teamId}
                    aria-pressed={editing ? undefined : on}
                    onClick={() => onTeam(l.teamId)}
                    title={editing ? `Select ${t?.name ?? "this team"}’s seats on this floor` : `Highlight ${t?.name ?? "this team"}`}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
                      on ? "bg-black/[0.05]" : "hover:bg-black/[0.03]",
                    )}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        background: colors[l.teamId]?.fill ?? NO_TEAM_COLOR.fill,
                      }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-neutral-800">{t?.name ?? "Unknown team"}</span>
                      {leads.length ? (
                        <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-neutral-500">
                          <Crown className="size-2.5 shrink-0 text-amber-500" aria-hidden />
                          <span className="truncate">{leads.map((x) => x.name).join(", ")}</span>
                        </span>
                      ) : null}
                    </span>
                    <span className="tnum shrink-0 text-[12px] text-neutral-400">
                      {l.used}/{l.seats}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-neutral-500">No team zones here yet.</p>
        )}
        {seats - zoned > 0 ? (
          <p className="mt-2 text-[12px] text-neutral-400">{seats - zoned === 1 ? "1 seat isn’t" : `${seats - zoned} seats aren’t`} in any team’s zone.</p>
        ) : null}
      </div>
      {!editing ? (
        <p className="border-t border-line pt-3 text-[12px] leading-5 text-neutral-500">
          {isAdmin
            ? "Click a seat to seat, move or renumber it. Edit zones to give seats to a team or move a team to another floor."
            : isLead && canSeat
              ? "Click a free seat in your zone to seat one of your people, or click your people to move them."
              : "Hover a seat to see who sits there. Search finds a person or a seat number."}
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1">
      <dd className="tnum text-[17px] font-semibold tracking-tight text-neutral-900">{value}</dd>
      <dt>{label}</dt>
    </div>
  );
}
