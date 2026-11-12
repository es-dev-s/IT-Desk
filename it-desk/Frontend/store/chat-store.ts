"use client";

import { create } from "zustand";
import { chatApi, type ChatUnread } from "@/lib/chat";

/** Nav badge state for Messages. The page and the background sync both feed it. */
type ChatState = {
  unread: ChatUnread | null;
  setUnread: (u: ChatUnread) => void;
  refresh: () => Promise<void>;
};

let inflight: Promise<void> | null = null;

export const useChat = create<ChatState>((set) => ({
  unread: null,
  setUnread: (u) => set({ unread: u }),
  refresh: () =>
    (inflight ??= chatApi
      .unread()
      .then((u) => set({ unread: u }))
      .catch(() => {})
      .finally(() => {
        inflight = null;
      })),
}));
