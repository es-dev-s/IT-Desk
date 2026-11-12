"use client";

import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { useSession } from "@/components/auth/session-provider";
import { createWorkspaceStore, type WorkspaceStore, type WorkspaceStoreApi } from "./workspace-store";

const WorkspaceStoreContext = createContext<WorkspaceStoreApi | null>(null);

/** Background resync cadence while the tab is visible. */
const REFRESH_INTERVAL_MS = 30_000;
/** On focus, resync if the last snapshot is older than this. */
const STALE_AFTER_MS = 10_000;

/**
 * One store per React tree (never a module singleton on the server). The
 * workspace is fetched from the API after mount; the server-rendered HTML is
 * the loading skeleton, so there is nothing to mismatch during hydration.
 */
export function WorkspaceStoreProvider({ children }: { children: ReactNode }) {
  const { permissions } = useSession().session;
  const [store] = useState(() => createWorkspaceStore({ permissions }));

  // The session's permissions also gate the store's actions (defence in depth).
  useEffect(() => {
    store.getState().setPermissions(permissions);
  }, [store, permissions]);

  useEffect(() => {
    const state = () => store.getState();
    void state().load();

    const stale = () => {
      const last = state().lastSyncedAt;
      return last === null || Date.now() - last > STALE_AFTER_MS;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && stale()) void state().refresh();
    };
    const onOnline = () => void state().refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void state().refresh();
    }, REFRESH_INTERVAL_MS);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [store]);

  return <WorkspaceStoreContext value={store}>{children}</WorkspaceStoreContext>;
}

export function useWorkspaceApi() {
  const store = use(WorkspaceStoreContext);
  if (!store) throw new Error("useWorkspace must be used inside <WorkspaceStoreProvider>");
  return store;
}

export function useWorkspace<T>(selector: (state: WorkspaceStore) => T): T {
  return useStore(useWorkspaceApi(), selector);
}
