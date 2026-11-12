"use client";

import { ArrowRight, CheckCheck, ClipboardList, Loader2, PanelRightOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { deviceCount } from "@/lib/analytics";
import { ACTIVITY_PAGE_SIZE } from "@/lib/constants";
import { formatDate, formatRelative, todayKey } from "@/lib/format";
import type { ItStatus, Transfer } from "@/lib/schemas";
import { cn, pluralize } from "@/lib/utils";
import { useTeamsById, useTransfers } from "@/store/selectors";
import { useWorkspaceApi } from "@/store/workspace-provider";
import { useUI } from "@/store/ui-store";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { DEVICE_ICON, DEVICE_LABEL, DirectionLabel, ItStatusLabel, IT_STATUS_LABEL } from "@/components/ui/status";
import { NEXT_LABEL } from "@/components/transfers/transfer-detail-sheet";
import { ItQueueSwitch } from "@/components/requests/it-queue-switch";
import { route } from "@/components/transfers/transfer-table";
import { NewDot, TransferAck, transferIsNew } from "@/components/realtime/ack";
import { seatLabel } from "@/lib/floors";

type Stage = "open" | ItStatus;
const STAGES: { value: Stage; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "requested", label: IT_STATUS_LABEL.requested },
  { value: "scheduled", label: IT_STATUS_LABEL.scheduled },
  { value: "moved", label: IT_STATUS_LABEL.moved },
  { value: "completed", label: IT_STATUS_LABEL.completed },
];

/* ---------------------------------------------------------------------------
 * Device checklist: per transfer, kept on this device so a half-done move
 * survives a reload. Only gates "Mark devices moved"; the server is the
 * source of truth for status.
 * ------------------------------------------------------------------------- */
const CHECK_KEY = "itdesk.queue.checklist.v1";
type Checklist = Record<string, string[]>;

function readChecklist(): Checklist {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CHECK_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Checklist = {};
    for (const [k, v] of Object.entries(parsed)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    return out;
  } catch {
    return {};
  }
}

function writeChecklist(value: Checklist) {
  try {
    window.localStorage.setItem(CHECK_KEY, JSON.stringify(value));
  } catch {
    /* storage full or disabled: the checklist just won't persist */
  }
}

const deviceKey = (memberId: string, deviceId: string) => `${memberId}:${deviceId}`;
const allDeviceKeys = (t: Transfer) => t.moves.flatMap((m) => m.devices.map((d) => deviceKey(m.memberId, d.id)));

