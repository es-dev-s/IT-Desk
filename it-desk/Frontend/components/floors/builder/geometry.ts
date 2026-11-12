import { GRID, newElementId, overlaps } from "@/lib/floors";
import type { FloorElement } from "@/lib/schemas";

export type Cell = { x: number; y: number };
export type Kind = FloorElement["kind"];

const BASE = { w: 1, h: 1, code: "", label: "", teamId: null, leadSeat: false, codeLocked: false } as const;

export const make = (kind: Kind, x: number, y: number, extra: Partial<FloorElement> = {}): FloorElement => ({
  ...BASE,
  id: newElementId(),
  kind,
  x,
  y,
  ...extra,
});

/** Would `cand` sit on top of something solid? */
export const blocked = (els: readonly FloorElement[], cand: FloorElement, ignore?: ReadonlySet<string>) =>
  els.some((e) => !ignore?.has(e.id) && e.id !== cand.id && overlaps(e, cand));

const PRIORITY: Record<Kind, number> = { label: 0, door: 1, seat: 2, wall: 3, room: 4, block: 5, void: 6 };

/** The element a click on (x, y) means: labels and doors over seats over areas. */
export function topAt(els: readonly FloorElement[], x: number, y: number) {
  let best: FloorElement | undefined;
  for (const e of els) {
    if (x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h && (!best || PRIORITY[e.kind] < PRIORITY[best.kind])) best = e;
  }
  return best;
}

export const rectOf = (a: Cell, b: Cell) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x) + 1,
  h: Math.abs(a.y - b.y) + 1,
});

/** Every cell from a to b along the dominant axis (a straight seat row). */
export function lineCells(a: Cell, b: Cell): Cell[] {
  const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const out: Cell[] = [];
  if (horiz) for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) out.push({ x, y: a.y });
  else for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) out.push({ x: a.x, y });
  return out;
}

/** Cells between two pointer samples so fast drags don't leave gaps. */
export function stepCells(a: Cell, b: Cell): Cell[] {
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  const out: Cell[] = [];
  for (let i = 1; i <= n; i++) out.push({ x: Math.round(a.x + ((b.x - a.x) * i) / n), y: Math.round(a.y + ((b.y - a.y) * i) / n) });
  return out;
}

export const intersects = (e: FloorElement, r: { x: number; y: number; w: number; h: number }) =>
  e.x < r.x + r.w && r.x < e.x + e.w && e.y < r.y + r.h && r.y < e.y + e.h;

/** Add seats on free cells; returns the same array when nothing changed. */
export function addSeats(els: FloorElement[], cells: Cell[], cols: number, rows: number) {
  let out = els;
  for (const c of cells) {
    if (c.x < 0 || c.y < 0 || c.x >= cols || c.y >= rows) continue;
    const s = make("seat", c.x, c.y);
    if (blocked(out, s)) continue;
    if (out === els) out = [...els];
    out.push(s);
  }
  return out;
}

/** Remove the top element under each cell. */
export function eraseAt(els: FloorElement[], cells: Cell[]) {
  let out = els;
  for (const c of cells) {
    const hit = topAt(out, c.x, c.y);
    if (hit) out = out.filter((e) => e.id !== hit.id);
  }
  return out;
}

/** Smallest grid (with a one-cell margin) that still holds every element. */
export function fitGrid(els: readonly FloorElement[]) {
  let cols: number = GRID.minCols;
  let rows: number = GRID.minRows;
  for (const e of els) {
    cols = Math.max(cols, e.x + e.w + 1);
    rows = Math.max(rows, e.y + e.h + 1);
  }
  return { cols: Math.min(cols, GRID.maxCols), rows: Math.min(rows, GRID.maxRows) };
}
