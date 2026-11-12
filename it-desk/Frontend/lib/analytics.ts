import { DAY_MS, IT_STATUSES } from "./constants";
import type { Direction, ItStatus, Transfer } from "./schemas";

export const WINDOW_DAYS = 90;
export const WEEKS = 12;

export type Kpi = { current: number; previous: number };

export type OverviewBucket = { start: number; label: string; in: number; out: number; internal: number };

export type Overview = {
  movedIn: Kpi;
  movedOut: Kpi;
  seatMoves: Kpi;
  pending: { requests: number; devices: number; members: number };
  weekly: OverviewBucket[];
  pipeline: Record<ItStatus, number>;
  counterparts: { teamId: string; in: number; out: number }[];
};

/** The overview date control. Weeks start on Monday, in the viewer's local time. */
export type RangeKind = "year" | "month" | "week" | "day" | "range";

/** How the chart splits the selected period. */
export type ChartGrain = "hour" | "day" | "week" | "month";

export type OverviewBounds = {
  start: number;
  end: number;
  previousStart: number;
  grain: ChartGrain;
  buckets: { start: number; end: number; label: string }[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday 00:00 of the week containing `d`. */
function startOfWeek(d: Date) {
  const s = startOfDay(d);
  const day = s.getDay();
  return addDays(s, day === 0 ? -6 : 1 - day);
}

/** Inclusive local dates for the custom range option. */
export type DateSpan = { from: Date; to: Date };

function dayBuckets(start: Date, end: Date): OverviewBounds["buckets"] {
  const buckets: OverviewBounds["buckets"] = [];
  for (let d = new Date(start); d < end; d = addDays(d, 1)) {
    const next = addDays(d, 1);
    buckets.push({
      start: d.getTime(),
      end: Math.min(next.getTime(), end.getTime()),
      label: `${d.getDate()} ${MONTHS[d.getMonth()]}`,
    });
  }
  return buckets;
}

function weekBuckets(start: Date, end: Date): OverviewBounds["buckets"] {
  const buckets: OverviewBounds["buckets"] = [];
  for (let d = new Date(start); d < end; d = addDays(d, 7)) {
    const next = addDays(d, 7);
    buckets.push({
      start: d.getTime(),
      end: Math.min(next.getTime(), end.getTime()),
      label: `${d.getDate()} ${MONTHS[d.getMonth()]}`,
    });
  }
  return buckets;
}

function monthBuckets(start: Date, end: Date): OverviewBounds["buckets"] {
  const buckets: OverviewBounds["buckets"] = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const nextMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const bucketEnd = nextMonth < end ? nextMonth : end;
    buckets.push({ start: cursor.getTime(), end: bucketEnd.getTime(), label: `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}` });
    cursor = bucketEnd;
  }
  return buckets;
}

function hourBuckets(start: Date): OverviewBounds["buckets"] {
  const buckets: OverviewBounds["buckets"] = [];
  for (let h = 0; h < 24; h++) {
    const b = new Date(start);
    b.setHours(h);
    const n = new Date(start);
    n.setHours(h + 1);
    buckets.push({ start: b.getTime(), end: n.getTime(), label: `${String(h).padStart(2, "0")}:00` });
  }
  return buckets;
}

/** From and to are inclusive calendar days. The comparison window is the same length just before. */
function customRange(from: Date, to: Date): OverviewBounds {
  let start = startOfDay(from);
  let last = startOfDay(to);
  if (last < start) [start, last] = [last, start];
  const end = addDays(last, 1);
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const grain: ChartGrain = days <= 1 ? "hour" : days <= 31 ? "day" : days <= 120 ? "week" : "month";
  const buckets = grain === "hour" ? hourBuckets(start) : grain === "day" ? dayBuckets(start, end) : grain === "week" ? weekBuckets(start, end) : monthBuckets(start, end);
  return { start: start.getTime(), end: end.getTime(), previousStart: start.getTime() - (end.getTime() - start.getTime()), grain, buckets };
}

/** Current and previous period, plus the chart buckets inside the current one. */
export function periodBounds(kind: RangeKind, anchor: Date, span?: DateSpan): OverviewBounds {
  if (kind === "range") return customRange(span?.from ?? anchor, span?.to ?? anchor);
  let start: Date;
  let end: Date;
  let previous: Date;
  const buckets: OverviewBounds["buckets"] = [];
  if (kind === "year") {
    start = new Date(anchor.getFullYear(), 0, 1);
    end = new Date(anchor.getFullYear() + 1, 0, 1);
    previous = new Date(anchor.getFullYear() - 1, 0, 1);
    for (let m = 0; m < 12; m++) {
      const b = new Date(start.getFullYear(), m, 1);
      buckets.push({ start: b.getTime(), end: new Date(start.getFullYear(), m + 1, 1).getTime(), label: MONTHS[m] });
    }
  } else if (kind === "month") {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    previous = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
    for (let d = new Date(start); d < end; d = addDays(d, 1)) {
      const n = addDays(d, 1);
      buckets.push({ start: d.getTime(), end: n.getTime(), label: String(d.getDate()) });
    }
  } else if (kind === "week") {
    start = startOfWeek(anchor);
    end = addDays(start, 7);
    previous = addDays(start, -7);
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      buckets.push({ start: d.getTime(), end: addDays(d, 1).getTime(), label: WEEKDAYS[i] });
    }
  } else {
    start = startOfDay(anchor);
    end = addDays(start, 1);
    previous = addDays(start, -1);
    buckets.push(...hourBuckets(start));
  }
  const grain: ChartGrain = kind === "year" ? "month" : kind === "day" ? "hour" : "day";
  return { start: start.getTime(), end: end.getTime(), previousStart: previous.getTime(), grain, buckets };
}

