"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ScrollTab = { id: string; label: ReactNode; title?: string; testId?: string; data?: Record<string, string> };

/**
 * Premium pill tabs in a horizontal scroller: equal-height segments, a soft
 * white active pill with an accent underline, fading edges and a thin
 * scrollbar only when they overflow, the active tab kept in view, and
 * ←/→/Home/End keyboard navigation (roving tabindex).
 */
export function ScrollTabs({
  tabs,
  active,
  onChange,
  label,
  className,
  testId,
  tabTestId,
}: {
  tabs: ScrollTab[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  className?: string;
  testId?: string;
  tabTestId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<"" | "start" | "end" | "both">("");
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFade(start && end ? "both" : start ? "start" : end ? "end" : "");
  }, []);
  useLayoutEffect(measure, [measure, tabs.length]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  useEffect(() => {
    const btn = ref.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`);
    btn?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === active);
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = tabs.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(tabs[j].id);
    ref.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabs[j].id)}"]`)?.focus();
  };

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      onScroll={measure}
      onKeyDown={onKey}
      data-fade={fade || undefined}
      data-testid={testId}
      className={cn(
        "scrollbar-slim fade-x flex min-w-0 items-center gap-1 overflow-x-auto rounded-xl border border-black/[0.06] bg-neutral-100/80 p-1",
        fade && "pb-[3px]",
        className,
      )}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            title={t.title}
            data-tab-id={t.id}
            data-testid={t.testId ?? tabTestId}
            {...Object.fromEntries(Object.entries(t.data ?? {}).map(([k, v]) => [`data-${k}`, v]))}
            onClick={() => onChange(t.id)}
            className={cn(
              "relative flex h-8 flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[12.5px] font-medium outline-none transition-[background-color,color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-accent/35",
              on
                ? "bg-white text-neutral-900 shadow-[0_1px_2px_rgb(0_0_0/0.07),0_0_0_0.5px_rgb(0_0_0/0.07)] after:absolute after:inset-x-3 after:bottom-[3px] after:h-[2px] after:rounded-full after:bg-accent"
                : "text-neutral-500 hover:bg-white/60 hover:text-neutral-900",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
