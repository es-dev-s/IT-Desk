"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  count?: number;
};

/** Radio group with arrow-key navigation. The active pill changes colour only, never position. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  iconOnly = false,
  collapseLabels = false,
  size = "sm",
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  label: string;
  className?: string;
  iconOnly?: boolean;
  /** Icons only when the nearest `@container` is under 600px (labels stay available to screen readers). */
  collapseLabels?: boolean;
  size?: "sm" | "md";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-neutral-900/[0.045] p-0.5", size === "md" ? "h-9" : "h-8", className)}
    >
      {options.map((opt, i) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={iconOnly ? opt.label : undefined}
            title={iconOnly || collapseLabels ? opt.label : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium outline-none transition-[background-color,color,box-shadow] duration-150",
              "focus-visible:ring-2 focus-visible:ring-accent/35",
              size === "md" ? "h-8" : "h-7",
              iconOnly ? "w-8 justify-center" : collapseLabels ? "px-3 @max-[600px]:w-9 @max-[600px]:justify-center @max-[600px]:px-0" : "px-3",
              active ? "bg-white text-neutral-900 shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_0.5px_rgb(0_0_0/0.06)]" : "text-neutral-500 hover:text-neutral-800",
            )}
          >
            {Icon ? <Icon className="size-4" /> : null}
            {iconOnly ? null : <span className={cn(collapseLabels && "@max-[600px]:sr-only")}>{opt.label}</span>}
            {opt.count !== undefined ? (
              <span className={cn("tnum text-xs", active ? "text-neutral-500" : "text-neutral-400")}>{opt.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
