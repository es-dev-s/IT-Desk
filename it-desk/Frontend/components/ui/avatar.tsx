import { cn, initials } from "@/lib/utils";

const SIZES = {
  xs: "size-6 text-[10px]",
  sm: "size-8 text-[11px]",
  md: "size-9 text-xs",
  lg: "size-11 text-sm",
} as const;

/** Low-chroma tint derived from the member's hue: identifiable, never loud. */
export function Avatar({
  name,
  hue = 220,
  size = "sm",
  className,
  ring = false,
}: {
  name: string;
  hue?: number;
  size?: keyof typeof SIZES;
  className?: string;
  /** Brand treatment: warm initials inside a thin orange gradient ring (muted when inactive). */
  ring?: boolean | "muted";
}) {
  if (ring) {
    const muted = ring === "muted";
    return (
      <span
        aria-hidden
        className={cn(
          "grid shrink-0 place-items-center rounded-full p-[1.5px]",
          muted ? "bg-neutral-200" : "bg-[linear-gradient(140deg,var(--color-brand-200),var(--color-brand-400))]",
          SIZES[size].split(" ")[0],
          className,
        )}
      >
        <span
          className={cn(
            "grid size-full select-none place-items-center rounded-full font-semibold tracking-[-0.01em] ring-2 ring-white",
            SIZES[size].split(" ")[1],
            muted ? "bg-neutral-100 text-neutral-400" : "bg-[linear-gradient(160deg,var(--color-brand-50),var(--color-brand-100))] text-accent-ink",
          )}
        >
          {initials(name)}
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 select-none place-items-center rounded-full font-medium", SIZES[size], className)}
      style={{ background: `oklch(0.95 0.025 ${hue})`, color: `oklch(0.42 0.06 ${hue})` }}
    >
      {initials(name)}
    </span>
  );
}
