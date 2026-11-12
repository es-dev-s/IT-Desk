"use client";

import {
  AlertCircle,
  Armchair,
  ArrowLeftRight,
  Building2,
  CircleHelp,
  Clock3,
  History,
  Laptop,
  LifeBuoy,
  Mail,
  MapPin,
  PencilLine,
  RotateCw,
  TriangleAlert,
  UserPlus,
  UserX,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { EMPTY_REQUEST_FORM } from "@/lib/requests";
import type { MemberDetail, MemberHistoryItem } from "@/lib/schemas";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { onLive } from "@/lib/live-bus";
import { seatLabel } from "@/lib/floors";
import { useMemberDetailLink } from "@/lib/member-detail-link";
import { Sheet, SheetClose } from "@/components/ui/sheet";
import { Avatar } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { DEVICE_ICON, DEVICE_LABEL, MEMBER_STATUS_LABEL } from "@/components/ui/status";
import { LeadBadge } from "@/components/floors/lead-badge";
import { FloorCanvas } from "@/components/floors/floor-canvas";
import { useSession } from "@/components/auth/session-provider";
import { useUI } from "@/store/ui-store";
import { useRequests } from "@/store/requests-store";
import { useFloors, useOccupancy, useTeamColors, useTeamsById } from "@/store/selectors";

type State = { status: "loading" } | { status: "error"; message: string; notFound: boolean } | { status: "ready"; data: MemberDetail };

/** Right-side member profile, driven by `?member=<id>`. Mounted once in the app shell. */
export function MemberDetailSheet() {
  const { memberId, close } = useMemberDetailLink();
  // Keep the last id while the sheet animates out.
  const [shownId, setShownId] = useState(memberId);
  if (memberId && memberId !== shownId) setShownId(memberId);
  return (
    <Sheet
      open={Boolean(memberId)}
      onOpenChange={(o) => (!o ? close() : undefined)}
      title="Member details"
      className="max-sm:left-0 max-sm:w-auto max-sm:max-w-none"
      header={<span />}
    >
      {shownId ? <DetailBody key={shownId} id={shownId} onClose={close} /> : null}
    </Sheet>
  );
}

function errorText(e: unknown) {
  const err = e as { status?: number; message?: string };
  return { notFound: err?.status === 404 || err?.status === 403, message: err?.message || "Couldn't load this member." };
}

function DetailBody({ id, onClose }: { id: string; onClose: () => void }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const seq = useRef(0);
  const load = useCallback(
    async (quiet = false) => {
      const n = ++seq.current;
      if (!quiet) setState({ status: "loading" });
      try {
        const data = await api.memberDetail(id);
        if (n === seq.current) setState({ status: "ready", data });
      } catch (e) {
        if (n !== seq.current) return;
        const err = errorText(e);
        // A failed background refresh keeps what's on screen, unless the member is gone / out of scope.
        setState((s) => (quiet && s.status === "ready" && !err.notFound ? s : { status: "error", ...err }));
      }
    },
    [id],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);
  // Live: refetch (debounced) when anything that feeds the timeline changes.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(() => void load(true), 250);
    };
    const offs = [onLive("member", bump), onLive("transfer", bump), onLive("it_request", bump)];
    return () => {
      clearTimeout(t);
      offs.forEach((off) => off());
    };
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="member-detail">
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line px-6 max-sm:px-4">
        <p className="text-[13px] font-medium text-neutral-500">Member details</p>
        <SheetClose />
      </div>
      {state.status === "loading" ? (
        <DetailSkeleton />
      ) : state.status === "error" ? (
        <div className="grid flex-1 place-items-center px-6" data-testid="member-detail-error">
          <div className="max-w-xs text-center">
            <AlertCircle className="mx-auto size-6 text-neutral-400" aria-hidden />
            <p className="mt-3 text-sm font-medium text-neutral-900">{state.notFound ? "Member not found" : "Something went wrong"}</p>
            <p className="mt-1 text-[13px] text-neutral-500">
              {state.notFound ? "They may have been removed, or they aren't in a team you can see." : state.message}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              {!state.notFound ? (
                <Button size="sm" onClick={() => void load()}>
                  <RotateCw aria-hidden /> Try again
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <DetailContent data={state.data} onClose={onClose} />
      )}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6 px-6 py-6 max-sm:px-4" data-testid="member-detail-loading" aria-busy>
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
      <Skeleton className="h-40" />
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    </div>
  );
}

function Section({ title, icon: Icon, children, testId }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; testId?: string }) {
  return (
    <section className="border-t border-line px-6 py-5 max-sm:px-4" data-testid={testId}>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
        <Icon className="size-3.5" aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-neutral-900/[0.03] px-3 py-2">
      <dt className="text-[11px] text-neutral-500">{label}</dt>
      <dd className="truncate text-[13px] font-medium text-neutral-900">{children}</dd>
    </div>
  );
}

