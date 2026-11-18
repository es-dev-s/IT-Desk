"use client";

import { create } from "zustand";
import { chatApi, directChatApi, type ChatUnread } from "@/lib/chat";

/** Nav badge state for Messages. The page and the background sync both feed it. */
type ChatState = {
  requestUnread: ChatUnread | null;
  directUnread: ChatUnread | null;
  setUnread: (u: ChatUnread, direct: boolean) => void;
  refresh: () => Promise<void>;
};

let inflight: Promise<void> | null = null;

export const useChat = create<ChatState>((set) => ({
  requestUnread: null,
  directUnread: null,
  setUnread: (u, direct) => set(direct ? { directUnread: u } : { requestUnread: u }),
  refresh: () =>
    (inflight ??= Promise.allSettled([
      chatApi.unread().then((u) => set({ requestUnread: u })),
      directChatApi.unread().then((u) => set({ directUnread: u })),
    ]).then(() => {
      inflight = null;
    })),
}));
