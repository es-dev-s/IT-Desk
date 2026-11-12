"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { BellRing, Eye } from "lucide-react";
import { toast } from "sonner";
import { playChime, unlockAudioOnGesture } from "@/lib/chime";
import { emitLive } from "@/lib/live-bus";
import { LiveConnection } from "@/lib/realtime";
import {
  entityChangeSchema,
  isNewWork,
  isSeen,
  notificationSchema,
  readResultSchema,
  readyEventSchema,
  type AppNotification,
} from "@/lib/notifications";
import { useNotifications } from "@/store/notifications-store";
import { useRequests } from "@/store/requests-store";
import { useUI } from "@/store/ui-store";
import { useWorkspace, useWorkspaceApi } from "@/store/workspace-provider";
import { useSession } from "@/components/auth/session-provider";

/** Open what a notification is about (and mark it read). Shared by toasts and the bell. */
export async function openNotification(
  n: AppNotification,
  refreshTransfers: () => Promise<void>,
  hasTransfer: (id: string) => boolean,
  navigate?: (href: string) => void,
) {
  void useNotifications.getState().markRead(n.id);
  if (n.entityType === "it_request") {
    useRequests.getState().openDetail(n.entityId);
    return;
  }
  if (n.entityType === "floor") {
    // Floors live on their own page; a soft navigation keeps the live connection.
    const href = `/floors?floor=${encodeURIComponent(n.entityId)}`;
    navigate?.(href);
    return;
  }
  if (!hasTransfer(n.entityId)) await refreshTransfers();
  useUI.getState().openDetail(n.entityId);
}

const NEW_WORK_TOAST = "!shadow-[inset_3px_0_0_var(--color-accent),0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-6px_rgb(0_0_0/0.12)]";
const SEEN_TOAST = "!shadow-[inset_3px_0_0_var(--color-emerald-500),0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-6px_rgb(0_0_0/0.12)]";

const TITLE_PREFIX = /^\(\d+\+?\)\s/;

/**
 * Owns the one live connection for this tab and routes its events:
 * notifications → bell + toast (+ optional chime), entity changes → a
 * debounced refresh of the affected cache, read → bell sync. Also keeps the
 * unread count in the tab title.
 */
export function RealtimeSync() {
  const { session, can, refresh: refreshSession } = useSession();
  const userId = session.user.id;
  const roleKey = `${session.user.role}:${session.user.teamId ?? ""}`;
  const api = useWorkspaceApi();
  const liveSound = useWorkspace((s) => Boolean(s.notifications.liveSound));
  const canSeeRequests = can("requests.view");
  const soundRef = useRef(liveSound);
  const requestsRef = useRef(canSeeRequests);
  const refreshSessionRef = useRef(refreshSession);
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
    soundRef.current = liveSound;
    requestsRef.current = canSeeRequests;
    refreshSessionRef.current = refreshSession;
  }, [router, liveSound, canSeeRequests, refreshSession]);

  useEffect(() => unlockAudioOnGesture(), []);

  useEffect(() => {
    const store = useNotifications.getState();
    void store.load(userId);

    let transfersTimer: ReturnType<typeof setTimeout> | null = null;
    let requestsTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshTransfers = () => {
      if (transfersTimer) clearTimeout(transfersTimer);
      transfersTimer = setTimeout(() => void api.getState().refresh(), 200);
    };
    const refreshRequests = () => {
      if (!requestsRef.current) return;
      if (requestsTimer) clearTimeout(requestsTimer);
      requestsTimer = setTimeout(() => void useRequests.getState().load(userId, { silent: true }), 200);
    };
    const open = (n: AppNotification) =>
      void openNotification(
        n,
        () => api.getState().refresh(),
        (id) => Boolean(api.getState().transfers[id]),
        (href) => routerRef.current.push(href),
      );

    // Frames before "ready" on each connection are replays: into the bell, but no toast.
    let live = false;
    const conn = new LiveConnection({
      onStatus: (s) => {
        if (s !== "live") live = false;
        useNotifications.getState().setStatus(s);
      },
      onEvent: (type, data) => {
        const ns = useNotifications.getState();
        switch (type) {
          case "ready": {
            const r = readyEventSchema.safeParse(data);
            if (!r.success) return;
            live = true;
            ns.setUnread(r.data.unread);
            if (r.data.resync) {
              // We were away: anything may have changed. Refetch once.
              void ns.load(userId);
              refreshTransfers();
              refreshRequests();
            }
            return;
          }
          case "notification": {
            const r = notificationSchema.safeParse(data);
            if (!r.success) return;
            const n = r.data;
            if (!ns.receive(n)) return;
            ns.bump(n.entityId);
            if (n.entityType === "transfer" || n.entityType === "floor") refreshTransfers();
            else refreshRequests();
            if (!live) return;
            const opts = { id: `n-${n.id}`, description: n.body, action: { label: "View", onClick: () => open(n) } };
            if (isNewWork(n.kind)) {
              toast(n.title, {
                ...opts,
                duration: 9000,
                icon: <BellRing className="size-4 text-accent" aria-hidden />,
                classNames: { toast: NEW_WORK_TOAST, actionButton: "!bg-accent hover:!bg-accent-hover" },
              });
              if (soundRef.current) playChime(n.id);
            } else if (isSeen(n.kind)) {
              toast(n.title, { ...opts, duration: 7000, icon: <Eye className="size-4 text-emerald-600" aria-hidden />, classNames: { toast: SEEN_TOAST } });
              if (soundRef.current) playChime(n.id);
            } else {
              toast(n.title, { ...opts, duration: 5000 });
            }
            return;
          }
          case "entity": {
            const r = entityChangeSchema.safeParse(data);
            if (!r.success) return;
            const ch = r.data;
            ns.bump(ch.id);
            // Members, seats, team leads and transfers all live in the workspace snapshot.
            if (ch.entity === "it_request") refreshRequests();
            else refreshTransfers();
            emitLive(ch.entity, ch.change, ch.id);
            return;
          }
          case "read": {
            const r = readResultSchema.safeParse(data);
            if (r.success) ns.applyRead(r.data);
            return;
          }
          case "session":
            // Session ended (expired, revoked, signed out elsewhere): let the session layer route it.
            conn.stop();
            void refreshSessionRef.current();
            return;
          case "reconnect": {
            // Role, team or password state changed: pick up the new session (and its
            // permissions) before reconnecting with the new scope.
            const reason = data && typeof data === "object" && "reason" in data ? String((data as { reason: unknown }).reason) : "";
            if (reason === "session_changed") {
              void refreshSessionRef.current().finally(() => {
                refreshTransfers();
                refreshRequests();
              });
            }
            conn.reconnect(500);
            return;
          }
        }
      },
    });
    conn.start();
    return () => {
      conn.stop();
      if (transfersTimer) clearTimeout(transfersTimer);
      if (requestsTimer) clearTimeout(requestsTimer);
    };
  }, [userId, roleKey, api]);

  useEffect(() => () => useNotifications.getState().reset(), [userId]);

  // Unread count in the tab title; Next rewrites the title on navigation, so re-apply.
  const unread = useNotifications((s) => s.unread);
  const pathname = usePathname();
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(TITLE_PREFIX, "");
      const next = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    const t = setTimeout(apply, 50);
    const el = document.querySelector("title");
    const mo = el ? new MutationObserver(apply) : null;
    if (el && mo) mo.observe(el, { childList: true, characterData: true, subtree: true });
    return () => {
      clearTimeout(t);
      mo?.disconnect();
    };
  }, [unread, pathname]);

  return null;
}