/**
 * KPIs relative to `now` (the server-anchored clock). With `bounds`, every card
 * and the chart use that period and the period of the same length just before it.
 * Without it, the window is the last 90 days against the 90 before that.
 */
export function computeOverview(transfers: readonly Transfer[], currentTeamId: string, now: number, bounds?: OverviewBounds): Overview {
  const ageDays = (iso: string) => Math.max(0, (now - Date.parse(iso)) / DAY_MS);
  const kpi = (): Kpi => ({ current: 0, previous: 0 });
  const totals: Record<Direction, Kpi> = { in: kpi(), out: kpi(), internal: kpi() };
  const pipeline = Object.fromEntries(IT_STATUSES.map((s) => [s, 0])) as Record<ItStatus, number>;
  const pending = { requests: 0, devices: 0, members: 0 };
  const weekly: OverviewBucket[] = bounds
    ? bounds.buckets.map((b) => ({ start: b.start, label: b.label, in: 0, out: 0, internal: 0 }))
    : Array.from({ length: WEEKS }, (_, i) => ({
        start: now - (WEEKS - i) * 7 * DAY_MS,
        label: "",
        in: 0,
        out: 0,
        internal: 0,
      }));
  const counterparts = new Map<string, { teamId: string; in: number; out: number }>();

  for (const t of transfers) {
    const at = Date.parse(t.createdAt);
    const age = ageDays(t.createdAt);
    const n = t.moves.length;
    const inCurrent = bounds ? at >= bounds.start && at < bounds.end : age < WINDOW_DAYS;
    const inPrevious = bounds ? at >= bounds.previousStart && at < bounds.start : age >= WINDOW_DAYS && age < WINDOW_DAYS * 2;
    if (inCurrent) totals[t.direction].current += n;
    else if (inPrevious) totals[t.direction].previous += n;

    if (bounds) {
      const i = bounds.buckets.findIndex((b) => at >= b.start && at < b.end);
      if (i >= 0) weekly[i][t.direction] += n;
    } else {
      const week = WEEKS - 1 - Math.floor(age / 7);
      if (week >= 0 && week < WEEKS) weekly[week][t.direction] += n;
    }

    if (!bounds || inCurrent) pipeline[t.itStatus] += 1;
    if (t.itStatus !== "completed" && (!bounds || inCurrent)) {
      pending.requests += 1;
      pending.members += n;
      pending.devices += t.moves.reduce((sum, mv) => sum + mv.devices.length, 0);
    }

    if (t.direction !== "internal" && inCurrent) {
      const teamId = t.direction === "in" ? t.fromTeamId : t.toTeamId;
      if (teamId !== currentTeamId) {
        const row = counterparts.get(teamId) ?? { teamId, in: 0, out: 0 };
        row[t.direction] += n;
        counterparts.set(teamId, row);
      }
    }
  }

  return {
    movedIn: totals.in,
    movedOut: totals.out,
    seatMoves: totals.internal,
    pending,
    weekly,
    pipeline,
    counterparts: [...counterparts.values()].sort((a, b) => b.in + b.out - (a.in + a.out)),
  };
}

export const deviceCount = (t: Transfer) => t.moves.reduce((sum, mv) => sum + mv.devices.length, 0);
