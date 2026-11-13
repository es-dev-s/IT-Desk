"use client";

import { Bath, Crown, DoorOpen, LogOut, Maximize2, Minus, Monitor, Plus } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SeatHolder } from "@/lib/floors";
import { tileName } from "@/lib/floors";
import type { FloorElement } from "@/lib/schemas";
import { NO_TEAM_COLOR, type TeamColor } from "@/lib/team-colors";
import { cn, pluralize } from "@/lib/utils";

/**
 * The one floor renderer, used by the floor view, the seat pickers and the
 * builder. Absolutely positioned cells on a cols × rows grid; zoom with the
 * buttons or Ctrl/⌘ + wheel, pan by scrolling (or dragging with the middle
 * button / space held). Seats are keyboard reachable: arrow keys jump to the
 * nearest seat in that direction, Enter/Space activates.
 *
 * Fits the whole floor to the screen by default (and on resize, until the
 * user zooms). Team zones tint the seat quietly; team leads (the person or
 * the designated lead desk) get a hairline amber ring and a small crown.
 */

/** Smallest cell: a 200-column floor still fits a laptop-width canvas (seats become dots; zoom for detail). */
export const MIN_CELL = 3;
export const MAX_CELL = 96;
export const DEFAULT_CELL = 52;
/** Fit-to-screen never blows small floors up past this. */
const FIT_MAX = 64;
const PAD = 16;
/** Room kept under the plan for the floating zoom pill, so it never covers the last row. */
const PILL = 36;

export type SeatTone = "default" | "disabled" | "target" | "current";

/** Occupied by the viewer's own team (green) or another team (red). */
export type SeatRelation = "own" | "other";
const RELATION_LOOK: Record<SeatRelation, { background: string; borderColor: string }> = {
  own: { background: "rgb(187 247 208)", borderColor: "rgb(22 163 74)" },
  other: { background: "rgb(254 202 202)", borderColor: "rgb(220 38 38)" },
};
/** Text/dot colour on a red or green seat. */
export const RELATION_INK: Record<SeatRelation, string> = { own: "rgb(21 128 61)", other: "rgb(185 28 28)" };

/** The small "now" text drawn on a mover's current desk (canvas and legend). */
export const NOW_MARK_CLASS = "text-[8.5px] font-bold uppercase tracking-wide text-neutral-600";

/**
 * Single source of truth for how a seat tile looks: fill, border, rings and
 * fade. The canvas tiles and every seat legend swatch call this, so a legend
 * can never drift from the plan. Zoom/size-dependent bits (radius, padding)
 * stay in the canvas.
 */
export function seatLook({
  color,
  zoned,
  occupied,
  lead = false,
  selected = false,
  tone = "default",
  dimmed = false,
  outOfFocus = false,
  relation,
  byTeam = false,
}: {
  color: TeamColor;
  zoned: boolean;
  occupied: boolean;
  lead?: boolean;
  selected?: boolean;
  tone?: SeatTone;
  /** Not matched by the current search highlight. */
  dimmed?: boolean;
  /** Outside the zone the view is focused on (e.g. another team's zone in a lead's picker). */
  outOfFocus?: boolean;
  /** Seat picker: who holds an occupied seat relative to the viewer's team. Overrides the zone colour. */
  relation?: SeatRelation;
  /**
   * Add-member picker: colour by who sits there, not by zone. Occupied seats
   * are solid red/green (never faded); every empty seat is white — dotted when
   * pickable, a faint solid outline when not.
   */
  byTeam?: boolean;
}): { className: string; style: React.CSSProperties } {
  if (byTeam) {
    const strong = occupied && relation;
    return {
      className: cn(
        occupied && "shadow-[0_0.5px_1px_rgb(0_0_0/0.06)]",
        lead && "ring-1 ring-amber-500",
        selected && "z-10 !ring-[2.5px] !ring-accent ring-offset-1 ring-offset-[#fbfbfa]",
        tone === "target" && "z-10 ring-[2.5px] ring-accent ring-offset-1 ring-offset-[#fbfbfa]",
        tone === "disabled" && "cursor-not-allowed",
        !strong && tone === "disabled" && "opacity-60",
        dimmed && tone !== "target" && "opacity-45",
      ),
      style: strong
        ? { ...RELATION_LOOK[relation], borderStyle: "solid", borderWidth: 1.5 }
        : tone === "disabled"
          ? { background: "white", borderColor: "rgb(0 0 0 / 0.18)", borderStyle: "solid", borderWidth: 1 }
          : { background: "white", borderColor: "rgb(0 0 0 / 0.42)", borderStyle: "dotted", borderWidth: 1.5 },
    };
  }
  return {
    className: cn(
      occupied && "shadow-[0_0.5px_1px_rgb(0_0_0/0.06)]",
      lead && "ring-1 ring-amber-500",
      selected && "z-10 !ring-[2.5px] !ring-accent ring-offset-1 ring-offset-[#fbfbfa]",
      tone === "target" && "z-10 ring-[2.5px] ring-accent ring-offset-1 ring-offset-[#fbfbfa]",
      tone === "disabled" && "cursor-not-allowed opacity-70",
      (dimmed || outOfFocus) && tone !== "target" && "opacity-45",
      outOfFocus && !dimmed && "opacity-80",
    ),
    style: {
      // Every open (pickable) seat looks the same — in a zone or not — so one
      // "Available" key covers them: white tile, dotted neutral outline.
      // Taken or unavailable seats stay solid in their zone's colour.
      ...(!occupied && tone !== "disabled"
        ? { background: "white", borderColor: "rgb(0 0 0 / 0.42)", borderStyle: "dotted", borderWidth: 1.5 }
        : {
            background: occupied ? color.soft : zoned ? `color-mix(in oklch, ${color.soft} 75%, white)` : "white",
            borderColor: zoned ? color.line : "rgb(0 0 0 / 0.42)",
            borderStyle: "solid",
            borderWidth: 1,
            ...(occupied && relation ? RELATION_LOOK[relation] : {}),
          }),
    },
  };
}

