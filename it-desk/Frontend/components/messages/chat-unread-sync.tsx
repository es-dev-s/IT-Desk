"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useChat } from "@/store/chat-store";

/** Keeps the Messages nav badge fresh: every 20s while visible, and on focus. The Messages page polls faster itself. */
export function ChatUnreadSync() {
  const refresh = useChat((s) => s.refresh);
  const onMessages = usePathname() === "/messages";
  useEffect(() => {
    if (onMessages) return;
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
  }, [refresh, onMessages]);
  return null;
}
