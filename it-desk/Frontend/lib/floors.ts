import { z } from "zod";
import type { Floor, FloorElement, Member, SeatOccupant } from "./schemas";

/**
 * Floor grid limits — the single source for the frontend. Must match the Go
 * constants (domain.MinCols…) and the DB CHECKs (migration 0008);
 * backend TestGridLimitsInSync fails if they drift.
 */
export const GRID = {
  minCols: 2,
  maxCols: 200,
  minRows: 2,
  maxRows: 200,
} as const;

export const GRID_HINT = {
  cols: `${GRID.minCols}–${GRID.maxCols}`,
  rows: `${GRID.minRows}–${GRID.maxRows}`,
} as const;

export const gridSizeSchema = z.object({
  cols: z.coerce
    .number({ error: `Use ${GRID_HINT.cols} columns` })
    .int(`Use ${GRID_HINT.cols} columns`)
    .min(GRID.minCols, `Use ${GRID_HINT.cols} columns`)
    .max(GRID.maxCols, `Use ${GRID_HINT.cols} columns`),
  rows: z.coerce
    .number({ error: `Use ${GRID_HINT.rows} rows` })
    .int(`Use ${GRID_HINT.rows} rows`)
    .min(GRID.minRows, `Use ${GRID_HINT.rows} rows`)
    .max(GRID.maxRows, `Use ${GRID_HINT.rows} rows`),
});

/** Elements that would stick out of a cols x rows grid (they are kept, but must move before publishing). */
export function outsideGrid<T extends { x: number; y: number; w: number; h: number }>(els: readonly T[], cols: number, rows: number) {
  return els.filter((e) => e.x + e.w > cols || e.y + e.h > rows);
}

/** A seat on a published floor, with where it lives. */
export type SeatRef = {
  id: string;
  code: string;
  floorId: string;
  floorName: string;
  teamId: string | null;
  leadSeat: boolean;
};

/** Who sits on a seat. `memberId` is empty when the person is hidden from this viewer. */
export type SeatHolder = SeatOccupant;

export const isSeat = (e: Pick<FloorElement, "kind">) => e.kind === "seat";

/** Every seat on the published floors, by id. */
export function seatIndex(floors: readonly Floor[]): Map<string, SeatRef> {
  const out = new Map<string, SeatRef>();
  for (const f of floors) {
    for (const e of f.elements) {
      if (e.kind !== "seat") continue;
      out.set(e.id, { id: e.id, code: e.code, floorId: f.id, floorName: f.name, teamId: e.teamId, leadSeat: e.leadSeat });
    }
  }
  return out;
}

/**
 * Seat occupancy: the server's occupants (which include people this viewer
 * can't see, redacted), overlaid with the members this client knows, so
 * optimistic moves show up instantly and never double-count a person.
 */
export function occupancy(floors: readonly Floor[], members: Record<string, Member>, memberIds: readonly string[]): Map<string, SeatHolder> {
  const out = new Map<string, SeatHolder>();
  const known = new Set(memberIds);
  for (const f of floors) {
    for (const [seatId, o] of Object.entries(f.occupants)) {
      if (o.memberId && known.has(o.memberId)) continue;
      out.set(seatId, o);
    }
  }
  for (const id of memberIds) {
    const m = members[id];
    if (!m || m.status !== "active" || !m.seatId) continue;
    out.set(m.seatId, {
      memberId: m.id,
      name: m.name,
      teamId: m.teamId,
      isLead: m.isLead,
      devices: m.devices.length,
      hue: m.hue,
      redacted: false,
    });
  }
  return out;
}

/**
 * Fills empty seat numbers (and refreshes unlocked ones when `all`) with plain
 * numbers in reading order — top row first, left to right — so the n-th seat
 * is "n" (1, 2, … 100 …). Numbers held by locked (hand-set or published) seats
 * are skipped. `prefix` is ignored (kept for older callers). Mirrors
 * domain.AutoNumber on the server.
 */
export function autoNumber(_prefix: string, els: readonly FloorElement[], all = false): FloorElement[] {
  const next = els.map((e) => ({ ...e }));
  const used = new Set(next.filter((e) => isSeat(e) && e.code && (e.codeLocked || !all)).map((e) => e.code));
  const seats = next.filter(isSeat).sort((a, b) => a.y - b.y || a.x - b.x);
  let after = 1;
  seats.forEach((e, pos) => {
    if (e.codeLocked || (!all && e.code)) return;
    let num = Math.max(pos + 1, after);
    while (used.has(String(num))) num++;
    e.code = String(num);
    used.add(e.code);
    after = num + 1;
  });
  return next;
}

