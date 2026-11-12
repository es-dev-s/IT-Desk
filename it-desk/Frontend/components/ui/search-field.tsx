"use client";

import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function SearchField({
  value,
  onChange,
  placeholder = "Search",
  label,
  className,
  autoFocus,
  size = "sm",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
  autoFocus?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" aria-hidden />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={cn(size === "md" ? "h-9" : "h-8", "w-full rounded-lg border border-line-strong bg-white pl-8 pr-8 text-[13px] text-neutral-900 shadow-xs outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-neutral-400 focus:border-accent focus:ring-3 focus:ring-accent/15 [&::-webkit-search-cancel-button]:hidden")}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
