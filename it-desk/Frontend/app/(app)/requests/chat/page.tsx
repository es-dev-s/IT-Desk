import type { Metadata } from "next";
import { Suspense } from "react";
import { RequirePermission } from "@/components/auth/forbidden";
import { MessagesView } from "@/components/messages/messages-view";

export const instant = false;

export const metadata: Metadata = { title: "Request chats" };

export default function RequestChatsPage() {
  return (
    <RequirePermission permission="requests.comment">
      <Suspense fallback={null}>
        <MessagesView requestChats />
      </Suspense>
    </RequirePermission>
  );
}
