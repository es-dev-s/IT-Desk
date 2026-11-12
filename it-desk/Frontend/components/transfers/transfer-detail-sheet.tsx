"use client";

import { Check } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { IT_STATUSES } from "@/lib/constants";
import { deviceCount } from "@/lib/analytics";
import { formatDate, formatDateTime } from "@/lib/format";
import type { ItStatus } from "@/lib/schemas";
import { cn, pluralize } from "@/lib/utils";
import { useTeamsById } from "@/store/selectors";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";
import { useUI } from "@/store/ui-store";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { DEVICE_ICON, DIRECTION_LABEL, IT_STATUS_LABEL } from "@/components/ui/status";
import { toast } from "sonner";
import { route } from "./transfer-table";
import { useCan } from "@/components/auth/session-provider";
import { AckBanner } from "@/components/realtime/ack-banner";
import { seatLabel } from "@/lib/floors";

export const NEXT_LABEL: Partial<Record<ItStatus, string>> = {
  requested: "Mark IT scheduled",
  scheduled: "Mark devices moved",
  moved: "Mark completed",
};

export function TransferDetailSheet() {
  const { open, transferId } = useUI(useShallow((s) => ({ open: s.detail.open, transferId: s.detail.transferId })));
  const close = useUI((s) => s.closeDetail);
  const t = useWorkspace((s) => (transferId ? s.transfers[transferId] : undefined));
  const teams = useTeamsById();
  const api = useWorkspaceApi();
  const canAdvance = useCan("transfers.advance");

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => (next ? null : close())}
      title={t ? t.ticket : "Transfer"}
      description={t ? `${DIRECTION_LABEL[t.direction]} · ${route(t, teams)}` : undefined}
    >
      {t ? (
        <>
          <div className="scrollbar-thin min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-6">
            <AckBanner kind="transfer" transfer={t} />
            <section>
              <h3 className="text-xs font-medium text-neutral-500">IT device move</h3>
              <ol className="mt-3">
                {IT_STATUSES.map((status, i) => {
                  const step = t.history.find((h) => h.status === status);
                  const reached = Boolean(step);
                  const current = t.itStatus === status;
                  return (
                    <li key={status} className="relative flex gap-3 pb-5 last:pb-0">
                      {i < IT_STATUSES.length - 1 ? (
                        <span className={cn("absolute bottom-0 left-[9px] top-[19px] w-px", reached && t.history.some((h) => h.status === IT_STATUSES[i + 1]) ? "bg-accent" : "bg-line-strong")} />
                      ) : null}
                      <span
                        className={cn(
                          "grid size-[19px] shrink-0 place-items-center rounded-full border",
                          reached ? "border-accent bg-accent text-white" : "border-line-strong bg-white",
                          current && status !== "completed" && "ring-4 ring-accent-muted",
                        )}
                      >
                        {reached ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
                      </span>
                      <div className="-mt-px min-w-0">
                        <p className={cn("text-[13px] font-medium", reached ? "text-neutral-900" : "text-neutral-400")}>{IT_STATUS_LABEL[status]}</p>
                        <p className="tnum h-4 text-xs text-neutral-500">{step ? formatDateTime(step.at) : ""}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>

            <section>
              <h3 className="text-xs font-medium text-neutral-500">
                {pluralize(t.moves.length, "person", "people")} · {pluralize(deviceCount(t), "device")}
              </h3>
              <ul className="mt-3 space-y-3">
                {t.moves.map((mv) => (
                  <li key={mv.memberId} className="rounded-lg border border-line">
                    <div className="flex items-center gap-3 border-b border-line px-3 py-2.5">
                      <Avatar name={mv.memberName} size="xs" hue={(mv.memberName.length * 41) % 360} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{mv.memberName}</span>
                      <span className="tnum text-[13px] text-neutral-800">
                        {seatLabel(mv.fromSeat)} <span className="text-neutral-300">→</span> {seatLabel(mv.toSeat)}
                      </span>
                    </div>
                    {mv.devices.length ? (
                      <ul className="py-1">
                        {mv.devices.map((d) => {
                          const Icon = DEVICE_ICON[d.kind];
                          return (
                            <li key={d.id} className="flex h-9 items-center gap-3 px-3 text-[13px]">
                              <Icon className="size-4 text-neutral-400" />
                              <span className="min-w-0 flex-1 truncate text-neutral-700">{d.model}</span>
                              <span className="tnum font-mono text-xs text-neutral-500">{d.assetTag}</span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="px-3 py-2.5 text-[13px] text-neutral-500">No devices to move</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="text-xs font-medium text-neutral-500">Details</h3>
              <dl className="mt-3 divide-y divide-line rounded-lg border border-line text-[13px]">
                {[
                  ["From", teams[t.fromTeamId]?.name ?? t.fromTeamId],
                  ["To", teams[t.toTeamId]?.name ?? t.toTeamId],
                  ["Effective", formatDate(t.effectiveDate)],
                  ["Requested by", t.initiatedBy],
                  ...(t.note ? [["Note", t.note]] : []),
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-4 px-3 py-2.5">
                    <dt className="w-28 shrink-0 text-neutral-500">{k}</dt>
                    <dd className="min-w-0 text-neutral-900">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-6 py-4">
            <p className="text-[13px] text-neutral-500">{t.itStatus === "completed" ? "All devices are in place." : canAdvance ? "Move it forward as the work progresses." : "Updated by IT as the move progresses."}</p>
            {canAdvance && NEXT_LABEL[t.itStatus] ? (
              <Button
                variant="dark"
                size="sm"
                disabled={t.id.startsWith("tmp_")}
                onClick={() => {
                  // Optimistic: the status pill moves immediately; rolled back if the API refuses.
                  void api
                    .getState()
                    .advanceItStatus(t.id)
                    .then((r) => {
                      if (r.ok) toast.success(`${t.ticket} · ${IT_STATUS_LABEL[r.status]}`);
                      else toast.error("Couldn’t update", { description: r.error });
                    });
                }}
              >
                {NEXT_LABEL[t.itStatus]}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </Sheet>
  );
}
