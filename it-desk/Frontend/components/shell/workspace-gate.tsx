"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CloudOff, RotateCw } from "lucide-react";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Logo } from "./logo";

const subscribeOnline = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};
export const useOnline = () =>
  useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

/**
 * Renders the app only once the workspace snapshot is in memory. Until then:
 * a skeleton of the shell (same geometry, no layout shift) or, if the API is
 * unreachable, a recoverable error state that retries on its own.
 */
export function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const status = useWorkspace((s) => s.status);
  if (status === "ready") {
    return (
      <>
        {children}
        <SyncBanner />
      </>
    );
  }
  if (status === "error") return <LoadFailed />;
  return <ShellSkeleton />;
}

export function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh" aria-busy="true" aria-label="Loading your workspace">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-sidebar lg:block">
        <div className="flex h-14 items-center px-5">
          <Logo />
        </div>
        <div className="space-y-2 px-5 pb-6 pt-4">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="space-y-1.5 px-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full rounded-lg" />
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center gap-3 border-b border-line px-4 sm:px-6 lg:px-8 2xl:px-12">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto hidden h-8 w-64 rounded-lg md:block" />
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>
        <main className="flex-1 px-4 pb-16 pt-6 sm:px-6 lg:px-8 2xl:px-12">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-2xl" />
            ))}
          </div>
          <div className="mt-6 grid gap-4 xl:grid-cols-3">
            <Skeleton className="h-72 rounded-2xl xl:col-span-2" />
            <Skeleton className="h-72 rounded-2xl" />
          </div>
        </main>
      </div>
    </div>
  );
}

const RETRY_STEPS_S = [5, 10, 20, 30];
const retryDelayMs = (attempt: number) => RETRY_STEPS_S[Math.min(attempt, RETRY_STEPS_S.length - 1)] * 1000;

function LoadFailed() {
  const api = useWorkspaceApi();
  const error = useWorkspace((s) => s.loadError);
  const online = useOnline();
  const [retrying, setRetrying] = useState(false);
  const [deadline, setDeadline] = useState(() => Date.now() + retryDelayMs(0));
  const [now, setNow] = useState(() => Date.now());
  const attempt = useRef(0);
  const busy = useRef(false);
  const deadlineRef = useRef(deadline);
  useEffect(() => {
    deadlineRef.current = deadline;
  }, [deadline]);

  const retry = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRetrying(true);
    await api.getState().load(); // on success the gate swaps this screen for the app
    attempt.current += 1;
    busy.current = false;
    setRetrying(false);
    const t = Date.now();
    setNow(t);
    setDeadline(t + retryDelayMs(attempt.current)); // back off: 5s → 10s → 20s → 30s
  }, [api]);

  // Count down to an automatic retry; retry immediately when the network comes back.
  useEffect(() => {
    const tick = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (!busy.current && t >= deadlineRef.current) void retry();
    }, 1000);
    const onOnline = () => void retry();
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("online", onOnline);
    };
  }, [retry]);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));

  return (
    <div className="grid min-h-dvh place-items-center bg-subtle px-6">
      <div role="alert" className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.12)]">
        <span className="mx-auto grid size-11 place-items-center rounded-full bg-neutral-100 text-neutral-500">
          <CloudOff className="size-5" aria-hidden />
        </span>
        <h1 className="mt-5 text-base font-semibold text-neutral-900">
          {online ? "Can’t load your workspace" : "You’re offline"}
        </h1>
        <p className="mt-1.5 text-[13px] text-neutral-500">
          {online
            ? (error?.message ?? "The IT-Desk server didn’t respond.")
            : "Reconnect to the internet and we’ll pick up right where you left off."}
        </p>
        {error?.requestId ? (
          <p className="tnum mt-2 font-mono text-[11px] text-neutral-400">ref {error.requestId}</p>
        ) : null}
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button variant="dark" size="sm" onClick={() => void retry()} disabled={retrying}>
            <RotateCw aria-hidden className={retrying ? "animate-spin" : undefined} />
            {retrying ? "Retrying…" : "Try again"}
          </Button>
        </div>
        <p className="tnum mt-3 text-xs text-neutral-400" aria-live="polite">
          {retrying ? "Connecting…" : `Retrying automatically in ${seconds}s`}
        </p>
      </div>
    </div>
  );
}

/** Non-blocking notice while the app keeps working from its last snapshot. */
function SyncBanner() {
  const online = useOnline();
  const syncError = useWorkspace((s) => s.syncError);
  const api = useWorkspaceApi();
  if (online && !syncError) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-6 z-[80] mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-3 rounded-full bg-neutral-900 py-2 pl-4 pr-2 text-[13px] text-white shadow-pop"
    >
      <CloudOff className="size-4 shrink-0 text-neutral-400" aria-hidden />
      <span className="truncate">
        {online ? "Can’t reach the server — showing your last synced data." : "You’re offline — changes will fail until you reconnect."}
      </span>
      <button
        type="button"
        onClick={() => void api.getState().refresh()}
        className="h-7 shrink-0 rounded-full bg-white/10 px-3 text-xs font-medium outline-none transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/40"
      >
        Retry
      </button>
    </div>
  );
}
