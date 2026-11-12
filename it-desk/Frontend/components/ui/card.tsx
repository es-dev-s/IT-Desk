import { cn } from "@/lib/utils";

export function Card({ className, children, ...props }: React.ComponentProps<"section">) {
  return (
    <section className={cn("rounded-card border border-line bg-white shadow-card", className)} {...props}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex min-h-14 items-center justify-between gap-4 px-5 py-4", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-[-0.01em] text-neutral-900">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-neutral-500">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}
