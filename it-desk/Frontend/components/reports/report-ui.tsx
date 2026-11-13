"use client";

import { AlertCircle, FileSpreadsheet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button, buttonClass } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Debounced copy of a fast-changing value (the search box). */
export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Loads a report whenever `key` changes. Keeps the previous rows on screen
 * while the next ones load, and drops answers that arrive out of order.
 */
export function useReport<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    const ctl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    setLoading(true);
    loadRef.current(ctl.signal).then(
      (d) => {
        if (ctl.signal.aborted) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(e instanceof ApiError ? e.message : "Couldn’t load the report. Check your connection and try again.");
        setLoading(false);
      },
    );
    return () => ctl.abort();
  }, [key, attempt]);
  return { data, error, loading, retry: () => setAttempt((n) => n + 1) };
}

export function ExportButton({ href, disabled }: { href: string; disabled?: boolean }) {
  if (disabled)
    return (
      <Button variant="secondary" disabled data-testid="report-export">
        <FileSpreadsheet /> Export to Excel
      </Button>
    );
  return (
    <a href={href} download className={buttonClass("secondary", "md")} data-testid="report-export">
      <FileSpreadsheet /> Export to Excel
    </a>
  );
}

export type Column<T> = { key: string; title: string; className?: string; cell: (row: T) => React.ReactNode };

/** Spreadsheet-style grid: numbered rows, ruled cells and a header that stays put while scrolling. */
export function ReportTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  empty,
  label,
  minWidth = 760,
}: {
  columns: Column<T>[];
  rows: T[] | null;
  rowKey: (row: T, index: number) => string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  empty: string;
  label: string;
  minWidth?: number;
}) {
  if (error && !rows)
    return (
      <div className="rounded-card border border-line bg-white px-6 py-12 text-center shadow-xs" role="alert">
        <AlertCircle className="mx-auto size-6 text-red-500" aria-hidden />
        <p className="mt-3 text-[13px] text-neutral-600">{error}</p>
        <Button size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (!rows) return <Skeleton className="h-[50dvh] rounded-card" />;
  return (
    <div
      className={cn("scrollbar-thin max-h-[calc(100dvh-15rem)] min-h-40 overflow-auto rounded-card border border-line-strong bg-white shadow-xs transition-opacity", loading && "opacity-60")}
      aria-busy={loading}
    >
      <table className="w-full border-separate border-spacing-0 text-left text-[13px]" style={{ minWidth }} aria-label={label} data-testid="report-table">
        <thead>
          <tr>
            <th scope="col" className="sticky top-0 z-10 w-11 border-b border-r border-line-strong bg-neutral-100 px-2 py-2 text-center text-[11px] font-medium text-neutral-500">
              #
            </th>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn("sticky top-0 z-10 whitespace-nowrap border-b border-r border-line-strong bg-neutral-100 px-3 py-2 text-xs font-semibold text-neutral-800 last:border-r-0", c.className)}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)} className="hover:bg-accent-soft/40">
              <td className="tnum border-b border-r border-line bg-neutral-50 px-2 py-1.5 text-center text-[11px] text-neutral-400">{i + 1}</td>
              {columns.map((c) => (
                <td key={c.key} className={cn("border-b border-r border-line px-3 py-1.5 align-top text-neutral-800 last:border-r-0", c.className)}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + 1} className="px-6 py-12 text-center text-[13px] text-neutral-500" data-testid="report-empty">
                {empty}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export const Blank = () => <span className="text-neutral-300">—</span>;
