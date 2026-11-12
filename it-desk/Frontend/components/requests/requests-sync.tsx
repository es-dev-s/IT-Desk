"use client";

import { useEffect } from "react";
import { useRequests } from "@/store/requests-store";
import { useSession } from "@/components/auth/session-provider";

const REFRESH_MS = 45_000;

/** Keeps the requests cache (list, counts, sidebar badge) fresh: on mount, on focus/online and every 45s while visible. */
export function RequestsSync() {
  const { session, can } = useSession();
  const userId = session.user.id;
  const enabled = can("requests.view");

  useEffect(() => {
    const { load, reset } = useRequests.getState();
    if (!enabled) {
      reset();
      return;
    }
    void load(userId);
    const refresh = () => {
      if (document.visibilityState === "visible") void useRequests.getState().load(userId, { silent: true });
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [enabled, userId]);

  return null;
}
