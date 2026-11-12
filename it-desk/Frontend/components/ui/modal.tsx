"use client";

import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Dialog centred in the viewport. Enter/exit are CSS keyframes driven by Radix `data-state`,
 * and Radix keeps the content mounted until the exit animation ends.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  className,
  headerClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  className?: string;
  headerClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-neutral-950/30 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <RD.Content
          className={cn(
            // Centred by layout (all insets 0 + auto margins + fit height), not by a
            // translate(-50%), so text stays on whole pixels and the open animation
            // (a scale about the centre) never moves it.
            "fixed inset-0 z-50 m-auto flex h-fit w-[calc(100vw-2rem)] max-w-[440px] flex-col overflow-hidden",
            "max-h-[calc(100dvh-2rem)] rounded-[var(--radius-overlay)] bg-white shadow-overlay outline-none",
            "data-[state=closed]:animate-modal-out data-[state=open]:animate-modal-in",
            className,
          )}
        >
          <div className={cn("flex items-start gap-4 px-6 pb-2 pt-6", headerClassName)}>
            <div className="min-w-0 flex-1">
              <RD.Title className="text-[17px] font-semibold tracking-[-0.01em] text-neutral-900">{title}</RD.Title>
              {description ? (
                <RD.Description className="mt-1 text-[13px] leading-5 text-neutral-500">{description}</RD.Description>
              ) : (
                <RD.Description className="sr-only">{title}</RD.Description>
              )}
            </div>
            <RD.Close
              aria-label="Close"
              className="-mr-2 -mt-1 grid size-8 place-items-center rounded-lg text-neutral-400 outline-none transition-colors hover:bg-neutral-100 hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-accent/35"
            >
              <X className="size-4" aria-hidden />
            </RD.Close>
          </div>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export function ModalBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("scrollbar-thin flex-1 overflow-y-auto px-6 py-4", className)}>{children}</div>;
}

export function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{children}</div>;
}
