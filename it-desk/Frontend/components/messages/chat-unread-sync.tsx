"use client";

import { useEffect } from "react";
import { useChat } from "@/store/chat-store";

/** Keeps direct and request unread badges fresh while the app is open. */
export function ChatUnreadSync() {
  const refresh = useChat((s) => s.refresh);
  useEffect(() => {
    void refresh();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const id = window.setInterval(tick, 20_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [refresh]);
  return null;
}
