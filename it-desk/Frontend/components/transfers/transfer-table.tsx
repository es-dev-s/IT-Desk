"use client";

import { deviceCount } from "@/lib/analytics";
import { formatShortDate } from "@/lib/format";
import type { Team, Transfer } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { useTeamsById } from "@/store/selectors";
import { useUI } from "@/store/ui-store";
import { Avatar } from "@/components/ui/avatar";
import { DirectionLabel, ItStatusLabel } from "@/components/ui/status";
import { useCan } from "@/components/auth/session-provider";
import { NewDot, transferIsNew } from "@/components/realtime/ack";
import { Eye } from "lucide-react";
import { seatLabel } from "@/lib/floors";

export function people(t: Transfer) {
  const first = t.moves[0].memberName;
  return t.moves.length > 1 ? `${first} +${t.moves.length - 1}` : first;
}

export function route(t: Transfer, teams: Record<string, Team>) {
  if (t.direction === "internal") {
    if (t.moves.length === 1) return `${seatLabel(t.moves[0].fromSeat)} → ${seatLabel(t.moves[0].toSeat)}`;
    return `${t.moves.length} seats on ${teams[t.toTeamId]?.location.split(" · ")[1] ?? "floor"}`;
  }
  return t.direction === "in" ? `From ${teams[t.fromTeamId]?.name ?? t.fromTeamId}` : `To ${teams[t.toTeamId]?.name ?? t.toTeamId}`;
}

/** Shared request table. Rows are fixed height; the whole row opens the detail sheet. */
export function TransferTable({ transfers, className }: { transfers: Transfer[]; className?: string }) {
  const teams = useTeamsById();
  const openDetail = useUI((s) => s.openDetail);
  const isIt = useCan("transfers.advance");
  return (
    <div className={cn("relative overflow-x-auto", className)}>
      <table className="w-full min-w-[760px] text-left text-[13px]">
        <thead>
          <tr className="h-10 border-y border-line bg-subtle text-xs font-medium text-neutral-500 [&>th]:px-5 [&>th]:font-medium">
            <th className="w-[96px]">Ticket</th>
            <th>People</th>
            <th>Type</th>
            <th>Route</th>
            <th className="text-right">Devices</th>
            <th className="w-[96px]">Date</th>
            <th className="w-[176px]">IT status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {transfers.map((t) => (
            <tr
              key={t.id}
              tabIndex={0}
              onClick={() => openDetail(t.id)}
              onKeyDown={(e) => (e.key === "Enter" ? openDetail(t.id) : null)}
              className="h-14 cursor-default outline-none transition-colors duration-150 hover:bg-neutral-50 focus-visible:bg-accent-soft/50 [&>td]:px-5"
            >
              <td className="tnum font-mono text-xs text-neutral-500">
                <span className="inline-flex items-center gap-1.5">
                  {t.ticket}
                  {isIt && transferIsNew(t) ? <NewDot /> : null}
                </span>
              </td>
              <td>
                <span className="flex items-center gap-2.5">
                  <span className="flex -space-x-1.5">
                    {t.moves.slice(0, 3).map((mv, i) => (
                      <Avatar key={mv.memberId} name={mv.memberName} hue={(i * 67 + mv.memberName.length * 23) % 360} size="xs" className="ring-2 ring-white" />
                    ))}
                  </span>
                  <span className="truncate font-medium text-neutral-900">{people(t)}</span>
                </span>
              </td>
              <td>
                <DirectionLabel direction={t.direction} />
              </td>
              <td className={cn("truncate text-neutral-600", t.direction === "internal" && t.moves.length === 1 && "tnum font-mono text-xs")}>
                {route(t, teams)}
              </td>
              <td className="tnum text-right text-neutral-600">{deviceCount(t)}</td>
              <td className="tnum text-neutral-500">{formatShortDate(t.createdAt)}</td>
              <td>
                <span className="inline-flex items-center gap-2">
                  <ItStatusLabel status={t.itStatus} />
                  {t.acknowledgement ? (
                    <span className="grid size-5 place-items-center rounded-full bg-emerald-50 text-emerald-700" title={`Seen by ${t.acknowledgement.byName}`} data-testid="row-seen">
                      <Eye className="size-3" aria-hidden />
                      <span className="sr-only">Seen by {t.acknowledgement.byName}</span>
                    </span>
                  ) : null}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