export function QueueView() {
  const transfers = useTransfers();
  const teams = useTeamsById();
  const api = useWorkspaceApi();
  const openDetail = useUI((s) => s.openDetail);
  const [stage, setStage] = useState<Stage>("open");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(ACTIVITY_PAGE_SIZE);
  const [checklist, setChecklist] = useState<Checklist>(readChecklist);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const counts = useMemo(() => {
    const c: Record<Stage, number> = { open: 0, requested: 0, scheduled: 0, moved: 0, completed: 0 };
    for (const t of transfers) {
      c[t.itStatus] += 1;
      if (t.itStatus !== "completed") c.open += 1;
    }
    return c;
  }, [transfers]);

  const today = todayKey();
  const overdue = useMemo(
    () => transfers.filter((t) => t.itStatus !== "completed" && t.effectiveDate < today).length,
    [transfers, today],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return transfers
      .filter((t) => (stage === "open" ? t.itStatus !== "completed" : t.itStatus === stage))
      .filter(
        (t) =>
          !q ||
          `${t.ticket} ${t.initiatedBy} ${t.moves.map((m) => `${m.memberName} ${m.fromSeat ?? ""} ${m.toSeat ?? ""} ${m.devices.map((d) => `${d.assetTag} ${d.model}`).join(" ")}`).join(" ")}`
            .toLowerCase()
            .includes(q),
      )
      .sort((a, b) =>
        stage === "completed"
          ? b.history[b.history.length - 1].at.localeCompare(a.history[a.history.length - 1].at)
          : a.effectiveDate.localeCompare(b.effectiveDate) || a.createdAt.localeCompare(b.createdAt),
      );
  }, [transfers, stage, query]);

  const toggle = (transferId: string, key: string, on: boolean) => {
    setChecklist((cur) => {
      const set = new Set(cur[transferId] ?? []);
      if (on) set.add(key);
      else set.delete(key);
      const next = { ...cur, [transferId]: [...set] };
      writeChecklist(next);
      return next;
    });
  };
  const setAll = (t: Transfer, on: boolean) => {
    setChecklist((cur) => {
      const next = { ...cur, [t.id]: on ? allDeviceKeys(t) : [] };
      writeChecklist(next);
      return next;
    });
  };

  const advance = async (t: Transfer) => {
    if (pending[t.id]) return;
    setPending((p) => ({ ...p, [t.id]: true }));
    const result = await api.getState().advanceItStatus(t.id);
    setPending((p) => {
      const next = { ...p };
      delete next[t.id];
      return next;
    });
    if (!result.ok) {
      toast.error(`${t.ticket}: couldn’t update`, { description: result.error });
      return;
    }
    toast.success(`${t.ticket} · ${IT_STATUS_LABEL[result.status]}`);
    if (result.status === "completed") {
      setChecklist((cur) => {
        if (!(t.id in cur)) return cur;
        const next = { ...cur };
        delete next[t.id];
        writeChecklist(next);
        return next;
      });
    }
  };

  return (
    <>
      <h1 className="sr-only">IT queue</h1>

      <div className="mb-5 flex items-center gap-3">
        <ItQueueSwitch value="transfers" />
        <p className="hidden text-[13px] text-neutral-500 md:block">Seat moves and the devices that go with them.</p>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["requested", "scheduled", "moved"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setStage(s); setVisible(ACTIVITY_PAGE_SIZE); }}
            className={cn(
              "rounded-card border bg-white px-4 py-3.5 text-left shadow-card outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/35",
              stage === s ? "border-accent-line ring-1 ring-accent-line" : "border-line",
            )}
          >
            <span className="text-xs font-medium text-neutral-500">{IT_STATUS_LABEL[s]}</span>
            <span className="tnum mt-1 block text-2xl font-semibold tracking-[-0.03em] text-neutral-900">{counts[s]}</span>
          </button>
        ))}
        <div className={cn("rounded-card border px-4 py-3.5 shadow-card", overdue ? "border-amber-200 bg-amber-50" : "border-line bg-white")}>
          <span className={cn("text-xs font-medium", overdue ? "text-amber-800" : "text-neutral-500")}>Past effective date</span>
          <span className={cn("tnum mt-1 block text-2xl font-semibold tracking-[-0.03em]", overdue ? "text-amber-900" : "text-neutral-900")}>{overdue}</span>
        </div>
      </div>

      <div role="group" aria-label="Queue tools" className="mb-4 flex flex-wrap items-center gap-2">
        <SearchField
          size="md"
          className="min-w-[220px] flex-1 sm:max-w-80"
          value={query}
          onChange={(v) => { setQuery(v); setVisible(ACTIVITY_PAGE_SIZE); }}
          label="Search the queue"
          placeholder="Ticket, person, seat or asset tag"
        />
        <Segmented
          size="md"
          collapseLabels={false}
          className="relative max-w-full overflow-x-auto lg:ml-auto"
          label="Stage"
          value={stage}
          onChange={(s) => { setStage(s); setVisible(ACTIVITY_PAGE_SIZE); }}
          options={STAGES.map((s) => ({ ...s, count: counts[s.value] }))}
        />
      </div>

      {rows.length ? (
        <ul className="space-y-3" data-testid="queue-list">
          {rows.slice(0, visible).map((t) => {
            const keys = allDeviceKeys(t);
            const done = new Set(checklist[t.id] ?? []);
            const ticked = keys.filter((k) => done.has(k)).length;
            const needsChecklist = t.itStatus === "scheduled" && keys.length > 0;
            const blocked = needsChecklist && ticked < keys.length;
            const late = t.itStatus !== "completed" && t.effectiveDate < today;
            const next = NEXT_LABEL[t.itStatus];
            const busy = Boolean(pending[t.id]);
            return (
              <li key={t.id}>
                <Card className="overflow-hidden" aria-label={`${t.ticket}, ${IT_STATUS_LABEL[t.itStatus]}`} data-testid="queue-item">
                  <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3.5">
                    {transferIsNew(t) ? <NewDot /> : null}
                    <span className="font-mono text-[13px] font-semibold text-neutral-900">{t.ticket}</span>
                    <DirectionLabel direction={t.direction} />
                    <span className="min-w-0 truncate text-[13px] text-neutral-500">{route(t, teams)}</span>
                    <span className="ml-auto flex items-center gap-3">
                      <span className={cn("tnum text-xs", late ? "font-medium text-amber-700" : "text-neutral-500")}>
                        {late ? "Due " : ""}
                        {formatDate(t.effectiveDate)}
                        {t.itStatus !== "completed" ? ` · ${formatRelative(t.effectiveDate)}` : ""}
                      </span>
                      <ItStatusLabel status={t.itStatus} />
                    </span>
                  </header>

                  <div className="grid gap-x-8 gap-y-4 px-5 py-4 md:grid-cols-2">
                    {t.moves.map((m) => (
                      <section key={m.memberId} className="min-w-0">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={m.memberName} size="xs" />
                          <span className="truncate text-[13px] font-medium text-neutral-900">{m.memberName}</span>
                          <span className="tnum ml-auto shrink-0 text-xs text-neutral-500">
                            {seatLabel(m.fromSeat)} → {seatLabel(m.toSeat)}
                          </span>
                        </div>
                        {m.devices.length ? (
                          <ul className="mt-2.5 space-y-1.5 pl-[34px]">
                            {m.devices.map((d) => {
                              const Icon = DEVICE_ICON[d.kind];
                              const key = deviceKey(m.memberId, d.id);
                              const on = done.has(key) || t.itStatus === "moved" || t.itStatus === "completed";
                              const editable = t.itStatus === "scheduled" || t.itStatus === "requested";
                              return (
                                <li key={d.id} className="flex items-center gap-2.5 text-[13px]">
                                  {editable ? (
                                    <Checkbox
                                      checked={on}
                                      onCheckedChange={(v) => toggle(t.id, key, v)}
                                      label={`${DEVICE_LABEL[d.kind]} ${d.assetTag} moved`}
                                    />
                                  ) : (
                                    <span className="grid size-[18px] place-items-center rounded-[5px] bg-emerald-50 text-emerald-600">
                                      <CheckCheck className="size-3" aria-hidden />
                                    </span>
                                  )}
                                  <Icon className="size-4 text-neutral-400" aria-hidden />
                                  <span className={cn("min-w-0 truncate", on ? "text-neutral-400 line-through decoration-neutral-300" : "text-neutral-700")}>
                                    {d.model}
                                  </span>
                                  <span className="ml-auto shrink-0 font-mono text-[11px] text-neutral-400">{d.assetTag}</span>
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <p className="mt-2 pl-[34px] text-xs text-neutral-400">No devices to move</p>
                        )}
                      </section>
                    ))}
                  </div>

                  <footer className="flex flex-wrap items-center gap-3 border-t border-line bg-subtle/60 px-5 py-3">
                    {keys.length ? (
                      <div className="flex items-center gap-2.5">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
                          <div
                            className="h-full rounded-full bg-accent transition-[width] duration-300"
                            style={{ width: `${t.itStatus === "moved" || t.itStatus === "completed" ? 100 : (ticked / keys.length) * 100}%` }}
                          />
                        </div>
                        <span className="tnum text-xs text-neutral-500">
                          {t.itStatus === "moved" || t.itStatus === "completed" ? keys.length : ticked}/{pluralize(keys.length, "device")}
                        </span>
                        {(t.itStatus === "scheduled" || t.itStatus === "requested") && keys.length > 1 ? (
                          <button
                            type="button"
                            className="text-xs font-medium text-accent-ink hover:underline"
                            onClick={() => setAll(t, ticked < keys.length)}
                          >
                            {ticked < keys.length ? "Tick all" : "Clear"}
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs text-neutral-500">Seat change only</span>
                    )}
                    <span className="hidden text-xs text-neutral-400 sm:inline">· Requested by {t.initiatedBy}</span>
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                      <TransferAck transfer={t} compact />
                      <Button size="sm" variant="ghost" onClick={() => openDetail(t.id)}>
                        <PanelRightOpen aria-hidden />
                        Details
                      </Button>
                      {next ? (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy || blocked}
                          title={blocked ? "Tick every device first" : undefined}
                          onClick={() => void advance(t)}
                          data-testid="advance"
                        >
                          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowRight aria-hidden />}
                          {next}
                        </Button>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                          <CheckCheck className="size-4" aria-hidden />
                          Done
                        </span>
                      )}
                    </div>
                    {blocked ? (
                      <p className="basis-full text-right text-xs text-neutral-500">
                        Tick each device as it reaches the new desk ({keys.length - ticked} left).
                      </p>
                    ) : null}
                  </footer>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title={query ? "Nothing matches that search" : stage === "open" ? "The queue is clear" : `Nothing ${IT_STATUS_LABEL[stage as ItStatus].toLowerCase()}`}
            description={
              query
                ? "Try a ticket number, a name or an asset tag."
                : stage === "open"
                  ? "New transfers from team leads show up here."
                  : "Pick another stage to see more."
            }
          />
        </Card>
      )}

      {rows.length > visible ? (
        <div className="mt-4 flex items-center justify-between">
          <p className="tnum text-xs text-neutral-500">
            {visible} of {rows.length} · {pluralize(rows.reduce((n, t) => n + deviceCount(t), 0), "device")} in view
          </p>
          <Button size="sm" onClick={() => setVisible((v) => v + ACTIVITY_PAGE_SIZE)}>
            Show more
          </Button>
        </div>
      ) : null}
    </>
  );
}
