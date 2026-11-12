"use client";

import { formatDateTime } from "@/lib/format";
import type { ITRequest } from "@/lib/requests";
import type { Acknowledgement, Transfer } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/auth/session-provider";
import { AckButton, AckChip, NewDot, TransferAck, WaitingChip } from "./ack";

type Props =
  | { kind: "transfer"; transfer: Transfer }
  | { kind: "request"; request: ITRequest; onAck: () => Promise<unknown>; isIt: boolean };

/**
 * Top-of-sheet strip that answers "has IT seen this?" for everyone:
 * IT gets the acknowledge button, the requester a live "Waiting for IT" →
 * "Seen by … · Working on it". Same height in every state, so it never jumps.
 */
export function AckBanner(props: Props) {
  const { session, can } = useSession();
  const me = session.user.id;

  let ack: Acknowledgement | null | undefined;
  let isIt: boolean;
  let waiting: boolean;
  let canAck: boolean;
  if (props.kind === "transfer") {
    ack = props.transfer.acknowledgement;
    isIt = can("transfers.advance");
    waiting = props.transfer.itStatus === "requested";
    canAck = isIt && props.transfer.itStatus !== "completed" && !props.transfer.id.startsWith("tmp_");
  } else {
    ack = props.request.acknowledgement;
    isIt = props.isIt;
    const open = props.request.status === "open" || props.request.status === "in_progress";
    waiting = props.request.status === "open";
    canAck = isIt && open;
  }

  if (!ack && !(canAck || waiting)) return null;

  const base = "flex min-h-[60px] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3";

  if (ack) {
    const mine = ack.byId === me;
    return (
      <div className={cn(base, "border-emerald-200/70 bg-emerald-50/60")} data-testid="ack-banner" data-state="seen">
        <AckChip ack={ack} variant="working" />
        <p className="tnum min-w-0 text-xs text-emerald-900/70">
          {mine ? "You acknowledged this" : isIt ? `${ack.byName} is on it` : "IT has seen it and is working on it"} · {formatDateTime(ack.at)}
        </p>
      </div>
    );
  }

  if (canAck) {
    return (
      <div className={cn(base, "border-accent-line bg-accent-soft/70")} data-testid="ack-banner" data-state="new">
        <NewDot />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-neutral-900">New — nobody from IT has picked this up</p>
          <p className="text-xs text-neutral-600">
            {props.kind === "request" ? "Acknowledging claims it and starts work. " : ""}The requester sees it instantly.
          </p>
        </div>
        {props.kind === "transfer" ? <TransferAck transfer={props.transfer} /> : <AckButton onAck={props.onAck} testId="request-ack" />}
      </div>
    );
  }

  return (
    <div className={cn(base, "border-line bg-subtle")} data-testid="ack-banner" data-state="waiting">
      <WaitingChip />
      <p className="min-w-0 text-xs text-neutral-500">IT was notified the moment you sent this. You’ll see it here as soon as someone picks it up.</p>
    </div>
  );
}
