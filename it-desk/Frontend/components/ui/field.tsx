import { cn } from "@/lib/utils";

export const inputClass = cn(
  "h-9 w-full rounded-lg border border-line-strong bg-white px-3 text-sm text-neutral-900 shadow-xs outline-none transition-[border-color,box-shadow] duration-150",
  "placeholder:text-neutral-400 focus:border-accent focus:ring-3 focus:ring-accent/15",
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:focus:ring-red-500/15",
);

export const textareaClass = cn(inputClass, "h-auto min-h-20 resize-none py-2 leading-relaxed");

/** Label + control + one reserved message line, so errors never push content around. */
export function Field({
  id,
  label,
  hint,
  error,
  optional,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="flex items-baseline justify-between text-[13px] font-medium text-neutral-800">
        {label}
        {optional ? <span className="text-xs font-normal text-neutral-400">Optional</span> : null}
      </label>
      {children}
      <p
        id={`${id}-msg`}
        className={cn("min-h-4 text-xs leading-4", error ? "text-red-600" : "text-neutral-500")}
        role={error ? "alert" : undefined}
      >
        {error ?? hint ?? ""}
      </p>
    </div>
  );
}