let seq = 0;
export const newElementId = () => `el_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** "Two facing rows of N with a centre block and a door" (same as the server template). */
export function facingRowsTemplate(n: number): { cols: number; rows: number; elements: FloorElement[] } {
  const base = { w: 1, h: 1, code: "", label: "", teamId: null, leadSeat: false, codeLocked: false };
  const els: FloorElement[] = [];
  for (let i = 0; i < n; i++) els.push({ ...base, id: newElementId(), kind: "seat", x: 1 + i, y: 1 });
  els.push({ ...base, id: newElementId(), kind: "block", x: 1, y: 2, w: n, h: 2 });
  for (let i = 0; i < n; i++) els.push({ ...base, id: newElementId(), kind: "seat", x: 1 + i, y: 4 });
  els.push({ ...base, id: newElementId(), kind: "door", x: 0, y: 5, label: "Door" });
  return { cols: Math.max(4, n + 2), rows: 7, elements: els };
}

/** Solid kinds may not overlap; labels sit on anything and doors may sit in a room's outline. */
export function overlaps(a: FloorElement, b: FloorElement) {
  if (a.kind === "label" || b.kind === "label") return false;
  if ((a.kind === "room" && b.kind === "door") || (a.kind === "door" && b.kind === "room")) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Client-side copy of the publish checks, keyed by element id ("" = floor-wide). */
export function validateLayout(cols: number, rows: number, els: readonly FloorElement[], teamExists: (id: string) => boolean): Record<string, string> {
  const errs: Record<string, string> = {};
  const add = (id: string, msg: string) => {
    if (!errs[id]) errs[id] = msg;
  };
  const codes = new Map<string, string>();
  const grid = new Map<string, FloorElement>();
  for (const e of els) {
    if (e.x < 0 || e.y < 0 || e.x + e.w > cols || e.y + e.h > rows) {
      add(e.id, `${e.kind} is outside the ${cols}×${rows} grid`);
      continue;
    }
    if (e.kind === "seat") {
      if (!e.code) add(e.id, "Seat needs a code");
      else if (!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(e.code)) add(e.id, "Seat codes use up to 16 capital letters, digits or dashes");
      else if (codes.has(e.code)) {
        add(e.id, `Seat ${e.code} is used twice`);
        add(codes.get(e.code) as string, `Seat ${e.code} is used twice`);
      } else codes.set(e.code, e.id);
      if (e.teamId && !teamExists(e.teamId)) add(e.id, "Unknown team");
    }
    if (e.kind === "label") continue;
    for (let dx = 0; dx < e.w; dx++) {
      for (let dy = 0; dy < e.h; dy++) {
        const key = `${e.x + dx},${e.y + dy}`;
        const other = grid.get(key);
        if (other && overlaps(other, e)) add(e.id, `${e.kind} overlaps ${other.kind} at ${e.x + dx},${e.y + dy}`);
        else if (!other) grid.set(key, e);
      }
    }
  }
  return errs;
}

export const firstName = (name: string) => name.split(" ")[0] ?? name;

/** How a seat is written for people: "Seat 12". */
export function seatLabel(code: string | null | undefined, empty = "—") {
  return code ? `Seat ${code}` : empty;
}

/** Name on a seat tile: the first name ("Asha"), or "A. Rai" style when the first part is just an initial. */
export function tileName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return name;
  if (parts[0].replace(/\./g, "").length <= 1 && parts.length > 1) return `${parts[0][0]}. ${parts.at(-1)}`;
  return parts[0];
}

/** Short tile name: "Asha R." */
export function shortName(name: string) {
  const parts = name.split(" ").filter(Boolean);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts.at(-1)?.[0]}.`;
}

export type NumberDirection = "ltr" | "rtl" | "ttb";
export const SEAT_CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

/**
 * Seat numbers for a selection: order the seats (row by row left→right,
 * right→left, or column by column top→bottom) and number them from `start`
 * (plain numbers unless a prefix or zero-padding is given). One code per seat id.
 */
export function sequenceCodes(
  seats: readonly Pick<FloorElement, "id" | "x" | "y">[],
  opts: { prefix?: string; start: number; digits?: number; direction: NumberDirection },
): { seatId: string; code: string }[] {
  const sorted = [...seats].sort((a, b) =>
    opts.direction === "ttb" ? a.x - b.x || a.y - b.y : a.y - b.y || (opts.direction === "rtl" ? b.x - a.x : a.x - b.x),
  );
  const prefix = (opts.prefix ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return sorted.map((s, i) => ({ seatId: s.id, code: `${prefix}${String(opts.start + i).padStart(Math.max(1, opts.digits ?? 1), "0")}` }));
}
