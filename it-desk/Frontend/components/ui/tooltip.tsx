"use client";

import * as RT from "@radix-ui/react-tooltip";

export function Tip({ label, children, side = "top" }: { label: string; children: React.ReactNode; side?: "top" | "bottom" | "right" | "left" }) {
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          className="z-[80] rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white data-[state=closed]:animate-pop-out data-[state=delayed-open]:animate-pop-in"
        >
          {label}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
