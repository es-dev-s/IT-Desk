"use client";

import * as Popover from "@radix-ui/react-popover";
import { ArrowRightLeft, Bell, BellOff, CheckCheck, Eye, Inbox, Loader2, MessageSquare, PackagePlus, RefreshCw, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { dayKey, formatDateTime, formatTimeAgo, todayKey } from "@/lib/format";
import type { AppNotification } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/store/notifications-store";
import { useWorkspaceApi } from "@/store/workspace-provider";
import { openNotification } from "./realtime-sync";

const KIND_ICON: Record<string, { icon: React.ComponentType<{ className?: string }>; className: string }> = {
  "transfer.created": { icon: ArrowRightLeft, className: "bg-accent-soft text-accent-ink" },
  "request.created": { icon: PackagePlus, className: "bg-accent-soft text-accent-ink" },
  "transfer.acknowledged": { icon: Eye, className: "bg-emerald-50 text-emerald-700" },
  "request.acknowledged": { icon: Eye, className: "bg-emerald-50 text-emerald-700" },
  "request.comment": { icon: MessageSquare, className: "bg-sky-50 text-sky-700" },
};
const DEFAULT_ICON = { icon: Workflow, className: "bg-neutral-100 text-neutral-600" };

/** Debounced connection status: only show "Reconnecting" if it lasts >3s (no flicker on blips). */
function useStableStatus() {
  const status = useNotifications((s) => s.status);
  const [shown, setShown] = useState(status);
  useEffect(() => {
    if (status === "live" || status === "idle" || status === "connecting") {
      const t = setTimeout(() => setShown(status), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setShown(status), 3000);
    return () => clearTimeout(t);
  }, [status]);
  return shown;
}

export function ConnectionIndicator({ className }: { className?: string }) {
  const status = useStableStatus();
  const meta =
    status === "live"
      ? { label: "Live", dot: "bg-emerald-500", text: "text-emerald-700", ping: true }
      : status === "offline"
        ? { label: "Offline", dot: "bg-neutral-400", text: "text-neutral-500", ping: false }
        : status === "reconnecting"
          ? { label: "Reconnecting…", dot: "bg-amber-500", text: "text-amber-700", ping: false }
          : { label: "Connecting…", dot: "bg-neutral-300", text: "text-neutral-500", ping: false };
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 text-[11px] font-medium", meta.text, className)} data-testid="live-status" data-status={status} aria-live="polite">
      <span className="relative grid size-2 place-items-center" aria-hidden>
        {meta.ping ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-40 [animation-duration:2.4s] motion-reduce:hidden" /> : null}
        <span className={cn("relative size-1.5 rounded-full", meta.dot)} />
      </span>
      {meta.label}
    </span>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unread = useNotifications((s) => s.unread);
  const status = useStableStatus();
  const degraded = status === "reconnecting" || status === "offline";
  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className={cn(
          "relative grid size-9 shrink-0 place-items-center rounded-lg text-neutral-600 outline-none transition-colors duration-150",
          "hover:bg-neutral-900/[0.04] hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-accent/35 data-[state=open]:bg-accent-soft data-[state=open]:text-accent-ink",
        )}
        data-testid="bell"
        data-status={status}
        title={degraded ? (status === "offline" ? "Offline — alerts paused" : "Reconnecting to live alerts…") : undefined}
      >
        {degraded ? <BellOff className="size-[18px]" aria-hidden /> : <Bell className="size-[18px]" aria-hidden />}
        <span
          aria-hidden
          data-testid="bell-badge"
          className={cn(
            "tnum absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10.5px] font-semibold leading-none text-white ring-2 ring-white transition-[transform,opacity] duration-200 ease-out",
            unread > 0 ? "scale-100 opacity-100" : "pointer-events-none scale-50 opacity-0",
          )}
        >
          {unread > 0 ? badge : ""}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-[60] flex max-h-[min(560px,calc(100dvh-80px))] w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl bg-white shadow-overlay outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in"
          data-testid="bell-popover"
        >
          <BellPanel onNavigate={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function BellPanel({ onNavigate }: { onNavigate: () => void }) {
  const items = useNotifications((s) => s.items);
  const unread = useNotifications((s) => s.unread);
  const loaded = useNotifications((s) => s.loaded);
  const loading = useNotifications((s) => s.loading);
  const nextBefore = useNotifications((s) => s.nextBefore);
  const api = useWorkspaceApi();
  const router = useRouter();
  const [onlyUnread, setOnlyUnread] = useState(false);

  const groups = useMemo(() => {
    const today = todayKey();
    const list = onlyUnread ? items.filter((n) => !n.readAt) : items;
    const t: AppNotification[] = [];
    const e: AppNotification[] = [];
    for (const n of list) (dayKey(new Date(n.createdAt).getTime()) === today ? t : e).push(n);
    return [
      { label: "Today", items: t },
      { label: "Earlier", items: e },
    ].filter((g) => g.items.length);
  }, [items, onlyUnread]);

  const open = (n: AppNotification) => {
    onNavigate();
    void openNotification(
      n,
      () => api.getState().refresh(),
      (id) => Boolean(api.getState().transfers[id]),
      (href) => router.push(href),
    );
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-neutral-900">Notifications</p>
          <ConnectionIndicator />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex h-7 items-center rounded-lg bg-neutral-100 p-0.5 text-xs font-medium" role="group" aria-label="Show">
            {[
              { v: false, l: "All" },
              { v: true, l: "Unread" },
            ].map((o) => (
              <button
                key={o.l}
                type="button"
                aria-pressed={onlyUnread === o.v}
                onClick={() => setOnlyUnread(o.v)}
                className={cn(
                  "h-6 rounded-md px-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/35",
                  onlyUnread === o.v ? "bg-white text-neutral-900 shadow-xs" : "text-neutral-500 hover:text-neutral-800",
                )}
              >
                {o.l}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={unread === 0}
            onClick={async () => {
              if (!(await useNotifications.getState().markAllRead())) toast.error("Couldn’t mark notifications read");
            }}
            className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-accent-ink outline-none transition-colors hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-accent/35 disabled:pointer-events-none disabled:text-neutral-300"
            data-testid="bell-mark-all"
          >
            <CheckCheck className="size-3.5" aria-hidden />
            Mark all read
          </button>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="bell-list">
        {!loaded ? (
          <div className="grid h-40 place-items-center text-neutral-400">
            <Loader2 className="size-5 animate-spin" aria-hidden />
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <span className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent-ink">
              <Inbox className="size-5" aria-hidden />
            </span>
            <p className="mt-3 text-[13px] font-medium text-neutral-900">{onlyUnread ? "No unread notifications" : "You’re all caught up"}</p>
            <p className="mt-1 text-xs text-neutral-500">New transfers, requests and IT updates show up here instantly.</p>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.label} className="pb-1">
              <h3 className="sticky top-0 z-[1] bg-white/95 px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-neutral-400 backdrop-blur">{g.label}</h3>
              <ul className="px-1.5">
                {g.items.map((n) => (
                  <NotificationRow key={n.id} n={n} onOpen={() => open(n)} />
                ))}
              </ul>
            </section>
          ))
        )}
        {loaded && nextBefore && !onlyUnread ? (
          <div className="px-4 pb-3 pt-1">
            <button
              type="button"
              disabled={loading}
              onClick={() => void useNotifications.getState().loadMore()}
              className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-neutral-600 outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-accent/35"
            >
              {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
              Load older
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

function NotificationRow({ n, onOpen }: { n: AppNotification; onOpen: () => void }) {
  const meta = KIND_ICON[n.kind] ?? DEFAULT_ICON;
  const Icon = meta.icon;
  const unread = !n.readAt;
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-neutral-50 focus-visible:bg-accent-soft/60",
          unread && "bg-accent-soft/40 hover:bg-accent-soft/70",
        )}
        data-testid="bell-item"
        data-kind={n.kind}
        data-unread={unread ? "true" : "false"}
      >
        <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-full", meta.className)}>
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("line-clamp-2 text-[13px] leading-5", unread ? "font-semibold text-neutral-900" : "font-medium text-neutral-700")}>{n.title}</span>
          {n.body ? <span className="mt-0.5 line-clamp-2 text-xs leading-[18px] text-neutral-500">{n.body}</span> : null}
          <span className="tnum mt-1 block text-[11px] text-neutral-400" title={formatDateTime(n.createdAt)}>
            {n.ticket} · {formatTimeAgo(n.createdAt)}
          </span>
        </span>
        <span className={cn("mt-2 size-2 shrink-0 rounded-full transition-opacity", unread ? "bg-accent opacity-100" : "opacity-0")} aria-label={unread ? "Unread" : undefined} />
      </button>
      {unread ? (
        <button
          type="button"
          onClick={() => void useNotifications.getState().markRead(n.id)}
          className="absolute bottom-2 right-3 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-accent-ink opacity-0 outline-none transition-opacity hover:bg-white focus-visible:opacity-100 group-hover:opacity-100"
          data-testid="bell-mark-read"
        >
          Mark read
        </button>
      ) : null}
    </li>
  );
}
