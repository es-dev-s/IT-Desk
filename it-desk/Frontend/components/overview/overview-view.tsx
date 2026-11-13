"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { computeOverview, deviceCount, periodBounds, type ChartGrain, type Kpi, type RangeKind } from "@/lib/analytics";
import { formatRelative, formatShortDate, signed } from "@/lib/format";
import { cn, pluralize } from "@/lib/utils";
import { nowMs } from "@/lib/clock";
import { useCurrentTeam, useTeamMembers, useTransfers } from "@/store/selectors";
import { useWorkspace } from "@/store/workspace-provider";
import { useUI } from "@/store/ui-store";
import { buttonClass } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Card, CardHeader } from "@/components/ui/card";
import { IT_STATUS_LABEL, ItStatusGlyph } from "@/components/ui/status";
import { TransferTable, people } from "@/components/transfers/transfer-table";
import { EmptyTeamCard } from "./empty-team";
import { useRequests } from "@/store/requests-store";
import { CATEGORY_LABEL, isClosed, PRIORITY_LABEL, STATUS_LABEL, type ITRequest } from "@/lib/requests";

const RANGE_OPTIONS: { value: RangeKind; label: string }[] = [
  { value: "year", label: "Yearly" },
  { value: "month", label: "Monthly" },
  { value: "week", label: "Weekly" },
  { value: "day", label: "Daily" },
  { value: "range", label: "Range" },
];

const RANGE_COMPARE: Record<RangeKind, string> = {
  year: "vs previous year",
  month: "vs previous month",
  week: "vs previous week",
  day: "vs previous day",
  range: "vs previous period",
};

const CHART_TITLE: Record<ChartGrain, string> = {
  hour: "Movement by hour",
  day: "Movement by day",
  week: "Movement by week",
  month: "Movement by month",
};

const periodInputClass = "h-9 rounded-lg border border-line-strong bg-white px-2.5 text-[13px] font-medium text-neutral-800 outline-none focus-visible:ring-2 focus-visible:ring-accent/35";

function isoDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateFromInput(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function dateInputValue(kind: RangeKind, anchor: Date) {
  const y = anchor.getFullYear();
  const m = String(anchor.getMonth() + 1).padStart(2, "0");
  const d = String(anchor.getDate()).padStart(2, "0");
  if (kind === "year") return String(y);
  if (kind === "month") return `${y}-${m}`;
  return `${y}-${m}-${d}`;
}

function anchorFromInput(kind: RangeKind, value: string) {
  if (kind === "year") return new Date(Number(value), 0, 1);
  if (kind === "month") {
    const [y, m] = value.split("-").map(Number);
    return new Date(y, (m || 1) - 1, 1);
  }
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function OverviewView() {
  const allTransfers = useTransfers();
  const teamId = useWorkspace((s) => s.currentTeamId);
  const role = useWorkspace((s) => s.user.role);
  // Admin/IT get organisation-wide data from the API; narrow it to the team in focus ("" = All teams).
  const transfers = useMemo(
    () => (teamId ? allTransfers.filter((t) => t.fromTeamId === teamId || t.toTeamId === teamId) : allTransfers),
    [allTransfers, teamId],
  );
  const syncedAt = useWorkspace((s) => s.lastSyncedAt);
  const [kind, setKind] = useState<RangeKind>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [from, setFrom] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [to, setTo] = useState(() => new Date());
  const bounds = useMemo(() => periodBounds(kind, anchor, { from, to }), [kind, anchor, from, to]);
  const o = useMemo(() => computeOverview(transfers, teamId, nowMs(), bounds), [transfers, teamId, syncedAt, bounds]); // eslint-disable-line react-hooks/exhaustive-deps
  const inPeriod = useCallback((iso: string) => {
    const t = Date.parse(iso);
    return t >= bounds.start && t < bounds.end;
  }, [bounds]);
  const recent = useMemo(() => [...transfers].filter((t) => inPeriod(t.createdAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [transfers, inPeriod]);
  const open = recent.filter((t) => t.itStatus !== "completed");
  const team = useCurrentTeam();
  const roster = useTeamMembers();
  // Admins receive organisation-wide transfers, so only count moves touching the team in focus.
  // IT requests (Request IT) are the bulk of the work IT carries; transfers alone left these cards at 0.
  const requests = useRequests((s) => s.items);
  const rangedRequests = useMemo(
    // Leads are already scoped by the API; for admin/IT narrow to the team in focus.
    () => (requests ?? []).filter((r) => inPeriod(r.createdAt) && (!teamId || role === "team_lead" || r.teamId === teamId)),
    [requests, inPeriod, teamId, role],
  );
  const openRequests = useMemo(() => rangedRequests.filter((r) => !isClosed(r.status)), [rangedRequests]);
  const reqOpen = rangedRequests.filter((r) => r.status === "open").length;
  const reqActive = rangedRequests.filter((r) => r.status === "in_progress").length;
  const reqResolved = rangedRequests.filter((r) => r.status === "resolved").length;
  const reqIssues = openRequests.filter((r) => r.type === "issue").length;
  const pendingTotal = o.pending.requests + reqOpen + reqActive;
  const isEmptyTeam =
    Boolean(team) && roster.length === 0 && !recent.some((t) => t.fromTeamId === team?.id || t.toTeamId === team?.id);

  return (
    <>
      <h1 className="sr-only">Overview</h1>
      {isEmptyTeam && team ? <EmptyTeamCard team={team} /> : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented label="Date range" size="md" value={kind} onChange={(v) => { setKind(v); if (v !== "range") setAnchor(new Date()); }} options={RANGE_OPTIONS} />
        {kind === "range" ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-medium text-neutral-500">
              From
              <input
                type="date"
                aria-label="From"
                value={isoDate(from)}
                max={isoDate(to)}
                onChange={(e) => {
                  const next = dateFromInput(e.target.value);
                  if (next) setFrom(next);
                }}
                className={periodInputClass}
              />
            </label>
            <label className="flex items-center gap-2 text-xs font-medium text-neutral-500">
              To
              <input
                type="date"
                aria-label="To"
                value={isoDate(to)}
                min={isoDate(from)}
                onChange={(e) => {
                  const next = dateFromInput(e.target.value);
                  if (next) setTo(next);
                }}
                className={periodInputClass}
              />
            </label>
          </div>
        ) : (
          <label className="ml-auto flex items-center gap-2 text-xs font-medium text-neutral-500">
            {kind === "year" ? "Year" : kind === "month" ? "Month" : kind === "week" ? "Week of" : "Day"}
            <input
              type={kind === "year" ? "number" : kind === "month" ? "month" : "date"}
              min={kind === "year" ? 2000 : undefined}
              max={kind === "year" ? 2100 : undefined}
              value={dateInputValue(kind, anchor)}
              onChange={(e) => {
                if (!e.target.value) return;
                setAnchor(anchorFromInput(kind, e.target.value));
              }}
              className={periodInputClass}
              aria-label="Period"
            />
          </label>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric label="New Employee" kpi={o.movedIn} compare={RANGE_COMPARE[kind]} />
        <Metric label="Team Transfer" kpi={o.movedOut} compare={RANGE_COMPARE[kind]} />
        <Metric label="Seat moves" kpi={o.seatMoves} compare={RANGE_COMPARE[kind]} />
        <div className="rounded-card border border-line bg-white p-4 shadow-xs sm:p-5">
          <p className="text-[13px] text-neutral-500">Pending with IT</p>
          <p className="tnum mt-2 text-[28px] font-semibold leading-none sm:text-[32px] tracking-[-0.03em] text-neutral-900">{pendingTotal}</p>
          <p className="tnum mt-3 text-xs text-neutral-500">
            {reqOpen} open · {reqActive} in progress{reqIssues ? ` · incl. ${pluralize(reqIssues, "issue")}` : ""} · {pluralize(o.pending.requests, "move")}
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-5">
        <WeeklyChart
          weekly={o.weekly}
          className="xl:col-span-3"
          title={CHART_TITLE[bounds.grain]}
          empty={kind === "range" ? "No movement in this range" : kind === "day" ? "No movement on this day" : kind === "week" ? "No movement this week" : kind === "month" ? "No movement this month" : "No movement this year"}
        />
        <Card className="flex flex-col xl:col-span-2">
          <CardHeader
            title="IT work"
            description="Open requests, reported issues and device moves"
            action={
              <Link href="/requests" className={buttonClass("ghost", "sm")}>
                Requests
              </Link>
            }
          />
          <div className="grid grid-cols-4 gap-px border-y border-line bg-line">
            {[
              { label: "Open", value: reqOpen },
              { label: "In progress", value: reqActive },
              { label: "Resolved", value: reqResolved },
              { label: "Device moves", value: o.pending.requests },
            ].map((c) => (
              <div key={c.label} className="bg-white px-4 py-3">
                <p className="tnum text-xl font-semibold tracking-[-0.02em]">{c.value}</p>
                <p className="mt-0.5 truncate text-xs text-neutral-500">{c.label}</p>
              </div>
            ))}
          </div>
          <RequestList items={openRequests.slice(0, 5)} />
          {open.length || !openRequests.length ? <QueueList items={open.slice(0, 5)} /> : null}
        </Card>
      </div>

      <Card className="mt-3 overflow-hidden">
        <CardHeader
          title="Recent activity"
          description="Who moved, where, and what IT carried"
          action={
            <Link href="/transfers" className={buttonClass("ghost", "sm")}>
              View all
            </Link>
          }
        />
        {recent.length ? (
          <TransferTable transfers={recent.slice(0, 8)} />
        ) : (
          <p className="border-t border-line px-5 py-10 text-center text-[13px] text-neutral-500">
            No transfers yet. Moves in, out and between seats will show up here.
          </p>
        )}
      </Card>
    </>
  );
}

function Metric({ label, kpi, compare }: { label: string; kpi: Kpi; compare: string }) {
  const delta = kpi.current - kpi.previous;
  return (
    <div className="rounded-card border border-line bg-white p-4 shadow-xs sm:p-5">
      <p className="text-[13px] text-neutral-500">{label}</p>
      <p className="tnum mt-2 text-[28px] font-semibold leading-none sm:text-[32px] tracking-[-0.03em] text-neutral-900">{kpi.current}</p>
      <p className="tnum mt-3 text-xs text-neutral-500">
        <span className={cn("font-medium", delta > 0 ? "text-accent-ink" : "text-neutral-700")}>{signed(delta)}</span> {compare}
      </p>
    </div>
  );
}

function RequestList({ items }: { items: ITRequest[] }) {
  const openDetail = useRequests((s) => s.openDetail);
  if (!items.length) return null;
  return (
    <ul className="divide-y divide-line">
      {items.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => openDetail(r.id)}
            className="flex h-14 w-full items-center gap-3 px-5 text-left outline-none transition-colors duration-150 hover:bg-neutral-50 focus-visible:bg-accent-soft/50"
          >
            <span className={cn("size-2 shrink-0 rounded-full", r.status === "in_progress" ? "bg-accent-strong" : "bg-neutral-300")} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-neutral-900">
                {r.forMemberName || r.teamName || r.requesterName}
              </span>
              <span className="tnum block truncate text-xs text-neutral-500">
                {r.ticket} · {STATUS_LABEL[r.status]} · {PRIORITY_LABEL[r.priority]} ·{" "}
                {r.type === "issue"
                  ? `${r.category ? CATEGORY_LABEL[r.category] : "IT"} issue: ${r.title}`
                  : pluralize(r.items.reduce((n, i) => n + i.quantity, 0), "item")}
                {r.assigneeName || r.staffName ? ` · → ${r.assigneeName ?? r.staffName}` : ""}
              </span>
            </span>
            <span className="tnum shrink-0 text-xs text-neutral-400">{formatRelative(r.createdAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function QueueList({ items }: { items: ReturnType<typeof useTransfers> }) {
  const openDetail = useUI((s) => s.openDetail);
  if (!items.length) return <p className="px-5 py-10 text-center text-[13px] text-neutral-500">Nothing waiting on IT.</p>;
  return (
    <ul className="flex-1 divide-y divide-line">
      {items.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => openDetail(t.id)}
            className="flex h-14 w-full items-center gap-3 px-5 text-left outline-none transition-colors duration-150 hover:bg-neutral-50 focus-visible:bg-accent-soft/50"
          >
            <ItStatusGlyph status={t.itStatus} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-neutral-900">{people(t)}</span>
              <span className="tnum block truncate text-xs text-neutral-500">
                {t.ticket} · {IT_STATUS_LABEL[t.itStatus]} · {pluralize(deviceCount(t), "device")}
              </span>
            </span>
            <span className="tnum shrink-0 text-xs text-neutral-400">{formatRelative(t.createdAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function WeeklyChart({ weekly, className, empty, title }: { weekly: { start: number; label: string; in: number; out: number; internal: number }[]; className?: string; empty: string; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(4, ...weekly.map((w) => w.in + w.out + w.internal));
  const ceiling = Math.ceil(max / 2) * 2;
  const shown = hover === null ? null : weekly[hover];
  const totals = weekly.reduce((a, w) => ({ in: a.in + w.in, out: a.out + w.out, internal: a.internal + w.internal }), { in: 0, out: 0, internal: 0 });
  const series = [
    { key: "in", label: "New", cls: "bg-accent-strong" },
    { key: "out", label: "Transfer", cls: "bg-neutral-800" },
    { key: "internal", label: "Seat moves", cls: "bg-neutral-300" },
  ] as const;
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader
        title={title}
        description={shown ? shown.label || formatShortDate(new Date(shown.start).toISOString()) : "Selected period"}
        action={
          <div className="flex gap-4 text-xs text-neutral-500">
            {series.map((s) => (
              <span key={s.key} className="tnum inline-flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", s.cls)} />
                {s.label} <span className="font-medium text-neutral-800">{shown ? shown[s.key] : totals[s.key]}</span>
              </span>
            ))}
          </div>
        }
        className="flex-wrap"
      />
      <div className="relative mx-5 mb-5 h-[220px] flex-1" onMouseLeave={() => setHover(null)}>
        {totals.in + totals.out + totals.internal === 0 ? (
          <p className="absolute inset-0 z-10 grid place-items-center text-[13px] text-neutral-400">{empty}</p>
        ) : null}
        {[0, 0.5, 1].map((p) => (
          <div key={p} className="absolute inset-x-0 border-t border-dashed border-line" style={{ bottom: `${p * 100}%` }}>
            <span className="tnum absolute -top-2 right-0 bg-white pl-1 text-[10px] text-neutral-400">{Math.round(ceiling * p) || ""}</span>
          </div>
        ))}
        <div className={cn("absolute inset-0 bottom-0 right-6 flex items-end", weekly.length > 16 ? "gap-px" : weekly.length > 8 ? "gap-1" : "gap-[6%]")}>
          {weekly.map((w, i) => (
            <div
              key={w.start}
              onMouseEnter={() => setHover(i)}
              className="flex h-full flex-1 flex-col justify-end"
              aria-label={`${w.label || formatShortDate(new Date(w.start).toISOString())}: ${w.in} new, ${w.out} transferred, ${w.internal} seat moves`}
              role="img"
            >
              <div className={cn("flex flex-col-reverse overflow-hidden rounded-[4px] transition-opacity duration-150", hover !== null && hover !== i && "opacity-40")}>
                {series.map((s) =>
                  w[s.key] ? <div key={s.key} className={cn(s.cls, "border-t border-white first:border-t-0")} style={{ height: `${(w[s.key] / ceiling) * 220}px` }} /> : null,
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
