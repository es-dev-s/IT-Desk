import { cn } from "@/lib/utils";

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-white px-1 font-sans text-[11px] font-medium text-neutral-500", className)}>
      {children}
    </kbd>
  );
}
