"use client";

import { create } from "zustand";
import type { LiveStatus } from "@/lib/realtime";
import { notificationsApi, type AppNotification, type ReadResult } from "@/lib/notifications";

/**
 * The bell: newest-first notifications for the signed-in user, the unread
 * count, and the live connection status. Fed by GET /notifications on start
 * and by the SSE stream afterwards; every id is applied once (dedupe), so a
 * replay after reconnect or a duplicate frame is harmless.
 *
 * `ticks` is a per-entity counter bumped by live events; open sheets watch
 * their entity's tick and refetch, so they update without polling.
 */
type NotificationsState = {
  userId: string | null;
  items: AppNotification[];
  unread: number;
  loaded: boolean;
  loading: boolean;
  nextBefore: number | null;
  status: LiveStatus;
  /** When the stream last went live (ms); drives "Live" vs "Reconnecting…". */
  liveSince: number | null;
  ticks: Record<string, number>;

  load: (userId: string) => Promise<void>;
  loadMore: () => Promise<void>;
  /** Apply a live notification. Returns false when it was already known. */
  receive: (n: AppNotification) => boolean;
  applyRead: (r: ReadResult) => void;
  setUnread: (n: number) => void;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<boolean>;
  setStatus: (s: LiveStatus) => void;
  bump: (entityId: string) => void;
  reset: () => void;
};

const MAX_ITEMS = 100;
const seen = new Set<number>();

const sortDesc = (a: AppNotification, b: AppNotification) => b.id - a.id;

export const useNotifications = create<NotificationsState>()((set, get) => ({
  userId: null,
  items: [],
  unread: 0,
  loaded: false,
  loading: false,
  nextBefore: null,
  status: "idle",
  liveSince: null,
  ticks: {},

  load: async (userId) => {
    if (get().userId !== userId) {
      seen.clear();
      set({ userId, items: [], unread: 0, loaded: false, nextBefore: null });
    }
    set({ loading: true });
    try {
      const page = await notificationsApi.list({ limit: 30 });
      if (get().userId !== userId) return;
      set((cur) => {
        // Keep live items newer than the page (they may have raced the fetch).
        const byId = new Map<number, AppNotification>();
        for (const n of page.items) byId.set(n.id, n);
        for (const n of cur.items) if (!byId.has(n.id) && n.id > (page.items[0]?.id ?? 0)) byId.set(n.id, n);
        const items = [...byId.values()].sort(sortDesc).slice(0, MAX_ITEMS);
        for (const n of items) seen.add(n.id);
        return { items, unread: page.unread, nextBefore: page.nextBefore, loaded: true };
      });
    } catch {
      set({ loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  loadMore: async () => {
    const before = get().nextBefore;
    if (!before || get().loading) return;
    set({ loading: true });
    try {
      const page = await notificationsApi.list({ before, limit: 30 });
      set((cur) => {
        const fresh = page.items.filter((n) => !seen.has(n.id));
        for (const n of fresh) seen.add(n.id);
        return { items: [...cur.items, ...fresh].sort(sortDesc), nextBefore: page.nextBefore };
      });
    } finally {
      set({ loading: false });
    }
  },

  receive: (n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    set((cur) => ({
      items: [n, ...cur.items].sort(sortDesc).slice(0, MAX_ITEMS),
      unread: n.readAt ? cur.unread : cur.unread + 1,
    }));
    return true;
  },

  applyRead: (r) =>
    set((cur) => {
      const now = new Date().toISOString();
      const ids = new Set(r.ids ?? []);
      return {
        unread: r.unread,
        items: cur.items.map((n) => (!n.readAt && (r.all || ids.has(n.id)) ? { ...n, readAt: now } : n)),
      };
    }),

  setUnread: (unread) => set({ unread }),

  markRead: async (id) => {
    const target = get().items.find((n) => n.id === id);
    if (!target || target.readAt) return;
    const at = new Date().toISOString();
    set((cur) => ({ items: cur.items.map((n) => (n.id === id ? { ...n, readAt: at } : n)), unread: Math.max(0, cur.unread - 1) }));
    try {
      const r = await notificationsApi.read(id);
      set({ unread: r.unread });
    } catch {
      set((cur) => ({ items: cur.items.map((n) => (n.id === id ? { ...n, readAt: null } : n)), unread: cur.unread + 1 }));
    }
  },

  markAllRead: async () => {
    const before = get().items;
    const unreadBefore = get().unread;
    const at = new Date().toISOString();
    set((cur) => ({ items: cur.items.map((n) => (n.readAt ? n : { ...n, readAt: at })), unread: 0 }));
    try {
      const r = await notificationsApi.readAll();
      set({ unread: r.unread });
      return true;
    } catch {
      set({ items: before, unread: unreadBefore });
      return false;
    }
  },

  setStatus: (status) => set((cur) => ({ status, liveSince: status === "live" ? (cur.status === "live" ? cur.liveSince : Date.now()) : cur.liveSince })),

  bump: (entityId) => set((cur) => ({ ticks: { ...cur.ticks, [entityId]: (cur.ticks[entityId] ?? 0) + 1 } })),

  reset: () => {
    seen.clear();
    set({ userId: null, items: [], unread: 0, loaded: false, loading: false, nextBefore: null, status: "idle", liveSince: null, ticks: {} });
  },
}));
