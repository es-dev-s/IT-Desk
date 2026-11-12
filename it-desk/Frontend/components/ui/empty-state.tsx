import { cn } from "@/lib/utils";

/**
 * Calm, branded empty state: a soft orange halo around the icon, one line of
 * title, one of guidance, and (optionally) the next step as an action.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)} role="status">
      <span aria-hidden className="relative grid size-14 place-items-center">
        <span className="absolute inset-0 rounded-2xl bg-accent-soft/70 ring-1 ring-accent-line/60" />
        <span className="absolute inset-[7px] rounded-xl bg-white shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_12px_-4px_rgb(0_0_0/0.08)]" />
        <Icon className="relative size-5 text-accent" />
      </span>
      <p className="mt-5 text-[15px] font-semibold tracking-[-0.01em] text-neutral-900">{title}</p>
      {description ? <p className="mt-1.5 max-w-sm text-[13px] leading-5 text-neutral-500 text-pretty">{description}</p> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
