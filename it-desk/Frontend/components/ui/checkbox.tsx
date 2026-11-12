import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  className,
  label,
  tabIndex,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
  label: string;
  tabIndex?: number;
}) {
  const on = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      tabIndex={tabIndex}
      onClick={(e) => {
        e.stopPropagation();
        onCheckedChange(!checked);
      }}
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-[5px] border outline-none transition-colors duration-150",
        "focus-visible:ring-2 focus-visible:ring-accent/35",
        on ? "border-accent bg-accent text-white" : "border-neutral-300 bg-white hover:border-neutral-400",
        className,
      )}
    >
      {indeterminate ? (
        <Minus className="size-3" strokeWidth={3} aria-hidden />
      ) : checked ? (
        <Check className="size-3" strokeWidth={3} aria-hidden />
      ) : null}
    </button>
  );
}
