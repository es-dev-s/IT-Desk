"use client";

import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Edge-anchored panel. Same CSS-driven enter/exit as Modal; content survives the exit. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  side = "right",
  className,
  header,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  side?: "right" | "left";
  className?: string;
  /** Replace the default header (title + close) with custom content. Title stays for a11y. */
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-neutral-950/20 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <RD.Content
          className={cn(
            "fixed inset-y-0 z-50 flex w-full flex-col bg-white shadow-overlay outline-none",
            side === "right"
              ? "right-0 max-w-[560px] data-[state=closed]:animate-sheet-out data-[state=open]:animate-sheet-in"
              : "left-0 max-w-[288px] data-[state=closed]:animate-drawer-out data-[state=open]:animate-drawer-in",
            className,
          )}
        >
          {header ? (
            <>
              <RD.Title className="sr-only">{title}</RD.Title>
              <RD.Description className="sr-only">{description ?? title}</RD.Description>
              {header}
            </>
          ) : (
            <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line px-6">
              <div className="min-w-0">
                <RD.Title className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</RD.Title>
                <RD.Description className={description ? "truncate text-xs text-neutral-500" : "sr-only"}>
                  {description ?? title}
                </RD.Description>
              </div>
              <SheetClose />
            </div>
          )}
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export function SheetClose({ className }: { className?: string }) {
  return (
    <RD.Close
      aria-label="Close"
      className={cn(
        "-mr-2 grid size-8 shrink-0 place-items-center rounded-lg text-neutral-400 outline-none transition-colors hover:bg-neutral-100 hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-accent/35",
        className,
      )}
    >
      <X className="size-4" aria-hidden />
    </RD.Close>
  );
}
