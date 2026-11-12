"use client";

import * as Popover from "@radix-ui/react-popover";
import { ListFilter } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * One-row page toolbar. The outer element is a CSS container, so children decide
 * what to show with container queries (`@min-[920px]:…`) — layout never waits for JS
 * and never wraps. Controls are 36px tall.
 */
export function Toolbar({
  label,
  className,
  children,
  ref,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} className={cn("@container", className)} data-toolbar>
      <div role="group" aria-label={label} className="flex h-9 min-w-0 flex-nowrap items-center gap-2">
        {children}
      </div>
    </div>
  );
}

export function ToolbarDivider({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mx-0.5 h-5 w-px shrink-0 bg-line-strong", className)} />;
}

/** Width of an element, for deciding what goes inside popovers (which live outside the container). */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export type BadgeTier = { value: number; className: string };

/**
 * "Filters" button + popover for controls that don't fit inline. The badge counts
 * non-default filters *inside* the popover; tiers let the count follow the same
 * container breakpoints as the inline controls (pure CSS, so no flicker).
 */
export function FiltersPopover({
  tiers,
  canReset,
  onReset,
  labelClassName,
  children,
}: {
  tiers: BadgeTier[];
  canReset: boolean;
  onReset: () => void;
  labelClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Filters"
        className={cn(
          "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-white px-2.5 text-[13px] font-medium text-neutral-700 shadow-xs outline-none transition-colors duration-150",
          "hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-accent/35 data-[state=open]:border-accent-line data-[state=open]:bg-accent-soft data-[state=open]:text-accent-ink",
        )}
      >
        <ListFilter className="size-4" aria-hidden />
        <span className={labelClassName}>Filters</span>
        {tiers.map((t, i) =>
          t.value > 0 ? (
            <span
              key={i}
              aria-label={`${t.value} active`}
              className={cn("tnum h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] font-semibold leading-none text-white", t.className)}
            >
              {t.value}
            </span>
          ) : null,
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-[60] w-[min(300px,calc(100vw-24px))] rounded-xl bg-white p-1.5 shadow-pop outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in"
        >
          <div className="flex h-8 items-center justify-between pl-2.5 pr-1">
            <p className="text-xs font-medium text-neutral-500">Filters</p>
            <button
              type="button"
              disabled={!canReset}
              onClick={onReset}
              className="rounded-md px-1.5 py-1 text-xs font-medium text-accent-ink outline-none transition-opacity hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent/35 disabled:pointer-events-none disabled:opacity-0"
            >
              Reset
            </button>
          </div>
          <div className="space-y-1 px-1 pb-1">{children}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Label + full-width control row used inside FiltersPopover. */
export function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-center gap-2 rounded-lg px-1.5 py-1">
      <span className="text-[13px] text-neutral-500">{label}</span>
      {children}
    </div>
  );
}
