import { cn } from "@/lib/utils";

/** Stable hue per team code, so a team's badge looks the same everywhere. */
export function teamHue(code: string) {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** The short team code as a tinted badge (ELC, RPR, …). */
export function TeamBadge({ code, size = "sm", className }: { code: string; size?: "xs" | "sm" | "md"; className?: string }) {
  const hue = teamHue(code);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-md font-mono font-semibold tracking-[0.02em] ring-1 ring-inset",
        size === "xs" && "h-5 min-w-8 px-1 text-[10px]",
        size === "sm" && "h-6 min-w-9 px-1.5 text-[11px]",
        size === "md" && "h-8 min-w-11 px-2 text-xs",
        className,
      )}
      style={
        {
          backgroundColor: `hsl(${hue} 75% 96%)`,
          color: `hsl(${hue} 45% 30%)`,
          "--tw-ring-color": `hsl(${hue} 50% 45% / 0.18)`,
        } as React.CSSProperties
      }
    >
      {code}
    </span>
  );
}