export type FloorCanvasHandle = {
  /** Scroll a cell into the middle of the viewport. */
  reveal: (x: number, y: number) => void;
  fit: () => void;
  /** Grid cell under a client point (builder). */
  cellAt: (clientX: number, clientY: number) => { x: number; y: number } | null;
  focusSeat: (id: string) => void;
};

export type FloorCanvasProps = {
  label: string;
  cols: number;
  rows: number;
  elements: readonly FloorElement[];
  colors: Record<string, TeamColor>;
  teamName: (id: string) => string;
  occupant?: (seatId: string) => SeatHolder | undefined;
  /** Seats/elements drawn as selected (accent ring). */
  selected?: ReadonlySet<string>;
  /** When set, everything else is dimmed (search, legend focus). */
  highlight?: ReadonlySet<string> | null;
  /** Team whose zone is emphasised (the lead's own zone). */
  focusTeamId?: string | null;
  /** When set, occupied seats are green for this team's people and red for everyone else's. */
  ownTeamId?: string | null;
  /** Lead name of a team (hover card on an empty lead desk). */
  leadName?: (teamId: string) => string | undefined;
  /** Seat that gets the "now" mark (the person's current desk), even while it is also selected. */
  nowSeatId?: string;
  tone?: (seat: FloorElement) => SeatTone;
  /** Builder: validation problems by element id (red outline). */
  invalid?: Readonly<Record<string, string>>;
  mode?: "view" | "pick" | "edit";
  onSeatClick?: (seat: FloorElement, e: React.MouseEvent | React.KeyboardEvent) => void;
  /** Double-click on a seat tile (view mode): the admin edits its number in place. */
  onSeatDoubleClick?: (seat: FloorElement) => void;
  /** Builder pointer hooks on the grid (cell coordinates). */
  onGridPointerDown?: (cell: { x: number; y: number }, e: React.PointerEvent) => void;
  onGridPointerMove?: (cell: { x: number; y: number }, e: React.PointerEvent) => void;
  onGridPointerUp?: (e: React.PointerEvent) => void;
  /** Builder overlay (marquee, paint preview), positioned in cell units via `cell`. */
  overlay?: (cell: number) => React.ReactNode;
  cell?: number;
  onCellChange?: (cell: number) => void;
  className?: string;
  maxHeight?: string;
  testId?: string;
  /** Hide the hover card (builder uses its own inspector). */
  noHoverCard?: boolean;
  toolbarExtra?: React.ReactNode;
  /** "always" refits on resize until the user zooms; "once" only on first paint (builder). */
  autoFit?: "always" | "once";
  /** Shrink the frame to the floor's height (up to maxHeight) instead of always filling it. */
  hug?: boolean;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const FloorCanvas = forwardRef<FloorCanvasHandle, FloorCanvasProps>(function FloorCanvas(
  {
    label,
    cols,
    rows,
    elements,
    colors,
    teamName,
    occupant,
    selected,
    highlight,
    focusTeamId,
    ownTeamId,
    leadName,
    nowSeatId,
    tone,
    invalid,
    mode = "view",
    onSeatClick,
    onSeatDoubleClick,
    onGridPointerDown,
    onGridPointerMove,
    onGridPointerUp,
    overlay,
    cell: cellProp,
    onCellChange,
    className,
    maxHeight = "min(68dvh, 760px)",
    testId = "floor-canvas",
    noHoverCard,
    toolbarExtra,
    autoFit,
    hug = true,
  },
  ref,
) {
  const [cellState, setCellState] = useState(DEFAULT_CELL);
  const cs = cellProp ?? cellState;
  const setCell = useCallback(
    (v: number) => {
      const next = clamp(Math.round(v), MIN_CELL, MAX_CELL);
      if (onCellChange) onCellChange(next);
      else setCellState(next);
    },
    [onCellChange],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const seatRefs = useRef(new Map<string, HTMLButtonElement>());
  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const edit = mode === "edit";

  const seats = useMemo(() => elements.filter((e) => e.kind === "seat"), [elements]);
  const sizer = useRef<HTMLDivElement>(null);
  const [fitSize, setFitSize] = useState<number | null>(null);
  // Paint order: rooms and voids under everything, then blocks/walls, doors, seats, labels on top.
  const ordered = useMemo(() => {
    const rank: Record<FloorElement["kind"], number> = {
      room: 0,
      void: 1,
      wall: 2,
      block: 3,
      door: 4,
      seat: 5,
      label: 6,
    };
    return [...elements].sort((a, b) => rank[a.kind] - rank[b.kind]);
  }, [elements]);

  // Fit the whole floor into the visible area (both directions), centred.
  const userZoomed = useRef(false);
  const fitCell = useCallback(() => {
    const el = scroller.current;
    if (!el) return null;
    const w = el.clientWidth - PAD * 2;
    const h = (hug && sizer.current ? sizer.current.clientHeight : el.clientHeight) - PAD * 2 - PILL;
    if (w <= 0 || h <= 0) return null;
    return clamp(Math.floor(Math.min(w / Math.max(cols, 1), h / Math.max(rows, 1))), MIN_CELL, FIT_MAX);
  }, [cols, rows, hug]);
  const fit = useCallback(() => {
    const c = fitCell();
    if (c === null) return;
    userZoomed.current = false;
    setFitSize(c);
    setCell(c);
    scroller.current?.scrollTo({ left: 0, top: 0 });
  }, [fitCell, setCell]);
  const zoomTo = useCallback(
    (v: number) => {
      userZoomed.current = true;
      setCell(v);
    },
    [setCell],
  );

  const fitMode = autoFit ?? (cellProp === undefined ? "always" : "once");
  const fitted = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    // The observer fires once on attach, which gives us the first fit.
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (userZoomed.current || (fitMode === "once" && fitted.current)) return;
        const c = fitCell();
        if (c === null) return;
        fitted.current = true;
        setFitSize(c);
        setCell(c);
      });
    });
    ro.observe(el);
    if (sizer.current) ro.observe(sizer.current);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [fitMode, fitCell, setCell]);

  const reveal = useCallback(
    (x: number, y: number) => {
      const el = scroller.current;
      const p = plane.current;
      if (!el || !p) return;
      const ox = p.offsetLeft;
      const oy = p.offsetTop;
      el.scrollTo({
        left: ox + x * cs - el.clientWidth / 2 + cs / 2,
        top: oy + y * cs - el.clientHeight / 2 + cs / 2,
        behavior: "smooth",
      });
    },
    [cs],
  );

  const cellAt = useCallback(
    (clientX: number, clientY: number) => {
      const r = plane.current?.getBoundingClientRect();
      if (!r) return null;
      const x = Math.floor((clientX - r.left) / cs);
      const y = Math.floor((clientY - r.top) / cs);
      if (x < 0 || y < 0 || x >= cols || y >= rows) return null;
      return { x, y };
    },
    [cs, cols, rows],
  );

  useImperativeHandle(
    ref,
    () => ({
      reveal,
      fit,
      cellAt,
      focusSeat: (id) => {
        setCursor(id);
        const s = seats.find((e) => e.id === id);
        if (s) reveal(s.x, s.y);
        requestAnimationFrame(() => seatRefs.current.get(id)?.focus({ preventScroll: true }));
      },
    }),
    [reveal, fit, cellAt, seats],
  );

  // Ctrl/⌘ + wheel zooms around the pointer.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left + el.scrollLeft;
      const py = e.clientY - r.top + el.scrollTop;
      const raw = Math.round(cs * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      // At tiny sizes 12% rounds back to the same pixel; always move at least one.
      const next = clamp(raw === cs ? cs + (e.deltaY < 0 ? 1 : -1) : raw, MIN_CELL, MAX_CELL);
      if (next === cs) return;
      zoomTo(next);
      requestAnimationFrame(() => {
        el.scrollLeft = (px * next) / cs - (e.clientX - r.left);
        el.scrollTop = (py * next) / cs - (e.clientY - r.top);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [cs, zoomTo]);

  // Middle-button (or space + drag) panning.
  const pan = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const space = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) space.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") space.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const el = scroller.current;
    if (el && (e.button === 1 || (space.current && e.button === 0))) {
      e.preventDefault();
      pan.current = {
        x: e.clientX,
        y: e.clientY,
        l: el.scrollLeft,
        t: el.scrollTop,
      };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (edit && e.button === 0 && onGridPointerDown) {
      const c = cellAt(e.clientX, e.clientY);
      if (c) {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        onGridPointerDown(c, e);
      }
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = scroller.current;
    if (pan.current && el) {
      el.scrollLeft = pan.current.l - (e.clientX - pan.current.x);
      el.scrollTop = pan.current.t - (e.clientY - pan.current.y);
      return;
    }
    if (edit && onGridPointerMove) {
      const c = cellAt(e.clientX, e.clientY);
      if (c) onGridPointerMove(c, e);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (pan.current) {
      pan.current = null;
      return;
    }
    if (edit) onGridPointerUp?.(e);
  };

  // Keyboard: nearest seat in the arrow's direction.
  const move = (from: FloorElement, key: string) => {
    const d = key === "ArrowRight" ? [1, 0] : key === "ArrowLeft" ? [-1, 0] : key === "ArrowDown" ? [0, 1] : key === "ArrowUp" ? [0, -1] : null;
    if (!d) return null;
    let best: FloorElement | null = null;
    let score = Infinity;
    for (const s of seats) {
      const dx = s.x - from.x;
      const dy = s.y - from.y;
      const along = dx * d[0] + dy * d[1];
      if (along <= 0) continue;
      const across = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
      const sc = along + across * 3;
      if (sc < score) {
        score = sc;
        best = s;
      }
    }
    return best;
  };
  const onSeatKey = (s: FloorElement, e: React.KeyboardEvent) => {
    if (e.key === "Home" || e.key === "End") {
      const row = seats.filter((o) => o.y === s.y).sort((a, b) => a.x - b.x);
      const t = e.key === "Home" ? row[0] : row.at(-1);
      if (t) {
        e.preventDefault();
        setCursor(t.id);
        seatRefs.current.get(t.id)?.focus();
      }
      return;
    }
    const t = move(s, e.key);
    if (t) {
      e.preventDefault();
      setCursor(t.id);
      const btn = seatRefs.current.get(t.id);
      btn?.focus();
      btn?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  const tabStop = cursor && seats.some((s) => s.id === cursor) ? cursor : (seats.find((s) => highlight?.has(s.id)) ?? seats[0])?.id;
  // Number on every tile from ~18px; the seated person's first name once
  // the tile can hold it (number-only when zoomed out).
  const showText = cs >= 18;
  const showName = cs >= 40;
  const gap = cs < 8 ? 0.5 : cs < 16 ? 1 : Math.max(2, Math.round(cs * 0.07));

  // Handlers read through a ref so the (large) tile layer only re-renders when
  // what it shows changes — not on hover, drag overlays or parent re-renders.
  const live = useRef({ onSeatClick, onSeatDoubleClick, onSeatKey, noHoverCard });
  useEffect(() => {
    live.current = { onSeatClick, onSeatDoubleClick, onSeatKey, noHoverCard };
  });
  // Cheap per-render signature of everything the tiles derive from callbacks.
  const sig = seats
    .map((e) => {
      const o = occupant?.(e.id);
      return `${o ? `${o.memberId ?? ""}:${o.name ?? ""}:${o.isLead ? 1 : 0}:${o.redacted ? 1 : 0}:${o.teamId ?? ""}` : ""};${tone?.(e) ?? ""};${e.teamId ? teamName(e.teamId) : ""}`;
    })
    .join("|");
  const tiles = useMemo(
    () =>
      ordered.map((e) => {
        const style: React.CSSProperties = {
          left: e.x * cs,
          top: e.y * cs,
          width: e.w * cs,
          height: e.h * cs,
        };
        const dim = highlight ? !highlight.has(e.id) : false;
        const isSel = selected?.has(e.id) ?? false;
        const bad = invalid?.[e.id];
        if (e.kind !== "seat") {
          return <Landmark key={e.id} el={e} style={style} cs={cs} dim={dim && e.kind !== "label"} selected={isSel} invalid={bad} edit={edit} />;
        }
        const color = (e.teamId && colors[e.teamId]) || NO_TEAM_COLOR;
        const occ = occupant?.(e.id);
        const t = tone?.(e) ?? "default";
        const lead = Boolean(occ?.isLead) || e.leadSeat;
        const focusDim = focusTeamId ? e.teamId !== focusTeamId : false;
        const who = occ ? (occ.redacted || !occ.name ? teamName(occ.teamId) : occ.name) : "";
        const aria = [
          e.code ? `Seat ${e.code}` : "New seat",
          e.teamId ? `${teamName(e.teamId)} zone` : "no team zone",
          occ ? (occ.redacted ? `taken (${teamName(occ.teamId)})` : `${occ.name}${occ.isLead ? ", team lead" : ""}`) : "free",
          e.leadSeat ? "lead seat" : "",
          t === "disabled" ? "not available" : "",
        ]
          .filter(Boolean)
          .join(", ");
        const relation: SeatRelation | undefined = ownTeamId && occ ? (occ.teamId === ownTeamId ? "own" : "other") : undefined;
        const byTeam = Boolean(ownTeamId);
        const look = seatLook({ color, zoned: Boolean(e.teamId), occupied: Boolean(occ), lead, selected: isSel, tone: t, dimmed: dim, outOfFocus: focusDim && !highlight, relation, byTeam });
        const named = showName && occ;
        const shown = occ ? (occ.redacted || !occ.name ? "Taken" : tileName(occ.name)) : "";
        // Colouring by team: no zone tints anywhere on the tile.
        const numberColor = byTeam ? (relation ? RELATION_INK[relation] : "rgb(0 0 0 / 0.6)") : e.teamId ? color.ink : "rgb(0 0 0 / 0.7)";
        const content = (
          <>
            {named ? (
              <>
                <span
                  className={cn("tnum block truncate font-medium leading-none", lead && (cs >= 44 ? "pr-3.5" : "pr-2.5"), cs >= 56 ? "text-[10.5px]" : "text-[9.5px]")}
                  style={{ color: numberColor }}
                  data-seat-number
                >
                  {e.code || "–"}
                </span>
                <span
                  className={cn(
                    "mt-auto block truncate font-semibold leading-tight tracking-[-0.01em] text-neutral-900",
                    occ.redacted && "font-normal italic text-neutral-500",
                  )}
                  style={{ fontSize: nameSize(shown, cs - 2 * gap - (cs >= 56 ? 12 : 8), cs >= 64 ? 12.5 : cs >= 52 ? 11.5 : 10.5) }}
                  data-seat-name
                >
                  {shown}
                </span>
              </>
            ) : showText ? (
              <span
                className={cn(
                  "tnum m-auto block max-w-full truncate leading-none",
                  cs >= 40 ? "text-[12px]" : cs >= 28 ? "text-[10.5px]" : "text-[9px]",
                  occ ? "font-semibold" : "font-medium",
                )}
                style={{ color: occ && !byTeam ? (e.teamId ? color.ink : "rgb(0 0 0 / 0.7)") : numberColor }}
                data-seat-number
              >
                {e.code || "–"}
              </span>
            ) : null}
            {!showName && occ ? (
              <span
                aria-hidden
                className={cn("absolute rounded-full", showText ? "bottom-[3px] left-1/2 size-1 -translate-x-1/2" : "inset-[34%]")}
                style={{ background: relation ? RELATION_INK[relation] : color.fill }}
              />
            ) : null}
            {lead ? (
              <span
                aria-hidden
                className={cn("absolute grid place-items-center text-amber-600", cs >= 36 ? "right-[3px] top-[3px]" : "right-px top-px")}
                data-lead={occ?.isLead ? "person" : "seat"}
              >
                <Crown className={cs >= 44 ? "size-[11px]" : "size-2"} strokeWidth={2.25} fill="currentColor" fillOpacity={0.18} />
              </span>
            ) : null}
            {t === "current" || (nowSeatId && e.id === nowSeatId) ? (
              <span aria-hidden className={cn("absolute leading-none", NOW_MARK_CLASS, cs >= 40 ? "bottom-1 right-1" : cs >= 30 ? "bottom-px right-px !text-[6.5px] !tracking-normal" : "bottom-px right-px !text-[5px] !tracking-normal")} data-now>
                now
              </span>
            ) : null}
          </>
        );
        const cls = cn(
          "absolute flex flex-col border text-left outline-none transition-[opacity,box-shadow,background-color,border-color] duration-200 ease-out",
          cs >= 56 ? "rounded-[7px] px-[6px] py-[5px]" : cs >= 40 ? "rounded-[6px] px-[4px] py-[4px]" : cs >= 10 ? "rounded-[4px] p-[2px]" : "rounded-[1.5px]",
          look.className,
          bad && "!border-red-500",
          !edit && t !== "disabled" && "hover:shadow-[0_2px_6px_rgb(0_0_0/0.08)] focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-accent/50",
        );
        const tileStyle: React.CSSProperties = {
          left: e.x * cs + gap,
          top: e.y * cs + gap,
          width: cs - gap * 2,
          height: cs - gap * 2,
          ...look.style,
        };
        if (edit) {
          return (
            <div key={e.id} className={cn(cls, "pointer-events-none")} style={tileStyle} data-seat={e.code} title={bad}>
              {content}
            </div>
          );
        }
        return (
          <button
            key={e.id}
            ref={(el) => {
              if (el) seatRefs.current.set(e.id, el);
              else seatRefs.current.delete(e.id);
            }}
            type="button"
            tabIndex={e.id === tabStop ? 0 : -1}
            aria-label={aria}
            aria-pressed={selected ? isSel : undefined}
            aria-disabled={t === "disabled" || undefined}
            data-seat={e.code}
            data-seat-id={e.id}
            data-name={occ && !occ.redacted ? occ.name : undefined}
            data-team={e.teamId ?? ""}
            data-occupied={occ ? "true" : "false"}
            data-lead={lead ? "true" : undefined}
            className={cls}
            style={tileStyle}
            onClick={(ev) => live.current.onSeatClick?.(e, ev)}
            onDoubleClick={() => live.current.onSeatDoubleClick?.(e)}
            onKeyDown={(ev) => live.current.onSeatKey(e, ev)}
            onFocus={(ev) => {
              setCursor(e.id);
              if (!live.current.noHoverCard)
                setHover({
                  id: e.id,
                  rect: ev.currentTarget.getBoundingClientRect(),
                });
            }}
            onBlur={() => setHover(null)}
            onMouseEnter={(ev) =>
              !live.current.noHoverCard &&
              setHover({
                id: e.id,
                rect: ev.currentTarget.getBoundingClientRect(),
              })
            }
            onMouseLeave={() => setHover(null)}
          >
            {content}
            <span className="sr-only">{who}</span>
          </button>
        );
      }),
    // occupant/tone/teamName are folded into `sig`; handlers go through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ordered, cs, gap, sig, highlight, selected, invalid, colors, edit, showText, showName, focusTeamId, ownTeamId, nowSeatId, tabStop],
  );

  const hoverSeat = hover ? seats.find((s) => s.id === hover.id) : undefined;

  return (
    <div className={cn("relative overflow-hidden rounded-2xl border border-black/[0.06] bg-[#fbfbfa]", className)} data-testid={testId}>
      {hug ? <div ref={sizer} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 w-px" style={{ height: maxHeight }} /> : null}
      <div
        ref={scroller}
        className={cn("scrollbar-thin relative overflow-auto overscroll-contain", edit && "select-none")}
        style={{ height: hug ? `min(${maxHeight}, ${rows * (fitSize ?? cs) + PAD * 2 + PILL}px)` : maxHeight }}
        onScroll={() => setHover(null)}
      >
        <div
          className="grid place-items-center"
          style={{
            minWidth: "100%",
            minHeight: "100%",
            width: "max-content",
            padding: PAD,
            paddingBottom: PAD + PILL,
          }}
        >
          <div
            ref={plane}
            role="group"
            aria-label={label}
            className={cn("relative", edit && "cursor-crosshair touch-none")}
            style={{ width: cols * cs, height: rows * cs }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {edit ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-[3px] bg-white outline outline-1 outline-black/10"
                style={{
                  backgroundImage:
                    "linear-gradient(to right, rgb(0 0 0/0.045) 1px, transparent 1px), linear-gradient(to bottom, rgb(0 0 0/0.045) 1px, transparent 1px)",
                  backgroundSize: `${cs}px ${cs}px`,
                }}
              />
            ) : null}
            {tiles}
            {overlay?.(cs)}
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5">
        {toolbarExtra}
        <div
          className="pointer-events-auto flex items-center rounded-full border border-black/[0.07] bg-white/90 p-0.5 shadow-[0_1px_3px_rgb(0_0_0/0.06)] backdrop-blur-md"
          data-testid="zoom-pill"
        >
          <ZoomButton label="Zoom out" onClick={() => zoomTo(cs / 1.2)} disabled={cs <= MIN_CELL}>
            <Minus />
          </ZoomButton>
          <span className="tnum w-9 text-center text-[10.5px] font-medium text-neutral-500" aria-live="polite">
            {Math.round((cs / DEFAULT_CELL) * 100)}%
          </span>
          <ZoomButton label="Zoom in" onClick={() => zoomTo(cs * 1.2)} disabled={cs >= MAX_CELL}>
            <Plus />
          </ZoomButton>
          <span className="mx-0.5 h-3.5 w-px bg-black/10" aria-hidden />
          <ZoomButton label="Fit to screen" onClick={fit}>
            <Maximize2 />
          </ZoomButton>
        </div>
      </div>

      {hover && hoverSeat && typeof document !== "undefined"
        ? createPortal(
            <HoverCard seat={hoverSeat} rect={hover.rect} occ={occupant?.(hoverSeat.id)} colors={colors} teamName={teamName} tone={tone?.(hoverSeat)} ownTeamId={ownTeamId} leadName={leadName} />,
            document.body,
          )
        : null}
    </div>
  );
});

function ZoomButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-6 place-items-center rounded-full text-neutral-500 outline-none transition-colors hover:bg-black/[0.05] hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-35 [&_svg]:size-3"
    >
      {children}
    </button>
  );
}

const LANDMARK_LABEL: Partial<Record<FloorElement["kind"], string>> = {
  door: "Door",
  room: "Room",
  block: "",
  void: "",
  wall: "",
};

function Landmark({
  el,
  style,
  cs,
  dim,
  selected,
  invalid,
  edit,
}: {
  el: FloorElement;
  style: React.CSSProperties;
  cs: number;
  dim: boolean;
  selected: boolean;
  invalid?: string;
  edit: boolean;
}) {
  const text = el.label || LANDMARK_LABEL[el.kind] || "";
  const base = cn(
    "pointer-events-none absolute flex items-center justify-center overflow-hidden text-center transition-opacity",
    dim && "opacity-60",
    selected && "z-10 outline outline-2 outline-offset-1 outline-accent",
    invalid && "outline outline-2 outline-red-500",
  );
  const small = cs < 40;
  const icon = small ? "size-3" : "size-3.5";
  const RoomIcon = /server|it room|rack/i.test(text)
    ? Monitor
    : /wash|toilet|wc|rest ?room|bath/i.test(text)
      ? Bath
      : /exit|stair|fire/i.test(text)
        ? LogOut
        : null;
  switch (el.kind) {
    case "block":
      return (
        <div className={cn(base, "rounded-[6px] border border-black/[0.1] bg-black/[0.045]")} style={inset(style, 4)} title={invalid} data-kind="block">
          {text && !small ? <span className="truncate px-1 text-[9.5px] font-medium uppercase tracking-[0.08em] text-neutral-500">{text}</span> : null}
        </div>
      );
    case "void":
      return (
        <div
          className={cn(base, "rounded-[3px]")}
          style={{
            ...style,
            backgroundImage: "repeating-linear-gradient(135deg, rgb(0 0 0/0.065) 0 1px, transparent 1px 6px)",
          }}
          title={invalid}
          data-kind="void"
        />
      );
    case "wall":
      return <div className={cn(base, "rounded-full bg-neutral-400")} style={inset(style, Math.max(2, cs * 0.12), true)} title={invalid} data-kind="wall" />;
    case "door":
      return (
        <div className={cn(base, "flex-col gap-0.5 text-neutral-500")} style={inset(style, 3)} title={invalid ?? text} data-kind="door">
          <DoorOpen className={icon} strokeWidth={1.5} aria-hidden />
          {!small && el.w * cs >= 52 ? (
            <span className="max-w-full truncate px-1 text-[9.5px] font-medium uppercase leading-none tracking-[0.06em]">{text}</span>
          ) : null}
        </div>
      );
    case "room":
      return (
        <div
          className={cn(base, "rounded-[8px] border border-black/[0.12] bg-white/70 text-neutral-600")}
          style={inset(style, 3)}
          title={invalid ?? text}
          data-kind="room"
        >
          <span className="flex max-w-full items-center gap-1 truncate px-1.5 text-[10px] font-medium uppercase tracking-[0.06em]">
            {RoomIcon ? <RoomIcon className="size-3 shrink-0" strokeWidth={1.5} aria-hidden /> : null}
            {text}
          </span>
        </div>
      );
    case "label":
      return (
        <div
          className={cn(base, "justify-start", edit && "rounded border border-dashed border-neutral-300")}
          style={style}
          title={invalid ?? text}
          data-kind="label"
        >
          <span
            className={cn(
              "flex items-center gap-1 truncate px-1 font-medium uppercase tracking-[0.08em] text-neutral-500",
              cs >= 50 ? "text-[10px]" : "text-[8.5px]",
            )}
          >
            {RoomIcon ? <RoomIcon className="size-3 shrink-0" strokeWidth={1.5} aria-hidden /> : null}
            {text}
          </span>
        </div>
      );
    default:
      return null;
  }
}

function inset(style: React.CSSProperties, px: number, vertical = false): React.CSSProperties {
  const w = Number(style.width);
  const h = Number(style.height);
  if (vertical) {
    // Walls: a thick line through the middle of their cells.
    const horizontal = w >= h;
    return horizontal
      ? {
          left: style.left,
          top: Number(style.top) + (h - px) / 2,
          width: w,
          height: px,
        }
      : {
          left: Number(style.left) + (w - px) / 2,
          top: style.top,
          width: px,
          height: h,
        };
  }
  return {
    left: Number(style.left) + px / 2,
    top: Number(style.top) + px / 2,
    width: w - px,
    height: h - px,
  };
}

function HoverCard({
  seat,
  rect,
  occ,
  colors,
  teamName,
  tone,
  ownTeamId,
  leadName,
}: {
  seat: FloorElement;
  rect: DOMRect;
  occ?: SeatHolder;
  colors: Record<string, TeamColor>;
  teamName: (id: string) => string;
  tone?: SeatTone;
  ownTeamId?: string | null;
  leadName?: (teamId: string) => string | undefined;
}) {
  const zone = seat.teamId;
  const zc = (zone && colors[zone]) || NO_TEAM_COLOR;
  const relation: SeatRelation | undefined = ownTeamId && occ ? (occ.teamId === ownTeamId ? "own" : "other") : undefined;
  const avatar = relation ? RELATION_INK[relation] : ((occ && colors[occ.teamId]) || NO_TEAM_COLOR).fill;
  // An empty lead desk: whose desk it is (the zone team's lead).
  const deskLead = !occ && seat.leadSeat && zone ? leadName?.(zone) : undefined;
  const width = 232;
  const left = clamp(rect.left + rect.width / 2 - width / 2, 8, (typeof window !== "undefined" ? window.innerWidth : 1200) - width - 8);
  const below = rect.top < 170;
  const top = below ? rect.bottom + 8 : rect.top - 8;
  return (
    <div
      role="tooltip"
      data-testid="seat-hovercard"
      className="pointer-events-none fixed z-[60] rounded-xl border border-black/[0.06] bg-white/95 p-3 text-left shadow-[0_8px_30px_rgb(0_0_0/0.10)] backdrop-blur-md animate-fade-in"
      style={{
        left,
        top,
        width,
        transform: below ? undefined : "translateY(-100%)",
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-neutral-900">
          {seat.code ? (
            <>
              <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">Seat</span>
              <span className="tnum">{seat.code}</span>
            </>
          ) : (
            "New seat"
          )}
        </span>
        {seat.leadSeat ? (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-medium leading-4 text-amber-700 ring-1 ring-amber-200">
            <Crown className="size-2.5 shrink-0" aria-hidden /> Lead desk
          </span>
        ) : null}
        <span className="ml-auto inline-flex min-w-0 items-center gap-1.5 text-[11px] text-neutral-500">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{
              background: zone ? zc.fill : "transparent",
              boxShadow: zone ? undefined : "inset 0 0 0 1px rgb(0 0 0/0.25)",
            }}
          />
          <span className="truncate">{zone ? teamName(zone) : "No zone"}</span>
        </span>
      </div>
      <div className="mt-2.5 border-t border-line pt-2.5">
        {occ ? (
          <>
            <div className="flex items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: avatar }}>
                {occ.redacted || !occ.name
                  ? "·"
                  : occ.name
                      .split(" ")
                      .map((p) => p[0])
                      .slice(0, 2)
                      .join("")}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-neutral-900">{occ.redacted || !occ.name ? "Someone from another team" : occ.name}</p>
                {/* Your own team's people: name only. Everyone else (and any lead): name and team. */}
                {ownTeamId && occ.teamId === ownTeamId && !occ.isLead ? null : (
                  <p className="truncate text-[11px] text-neutral-500">{teamName(occ.teamId)}</p>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500">
              {relation ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 font-medium ring-1",
                    relation === "own" ? "bg-green-50 text-green-700 ring-green-200" : "bg-red-50 text-red-700 ring-red-200",
                  )}
                  data-testid="seat-hover-relation"
                >
                  {relation === "own" ? "Your team" : "Other team"}
                </span>
              ) : null}
              {occ.isLead ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 ring-1 ring-amber-200">
                  <Crown className="size-3 shrink-0" aria-hidden /> Team lead
                </span>
              ) : null}
              {!occ.redacted && occ.memberId ? <span className="tnum">{pluralize(occ.devices, "device")}</span> : null}
              {zone && occ.teamId !== zone ? <span className="text-amber-700">Outside own zone</span> : null}
            </div>
          </>
        ) : deskLead ? (
          <div className="flex items-center gap-2" data-testid="seat-hover-desk-lead">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-600 ring-1 ring-amber-200">
              <Crown className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-neutral-900">{deskLead}</p>
              <p className="truncate text-[11px] text-neutral-500">
                {teamName(zone!)} · Team lead desk{tone === "disabled" ? " · not available" : ""}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-neutral-600">
            {tone === "disabled" ? "Not available for this move" : tone === "target" ? "Free · click to place here" : "Free seat"}
          </p>
        )}
      </div>
    </div>
  );
}

/** Shrinks a tile name a little (never below 9px) so short names fit without an ellipsis. */
function nameSize(name: string, width: number, max: number) {
  const fit = width / (Math.max(name.length, 1) * 0.6);
  return Math.round(Math.max(9, Math.min(max, fit)) * 2) / 2;
}
