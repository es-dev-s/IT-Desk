"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const EDGE = 28;

/**
 * Horizontal scroller that fades whichever edge has more content behind it.
 * The mask only changes when an edge state flips, so scrolling stays cheap and
 * nothing in the layout moves. On touch screens the scrollbar is hidden; on
 * pointer devices a thin one stays for mouse users.
 */
export function ScrollFade({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  const mask =
    edges.start || edges.end
      ? `linear-gradient(to right, ${edges.start ? "transparent" : "#000"} 0, #000 ${EDGE}px, #000 calc(100% - ${EDGE}px), ${edges.end ? "transparent" : "#000"} 100%)`
      : undefined;

  return (
    <div
      ref={ref}
      {...props}
      className={cn(
        "relative overflow-x-auto overscroll-x-contain",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden [@media(hover:hover)]:[scrollbar-width:thin]",
        className,
      )}
      style={{ maskImage: mask, WebkitMaskImage: mask, ...props.style }}
    >
      {children}
    </div>
  );
}
