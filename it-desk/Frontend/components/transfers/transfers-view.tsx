"use client";

import { ArrowLeftRight, Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { ACTIVITY_PAGE_SIZE } from "@/lib/constants";
import { dayKey, formatDate, formatShortDate } from "@/lib/format";
import type { Direction } from "@/lib/schemas";
import { useExits, useTransfers } from "@/store/selectors";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClass } from "@/components/ui/field";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { SelectField } from "@/components/ui/select";
import { FilterRow, FiltersPopover, Toolbar, useElementWidth } from "@/components/ui/toolbar";
import { MemberStatusDot } from "@/components/ui/status";
import { TransferTable } from "./transfer-table";

const typeOptions = [
  { value: "all", label: "All" },
  { value: "in", label: "In" },
  { value: "out", label: "Out" },
  { value: "internal", label: "Seat moves" },
] as const;

const statusOptions = [
  { value: "all", label: "Any status" },
  { value: "open", label: "Open" },
  { value: "requested", label: "Requested" },
  { value: "scheduled", label: "IT scheduled" },
  { value: "moved", label: "Devices moved" },
  { value: "completed", label: "Completed" },
];

const emptyRange = { startDate: "", endDate: "" };
const formatDay = (day: string) => formatDate(`${day}T00:00:00Z`);

