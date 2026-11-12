"use client";

import { Eye, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { Acknowledgement, Transfer } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { useWorkspaceApi } from "@/store/workspace-provider";
import { useCan } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";

/** Re-render every 30s so "just now" ages without a refetch. */
function useMinuteTick() {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setN((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
}

const firstName = (name: string) => name.split(" ")[0] || name;

/** "Seen by Bikash · 2m ago" (IT side) or "Seen by Bikash · Working on it" (requester side). */
export function AckChip({ ack, variant = "time", className, short = false }: { ack: Acknowledgement; variant?: "time" | "working"; className?: string; short?: boolean }) {
  useMinuteTick();
  const who = short ? firstName(ack.byName) : ack.byName;
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-50 pl-1.5 pr-2 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-600/15",
        className,
      )}
      title={`Seen by ${ack.byName} · ${formatDateTime(ack.at)}`}
      data-testid="ack-chip"
    >
      <span className="relative grid size-3.5 shrink-0 place-items-center" aria-hidden>
        {variant === "working" ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50 motion-reduce:hidden" /> : null}
        <span className="relative size-2 rounded-full bg-emerald-500" />
      </span>
      <span className="truncate">
        Seen by {who}
        <span className="text-emerald-700/70"> · {variant === "working" ? "Working on it" : formatTimeAgo(ack.at)}</span>
      </span>
    </span>
  );
}

/** Requester side, before IT has looked: a calm amber "Waiting for IT" with a slow pulse. */
export function WaitingChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full bg-accent-soft pl-1.5 pr-2 text-xs font-medium text-accent-ink ring-1 ring-inset ring-accent/20",
        className,
      )}
      data-testid="waiting-chip"
    >
      <span className="relative grid size-3.5 shrink-0 place-items-center" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent-strong opacity-40 [animation-duration:1.8s] motion-reduce:hidden" />
        <span className="relative size-2 rounded-full bg-accent" />
      </span>
      Waiting for IT
    </span>
  );
}

/** Small orange dot for IT: "nobody has picked this up yet". */
export function NewDot({ className, label = "New — not acknowledged yet" }: { className?: string; label?: string }) {
  return (
    <span className={cn("relative inline-grid size-2 shrink-0 place-items-center", className)} title={label} data-testid="new-dot">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent-strong opacity-50 [animation-duration:2s] motion-reduce:hidden" aria-hidden />
      <span className="relative size-2 rounded-full bg-accent" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** IT's "I've seen it" button. Fixed width while pending so the row doesn't jump. */
export function AckButton({
  onAck,
  size = "sm",
  compact = false,
  className,
  testId = "ack-button",
}: {
  onAck: () => Promise<unknown>;
  size?: "sm" | "md";
  compact?: boolean;
  className?: string;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size={size}
      variant="primary"
      disabled={busy}
      className={cn("shadow-[0_1px_0_rgb(255_255_255/0.2)_inset,0_1px_2px_rgb(201_72_10/0.35)]", className)}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await onAck();
        } finally {
          setBusy(false);
        }
      }}
      onKeyDown={(e) => e.stopPropagation()}
      data-testid={testId}
    >
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Eye aria-hidden />}
      {compact ? "Acknowledge" : "Acknowledge · Working on it"}
    </Button>
  );
}

/** The acknowledge state of a transfer, right for the viewer's role. */
export function TransferAck({ transfer: t, compact = false, className }: { transfer: Transfer; compact?: boolean; className?: string }) {
  const isIt = useCan("transfers.advance");
  const api = useWorkspaceApi();
  if (t.acknowledgement) return <AckChip ack={t.acknowledgement} variant={isIt ? "time" : "working"} short={compact} className={className} />;
  if (isIt) {
    if (t.itStatus === "completed") return null;
    return (
      <AckButton
        compact={compact}
        className={className}
        onAck={async () => {
          const r = await api.getState().acknowledgeTransfer(t.id);
          if (r.ok) toast.success(`${t.ticket} acknowledged`, { description: "The team can see you’re on it." });
          else toast.error("Couldn’t acknowledge", { description: r.error });
        }}
      />
    );
  }
  return t.itStatus === "requested" ? <WaitingChip className={className} /> : null;
}

/** IT should see a "New" dot: nobody has acknowledged it and work hasn't started. */
export const transferIsNew = (t: Transfer) => !t.acknowledgement && t.itStatus === "requested" && !t.id.startsWith("tmp_");