const nptTime = (iso: string) => `${formatDateTime(iso)} NPT`;

function DetailContent({ data, onClose }: { data: MemberDetail; onClose: () => void }) {
  const m = data.member;
  const { can } = useSession();
  const teams = useTeamsById();
  const openMemberDialog = useUI((s) => s.openMemberDialog);
  const openTransfer = useUI((s) => s.openTransfer);
  const openExit = useUI((s) => s.openExit);
  const openRequest = useRequests((s) => s.openDialog);
  const active = m.status === "active";
  const team = teams[m.teamId];
  // Close first so only one overlay owns focus; the next dialog opens on the page.
  const then = (fn: () => void) => () => {
    onClose();
    setTimeout(fn, 0);
  };
  const actions = [
    can("members.manage") && { id: "edit", label: "Edit", icon: PencilLine, run: then(() => openMemberDialog(m.id)) },
    active && can("transfers.create") && { id: "transfer", label: "Transfer", icon: ArrowLeftRight, run: then(() => openTransfer([m.id], "team")) },
    active && can("transfers.create") && { id: "seat", label: "Move seat", icon: Armchair, run: then(() => openTransfer([m.id], "internal")) },
    active && can("requests.create") && {
      id: "request",
      label: "Request IT",
      icon: LifeBuoy,
      run: then(() => openRequest({ ...EMPTY_REQUEST_FORM, forMemberId: m.id, teamId: m.teamId })),
    },
    active && can("requests.create") && {
      id: "issue",
      label: "Report issue",
      icon: TriangleAlert,
      run: then(() => openRequest({ ...EMPTY_REQUEST_FORM, type: "issue", forMemberId: m.id, teamId: m.teamId })),
    },
    active && can("exits.create") && { id: "resigned", label: "Mark resigned", icon: UserX, danger: true, run: then(() => openExit("resigned", [m.id])) },
    active && can("exits.create") && { id: "unknown", label: "Mark unknown", icon: CircleHelp, run: then(() => openExit("unknown", [m.id])) },
  ].filter(Boolean) as { id: string; label: string; icon: React.ComponentType; danger?: boolean; run: () => void }[];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {/* Header */}
      <div className="px-6 pb-5 pt-6 max-sm:px-4">
        <div className="flex items-center gap-4">
          <span className="relative shrink-0">
            <Avatar name={m.name} hue={m.hue} size="lg" ring={active ? true : "muted"} className={cn("size-14 text-base", m.isLead && "ring-2 ring-amber-400")} />
            {m.isLead ? <LeadBadge compact className="absolute -right-1 -top-1" /> : null}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-lg font-semibold tracking-[-0.02em] text-neutral-900" data-testid="member-detail-name">
                {m.name}
              </h2>
              {m.isLead ? <LeadBadge /> : null}
            </div>
            <p className="truncate text-[13px] text-neutral-500">
              {m.role} · {m.subGroup}
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <StatusPill status={m.status} />
              {team ? <span className="truncate text-xs text-neutral-500">{team.name}</span> : null}
            </div>
          </div>
        </div>
        {actions.length ? (
          <div className="mt-5 flex flex-wrap gap-2" data-testid="member-detail-actions">
            {actions.map((a) => (
              <Button key={a.id} size="sm" variant={a.danger ? "secondary" : a.id === "edit" ? "dark" : "secondary"} onClick={a.run} className={a.danger ? "text-red-600" : undefined}>
                <a.icon />
                {a.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <Section title="Profile" icon={Building2}>
        <dl className="grid grid-cols-2 gap-2 max-[380px]:grid-cols-1">
          <Fact label="Designation">{m.role}</Fact>
          <Fact label="Group">{m.subGroup}</Fact>
          <Fact label="Team">{team?.name ?? "—"}</Fact>
          <Fact label="Status">{MEMBER_STATUS_LABEL[m.status]}</Fact>
          <div className="col-span-2 min-w-0 rounded-xl bg-neutral-900/[0.03] px-3 py-2 max-[380px]:col-span-1">
            <dt className="text-[11px] text-neutral-500">Work email</dt>
            <dd className="truncate text-[13px] font-medium text-neutral-900">
              {m.email ? (
                <a href={`mailto:${m.email}`} className="inline-flex items-center gap-1.5 hover:text-accent-ink">
                  <Mail className="size-3.5 text-neutral-400" aria-hidden />
                  {m.email}
                </a>
              ) : (
                <span className="text-neutral-400">Not set</span>
              )}
            </dd>
          </div>
          {m.employeeId ? <Fact label="Employee ID">{m.employeeId}</Fact> : null}
        </dl>
      </Section>

      <Section title="Seat" icon={MapPin} testId="member-detail-seat">
        <SeatLocator seatId={m.seatId} floorId={m.floorId} seat={m.seat} name={m.name} />
      </Section>

      <Section title={`Devices · ${m.devices.length}`} icon={Laptop} testId="member-detail-devices">
        {m.devices.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl ring-1 ring-line">
            {m.devices.map((d) => {
              const Icon = DEVICE_ICON[d.kind];
              return (
                <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="grid size-8 place-items-center rounded-lg bg-neutral-900/[0.04] text-neutral-500">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-neutral-900">{d.model}</span>
                    <span className="block text-xs text-neutral-500">{DEVICE_LABEL[d.kind]}</span>
                  </span>
                  <span className="tnum shrink-0 rounded-md bg-neutral-900/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-neutral-600">{d.assetTag}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-neutral-500">No devices assigned.</p>
        )}
      </Section>

      <Section title="History" icon={History} testId="member-detail-history">
        {data.history.length ? (
          <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-line">
            {data.history.map((h, i) => (
              <TimelineItem key={`${h.kind}-${h.refId ?? ""}-${h.at}-${i}`} item={h} />
            ))}
          </ol>
        ) : (
          <p className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-neutral-500">No history yet.</p>
        )}
      </Section>

      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-line px-6 py-4 text-xs text-neutral-500 max-sm:px-4" data-testid="member-detail-times">
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="size-3.5" aria-hidden />
          Created {nptTime(data.createdAt)}
        </span>
        <span>Updated {nptTime(data.updatedAt)}</span>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: MemberDetail["member"]["status"] }) {
  const tone = status === "active" ? "bg-emerald-500" : status === "resigned" ? "bg-red-500" : "bg-amber-500";
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-white px-2 text-[11px] font-medium text-neutral-700 ring-1 ring-inset ring-neutral-900/[0.08]" data-testid="member-detail-status">
      <span className={cn("size-1.5 rounded-full", tone)} />
      {MEMBER_STATUS_LABEL[status]}
    </span>
  );
}

function SeatLocator({ seatId, floorId, seat, name }: { seatId: string | null; floorId: string | null; seat: string | null; name: string }) {
  const floors = useFloors();
  const colors = useTeamColors();
  const teams = useTeamsById();
  const occ = useOccupancy();
  const floor = floors.find((f) => f.id === floorId);
  const mark = useMemo(() => (seatId ? new Set([seatId]) : null), [seatId]);
  if (!seat) return <p className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-neutral-500">No seat assigned.</p>;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="tnum text-[15px] font-semibold text-neutral-900">{seatLabel(seat)}</span>
        <span className="text-[13px] text-neutral-500">{floor ? floor.name : "Floor not published"}</span>
      </div>
      {floor && mark ? (
        <FloorCanvas
          label={`${name}'s seat on ${floor.name}`}
          cols={floor.cols}
          rows={floor.rows}
          elements={floor.elements}
          colors={colors}
          teamName={(id) => teams[id]?.name ?? "Another team"}
          occupant={(sid) => occ.get(sid)}
          selected={mark}
          highlight={mark}
          maxHeight="240px"
          testId="member-detail-floor"
          noHoverCard
        />
      ) : null}
    </div>
  );
}

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  created: UserPlus,
  updated: PencilLine,
  desk: Armchair,
  team: Building2,
  transfer: ArrowLeftRight,
  exit: UserX,
  request: LifeBuoy,
};

const STATUS_TEXT: Record<string, string> = {
  requested: "Requested",
  acknowledged: "Acknowledged",
  in_progress: "In progress",
  completed: "Completed",
  done: "Done",
  open: "Open",
  rejected: "Rejected",
  cancelled: "Cancelled",
};
const statusText = (s: string) => STATUS_TEXT[s] ?? s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function TimelineItem({ item }: { item: MemberHistoryItem }) {
  const Icon = KIND_ICON[item.kind] ?? History;
  return (
    <li className="relative flex gap-3 pl-0" data-testid="member-history-item" data-kind={item.kind}>
      <span className="relative z-[1] grid size-6 shrink-0 place-items-center rounded-full bg-white text-neutral-500 ring-1 ring-line">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium text-neutral-900">{item.title}</span>
          {item.ticket ? <span className="tnum rounded-md bg-accent-soft px-1.5 py-px font-mono text-[11px] text-accent-ink ring-1 ring-inset ring-accent-line">{item.ticket}</span> : null}
          {item.status ? <span className="rounded-full bg-neutral-900/[0.05] px-2 py-px text-[11px] text-neutral-600">{statusText(item.status)}</span> : null}
        </div>
        {item.detail ? <p className="mt-0.5 text-[13px] text-neutral-600">{item.detail}</p> : null}
        <p className="mt-0.5 text-xs text-neutral-400">
          {nptTime(item.at)}
          {item.actor ? ` · ${item.actor}` : ""}
        </p>
        {item.acknowledgedBy ? (
          <p className="mt-1 text-xs text-emerald-700">
            Seen by IT · {item.acknowledgedBy}
            {item.acknowledgedAt ? ` · ${nptTime(item.acknowledgedAt)}` : ""}
          </p>
        ) : null}
      </div>
    </li>
  );
}