export function TransfersView() {
  const transfers = useTransfers();
  const exits = useExits();
  const [direction, setDirection] = useState<"all" | Direction>("all");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [draftRange, setDraftRange] = useState(emptyRange);
  const [range, setRange] = useState(emptyRange);
  const [visible, setVisible] = useState(ACTIVITY_PAGE_SIZE);
  const [toolbarRef, toolbarWidth] = useElementWidth<HTMLDivElement>();
  const changeDirection = (d: "all" | Direction) => { setDirection(d); setVisible(ACTIVITY_PAGE_SIZE); };
  const changeStatus = (v: string) => { setStatus(v); setVisible(ACTIVITY_PAGE_SIZE); };
  const clearDates = () => { setDraftRange(emptyRange); setRange(emptyRange); setVisible(ACTIVITY_PAGE_SIZE); };
  const rangeReversed = Boolean(draftRange.startDate && draftRange.endDate && draftRange.startDate > draftRange.endDate);
  const canApply = Boolean(draftRange.startDate && draftRange.endDate && !rangeReversed &&
    (draftRange.startDate !== range.startDate || draftRange.endDate !== range.endDate));

  const datedTransfers = useMemo(() => {
    if (!range.startDate) return transfers;
    return transfers.filter((t) => {
      const day = dayKey(Date.parse(t.createdAt));
      return day >= range.startDate && day <= range.endDate;
    });
  }, [transfers, range]);

  const counts = useMemo(() => {
    const c = { all: datedTransfers.length, in: 0, out: 0, internal: 0 };
    for (const t of datedTransfers) c[t.direction] += 1;
    return c;
  }, [datedTransfers]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return datedTransfers
      .filter((t) => direction === "all" || t.direction === direction)
      .filter((t) => (status === "all" ? true : status === "open" ? t.itStatus !== "completed" : t.itStatus === status))
      .filter((t) => !q || `${t.ticket} ${t.moves.map((m) => `${m.memberName} ${m.fromSeat} ${m.toSeat}`).join(" ")}`.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [datedTransfers, direction, status, query]);

  return (
    <>
      <h1 className="sr-only">Transfers</h1>
      {/* One-row toolbar: Type inline from 700px, IT status inline from 920px; the rest lives in Filters. */}
      <Toolbar ref={toolbarRef} label="Transfer tools" className="mb-4">
        <SearchField
          size="md"
          className="min-w-0 flex-1 @min-[700px]:max-w-72"
          value={query}
          onChange={(v) => { setQuery(v); setVisible(ACTIVITY_PAGE_SIZE); }}
          label="Search transfers"
          placeholder="Ticket, person or seat"
        />
        <Segmented
          size="md"
          className="hidden @min-[700px]:inline-flex"
          label="Type"
          value={direction}
          onChange={changeDirection}
          options={typeOptions.map((o) => ({ ...o, count: counts[o.value] }))}
        />
        <SelectField
          size="md"
          className="ml-auto hidden @min-[920px]:inline-flex"
          label="IT status"
          value={status}
          onValueChange={changeStatus}
          options={statusOptions}
        />
        <div className="ml-auto shrink-0 @min-[920px]:hidden">
          <FiltersPopover
            labelClassName="@max-[480px]:sr-only"
            canReset={direction !== "all" || status !== "all"}
            onReset={() => { changeDirection("all"); changeStatus("all"); }}
            tiers={[
              { value: +(direction !== "all") + +(status !== "all"), className: "grid @min-[700px]:hidden" },
              { value: +(status !== "all"), className: "hidden @min-[700px]:grid" },
            ]}
          >
            {(toolbarWidth ?? 0) >= 700 ? null : (
              <FilterRow label="Type">
                <SelectField
                  size="md"
                  className="w-full"
                  label="Type"
                  value={direction}
                  onValueChange={(v) => changeDirection(v as "all" | Direction)}
                  options={typeOptions.map((o) => ({ value: o.value, label: `${o.label} · ${counts[o.value]}` }))}
                />
              </FilterRow>
            )}
            <FilterRow label="IT status">
              <SelectField size="md" className="w-full" label="IT status" value={status} onValueChange={changeStatus} options={statusOptions} />
            </FilterRow>
          </FiltersPopover>
        </div>
      </Toolbar>

      <form
        aria-label="Date range filter"
        className="mb-4 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canApply) return;
          setRange(draftRange);
          setVisible(ACTIVITY_PAGE_SIZE);
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs font-medium text-neutral-600">
            Start date
            <input
              type="date"
              className={inputClass}
              required
              min="0001-01-01"
              max="9999-12-31"
              value={draftRange.startDate}
              onChange={(event) => setDraftRange({ ...draftRange, startDate: event.target.value })}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-neutral-600">
            End date
            <input
              type="date"
              className={inputClass}
              required
              min="0001-01-01"
              max="9999-12-31"
              aria-invalid={rangeReversed || undefined}
              aria-describedby={rangeReversed ? "transfer-date-range-error" : undefined}
              value={draftRange.endDate}
              onChange={(event) => setDraftRange({ ...draftRange, endDate: event.target.value })}
            />
          </label>
          <Button type="submit" variant="primary" disabled={!canApply}>Apply dates</Button>
          {draftRange.startDate || draftRange.endDate || range.startDate ? (
            <Button variant="ghost" onClick={clearDates}>Clear dates</Button>
          ) : null}
        </div>
        {rangeReversed ? (
          <p id="transfer-date-range-error" role="alert" className="text-xs text-red-600">End date must be on or after the start date.</p>
        ) : null}
        <p className="text-xs text-neutral-500" aria-live="polite">
          {range.startDate
            ? `Showing transfers created from ${formatDay(range.startDate)} to ${formatDay(range.endDate)} (Nepal Time).`
            : "Filter by the date the transfer was created (Nepal Time)."}
        </p>
      </form>

      <Card className="overflow-hidden">
        {rows.length ? (
          <TransferTable transfers={rows.slice(0, visible)} className="[&_thead_tr]:border-t-0" />
        ) : (
          transfers.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title="No transfers yet"
              description="Seat moves and team transfers show up here the moment they’re created, with IT’s progress updating live."
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="No transfers match"
              description="Try a different date range, type, status, or search."
              action={
                <Button size="sm" onClick={() => { changeDirection("all"); changeStatus("all"); setQuery(""); clearDates(); }}>
                  Clear filters
                </Button>
              }
            />
          )
        )}
        {rows.length > visible ? (
          <div className="flex items-center justify-between border-t border-line px-5 py-3">
            <p className="tnum text-xs text-neutral-500">{visible} of {rows.length}</p>
            <Button size="sm" onClick={() => setVisible((v) => v + ACTIVITY_PAGE_SIZE)}>Show more</Button>
          </div>
        ) : null}
      </Card>

      <Card className="mt-8 overflow-hidden">
        <CardHeader title="Exits" description="People marked resigned or unknown. Their seats were released." />
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead>
              <tr className="h-10 border-y border-line bg-subtle text-xs text-neutral-500 [&>th]:px-5 [&>th]:font-medium">
                <th>Name</th>
                <th>Status</th>
                <th>Seat</th>
                <th>Reason</th>
                <th className="w-[96px]">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {exits.map((e) => (
                <tr key={e.id} className="h-12 [&>td]:px-5">
                  <td className="font-medium text-neutral-900">{e.memberName}</td>
                  <td><MemberStatusDot status={e.status} /></td>
                  <td className="tnum font-mono text-xs text-neutral-500">{e.seat ?? "—"}</td>
                  <td className="max-w-[320px] truncate text-neutral-600">{e.reason}</td>
                  <td className="tnum text-neutral-500">{formatShortDate(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
