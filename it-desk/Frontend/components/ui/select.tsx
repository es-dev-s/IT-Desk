"use client";

import * as RS from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string };

export function SelectField({
  value,
  onValueChange,
  options,
  label,
  className,
  prefix,
  size = "sm",
  placeholder,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  className?: string;
  prefix?: string;
  size?: "sm" | "md";
  placeholder?: string;
}) {
  return (
    <RS.Root value={value} onValueChange={onValueChange}>
      <RS.Trigger
        aria-label={label}
        className={cn(
          size === "md" ? "h-9" : "h-8",
          "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-white pl-3 pr-2 text-[13px] text-neutral-800 shadow-xs outline-none transition-colors duration-150 hover:bg-neutral-50",
          "focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/15 data-[placeholder]:text-neutral-400",
          className,
        )}
      >
        {prefix ? <span className="text-neutral-500">{prefix}</span> : null}
        <span className="truncate font-medium">
          <RS.Value placeholder={placeholder} />
        </span>
        <RS.Icon className="ml-auto">
          <ChevronDown className="size-4 text-neutral-400" aria-hidden />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          position="popper"
          sideOffset={6}
          className="z-[70] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl bg-white p-1 shadow-pop data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in"
        >
          <RS.Viewport>
            {options.map((opt) => (
              <RS.Item
                key={opt.value}
                value={opt.value}
                className="relative flex h-8 cursor-default select-none items-center rounded-md pl-8 pr-3 text-[13px] text-neutral-700 outline-none data-[highlighted]:bg-neutral-900/[0.05] data-[highlighted]:text-neutral-900"
              >
                <RS.ItemIndicator className="absolute left-2.5">
                  <Check className="size-4 text-accent" aria-hidden />
                </RS.ItemIndicator>
                <RS.ItemText>{opt.label}</RS.ItemText>
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
