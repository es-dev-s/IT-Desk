"use client";

import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Toaster } from "sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {/* Gentle, non-overshooting defaults for every motion component. */}
      <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
        <Tooltip.Provider delayDuration={300} skipDelayDuration={150}>
          {children}
          <Toaster
            position="bottom-right"
            gap={8}
            offset={24}
            toastOptions={{
              classNames: {
                toast:
                  "!rounded-xl !border-0 !bg-white !shadow-pop !font-sans !text-[13px] !gap-3 !px-4 !py-3",
                title: "!font-medium !text-neutral-900",
                description: "!text-neutral-500 tnum",
                actionButton: "!rounded-md !bg-neutral-900 !px-2.5 !h-7 !text-xs !font-medium !text-white",
              },
            }}
          />
        </Tooltip.Provider>
      </MotionConfig>
    </LazyMotion>
  );
}
